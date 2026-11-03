// The Transition editor's work surface, laid out as rekordbox does: the two tracks' waveforms stacked
// on one beat ruler with numbered phrases, the Transition's span shaded across both. It zooms (pinch,
// Ctrl/⌘ + scroll, + and −, the slider) from the whole pair down to beats, and scrolls sideways.
// With "Edit moves" on, each lane draws under its track's waveform and its keyframes drag right there,
// snapped to beats; "Ghost moves" adds the derived controller moves as a row underneath.
//
// Only what is in view is drawn: the waveforms on one canvas the width of the screen, the phrase labels
// in view. Keyframes are buttons, so BROWSE and Tab reach them; arrows nudge by beat (Shift: by bar).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { WaveformOverview } from "@analysis";
import { BEATS_PER_BAR, BEATS_PER_PHRASE, beatIndexOf, CONTROL_RANGES, secondsAtBeat, type Lane, type PlanGrid, type Transition } from "@shared/mix-plan.ts";
import type { EditorAction } from "./editor-state.ts";
import { formatLaneValue, laneLabel, positionText, stepLabel } from "./editor-text.ts";
import type { ExecutionPlan } from "./execution-plan.ts";
import { laneTimeline, valueAt, valueBefore } from "./lanes.ts";
import {
  beatOfX,
  fitZoom,
  gridLineBeats,
  MAX_PX_PER_BEAT,
  pairSpan,
  phraseMarks,
  snapBeat,
  snapStep,
  transitionFocus,
  viewOf,
  xOfBeat,
  ZOOM_STEP,
  zoomAround,
  type BeatSpan,
} from "./timeline.ts";

const RULER_H = 26;
const WAVE_H = 64;
const LANE_H = 44;
const GHOST_H = 54;
const LANE_PAD = 6;
/** The slider's steps from the whole pair (0) to MAX_PX_PER_BEAT (ZOOM_SLIDER_STEPS). */
const ZOOM_SLIDER_STEPS = 100;

export interface Selection {
  readonly lane: number | null;
  readonly keyframe: number | null;
}

export interface TimelineTrack {
  readonly label: string;
  readonly grid: PlanGrid | null;
  readonly waveform: WaveformOverview | null;
}

export interface TimelineProps {
  readonly transitionIndex: number;
  readonly transition: Transition;
  readonly outgoing: TimelineTrack;
  readonly incoming: TimelineTrack;
  readonly editMoves: boolean;
  readonly ghostMoves: boolean;
  readonly execution: ExecutionPlan;
  readonly selection: Selection;
  /** Lanes the Learner asked to see the cause of (a shaded moment in the Execution strip). */
  readonly highlighted: readonly number[];
  readonly onSelect: (selection: Selection) => void;
  readonly dispatch: (action: EditorAction) => void;
  /** The Transition beat heard now while this Transition previews, or null. */
  readonly playhead: () => number | null;
}

interface Row {
  readonly kind: "ruler" | "wave" | "lane" | "ghost";
  readonly top: number;
  readonly height: number;
  readonly track?: Lane["track"];
  readonly lane?: number;
}

function layoutRows(transition: Transition, editMoves: boolean, ghostMoves: boolean): Row[] {
  const rows: Row[] = [];
  let top = 0;
  const push = (row: Omit<Row, "top">) => {
    rows.push({ ...row, top });
    top += row.height;
  };
  push({ kind: "ruler", height: RULER_H });
  for (const track of ["outgoing", "incoming"] as const) {
    push({ kind: "wave", height: WAVE_H, track });
    if (editMoves) {
      transition.lanes.forEach((lane, index) => {
        if (lane.track === track) push({ kind: "lane", height: LANE_H, track, lane: index });
      });
    }
  }
  if (ghostMoves) push({ kind: "ghost", height: GHOST_H });
  return rows;
}

const normalised = (lane: Lane, value: number) => {
  const range = CONTROL_RANGES[lane.param];
  return (value - range.min) / (range.max - range.min);
};
const valueOfY = (lane: Lane, y: number) => {
  const range = CONTROL_RANGES[lane.param];
  const fraction = 1 - Math.min(1, Math.max(0, (y - LANE_PAD) / (LANE_H - 2 * LANE_PAD)));
  return range.min + fraction * (range.max - range.min);
};
const yOfValue = (lane: Lane, value: number) => LANE_PAD + (1 - normalised(lane, value)) * (LANE_H - 2 * LANE_PAD);

/** How far one arrow press moves a value: a twentieth of the range, a whole BPM for tempo, a step for a loop. */
function valueStep(lane: Lane): number {
  if (lane.param === "loop") return 1;
  if (lane.param === "tempo") return 1;
  const range = CONTROL_RANGES[lane.param];
  return (range.max - range.min) / 20;
}

function cssColor(element: Element, name: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** The waveform overview's peak between two track times. */
function peakBetween(waveform: WaveformOverview, fromSec: number, toSec: number): { min: number; max: number } | null {
  const { bucketSec, min, max } = waveform;
  const first = Math.max(0, Math.floor(fromSec / bucketSec));
  const last = Math.min(min.length - 1, Math.max(first, Math.floor(toSec / bucketSec)));
  if (first > min.length - 1) return null;
  let low = 0;
  let high = 0;
  for (let index = first; index <= last; index += 1) {
    low = Math.min(low, min[index] ?? 0);
    high = Math.max(high, max[index] ?? 0);
  }
  return { min: low, max: high };
}

interface DrawInput {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly Row[];
  readonly span: BeatSpan;
  readonly pxPerBeat: number;
  readonly scrollPx: number;
  readonly transition: Transition;
  readonly outgoing: TimelineTrack;
  readonly incoming: TimelineTrack;
}

function draw(input: DrawInput): void {
  const { canvas, width, height, rows, span, pxPerBeat, scrollPx, transition } = input;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const colours = {
    out: cssColor(canvas, "--me-outgoing", "#3fb8ff"),
    in: cssColor(canvas, "--me-incoming", "#ffad33"),
    grid: cssColor(canvas, "--panel-edge", "#34363c"),
    dim: cssColor(canvas, "--ink-dim", "#9a9da6"),
    span: cssColor(canvas, "--me-span", "rgb(255 255 255 / 6%)"),
  };
  const beatAt = (x: number) => beatOfX(scrollPx + x, span, pxPerBeat);
  const xAt = (beat: number) => xOfBeat(beat, span, pxPerBeat) - scrollPx;

  // The Transition's span, across everything.
  context.fillStyle = colours.span;
  context.fillRect(xAt(0), RULER_H, Math.max(1, transition.lengthBeats * pxPerBeat), height - RULER_H);

  // Grid lines: beats, bars or phrases as the zoom allows; phrase starts always, brighter.
  const every = gridLineBeats(pxPerBeat);
  const offset = beatIndexOf(transition.outgoingAt);
  const firstLine = Math.ceil((beatAt(0) + offset) / every) * every - offset;
  for (let beat = firstLine; beat <= beatAt(width); beat += every) {
    const onGrid = beat + offset;
    const phrase = onGrid % BEATS_PER_PHRASE === 0;
    const bar = onGrid % BEATS_PER_BAR === 0;
    context.fillStyle = colours.grid;
    context.globalAlpha = phrase ? 1 : bar ? 0.6 : 0.3;
    context.fillRect(Math.round(xAt(beat)), phrase ? 0 : RULER_H / 2, 1, height);
  }
  context.globalAlpha = 1;

  for (const row of rows) {
    if (row.kind !== "wave" || row.track === undefined) continue;
    const track = row.track === "outgoing" ? input.outgoing : input.incoming;
    const { grid, waveform } = track;
    if (grid === null || waveform === null) continue;
    const startOnGrid = beatIndexOf(row.track === "outgoing" ? transition.outgoingAt : transition.incomingAt);
    const middle = row.top + row.height / 2;
    const half = row.height / 2 - 4;
    const colour = row.track === "outgoing" ? colours.out : colours.in;
    for (let x = 0; x < width; x += 1) {
      const beat = beatAt(x);
      const fromSec = secondsAtBeat(grid, startOnGrid + beat);
      const toSec = secondsAtBeat(grid, startOnGrid + beatAt(x + 1));
      if (toSec < 0 || fromSec > grid.durationSec) continue;
      const peak = peakBetween(waveform, Math.max(0, fromSec), toSec);
      if (peak === null) continue;
      // The incoming track is not playing before the Transition starts.
      context.globalAlpha = row.track === "incoming" && beat < 0 ? 0.3 : 0.9;
      context.fillStyle = colour;
      const top = middle - Math.min(1, peak.max) * half;
      context.fillRect(x, top, 1, Math.max(1, (Math.min(1, peak.max) - Math.max(-1, peak.min)) * half));
    }
    context.globalAlpha = 1;
  }
}

/** The lane's shape across the Transition as an SVG path, in lane-row pixels from the Transition's start. */
function lanePath(lane: Lane, transition: Transition, pxPerBeat: number): string {
  const timeline = laneTimeline(lane);
  if (timeline === null) return "";
  const beats = new Set<number>([0, transition.lengthBeats]);
  timeline.keyframes.forEach((keyframe, index) => {
    beats.add(Math.max(0, keyframe.beat));
    // An ease is drawn as its curve: eight samples across its ramp.
    const previous = timeline.keyframes[index - 1];
    if (keyframe.curve === "ease" && previous !== undefined) {
      for (let step = 1; step < 8; step += 1) beats.add(previous.beat + ((keyframe.beat - previous.beat) * step) / 8);
    }
  });
  const ordered = [...beats].filter((beat) => beat >= 0 && beat <= transition.lengthBeats).sort((a, b) => a - b);
  const points: string[] = [];
  const point = (beat: number, value: number) => `${(beat * pxPerBeat).toFixed(1)},${yOfValue(lane, value).toFixed(1)}`;
  for (const beat of ordered) {
    const at = valueAt(timeline.keyframes, beat) ?? 0;
    // A jump: along at the value before it, then straight up or down.
    const before = beat > 0 ? valueBefore(timeline.keyframes, beat) : null;
    if (before !== null && before !== at) points.push(point(beat, before));
    points.push(point(beat, at));
  }
  return points.length === 0 ? "" : `M${points.join(" L")}`;
}

export function Timeline(props: TimelineProps) {
  const { transition, transitionIndex, outgoing, incoming, editMoves, ghostMoves, execution, selection, highlighted, onSelect, dispatch, playhead } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const playheadLine = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [scrollPx, setScrollPx] = useState(0);
  const span = useMemo(() => pairSpan(transition, outgoing.grid, incoming.grid), [transition, outgoing.grid, incoming.grid]);
  const minPxPerBeat = useMemo(() => fitZoom(span, width), [span, width]);
  const [pxPerBeat, setPxPerBeat] = useState<number | null>(null);
  const zoom = Math.max(minPxPerBeat, pxPerBeat ?? minPxPerBeat);
  const pendingScroll = useRef<number | null>(null);
  const rows = useMemo(() => layoutRows(transition, editMoves, ghostMoves), [transition, editMoves, ghostMoves]);
  const height = rows.reduce((sum, row) => sum + row.height, 0);
  const totalPx = Math.max(width, (span.toBeat - span.fromBeat) * zoom);
  const drag = useRef<{ readonly lane: number; readonly keyframe: number; readonly pointer: number } | null>(null);

  // The width of the screen's part of the timeline.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, []);

  // A new Transition opens on itself with a phrase either side.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const view = viewOf(transitionFocus(transition), span, element.clientWidth, fitZoom(span, element.clientWidth));
    setPxPerBeat(view.pxPerBeat);
    pendingScroll.current = view.scrollPx;
    // Only on a new pair: edits keep the zoom and scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionIndex]);

  // Moving the Transition's start moves where beat 0 is: keep what is on screen where it was.
  const previousFrom = useRef(span.fromBeat);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && previousFrom.current !== span.fromBeat && pendingScroll.current === null) {
      element.scrollLeft += (previousFrom.current - span.fromBeat) * zoom;
    }
    previousFrom.current = span.fromBeat;
  }, [span.fromBeat, zoom]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || pendingScroll.current === null) return;
    element.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
    setScrollPx(element.scrollLeft);
  }, [zoom, transitionIndex, width]);

  useEffect(() => {
    if (canvas.current === null) return;
    draw({ canvas: canvas.current, width, height, rows, span, pxPerBeat: zoom, scrollPx, transition, outgoing, incoming });
  }, [width, height, rows, span, zoom, scrollPx, transition, outgoing, incoming]);

  const zoomBy = useCallback(
    (factor: number, anchorPx = width / 2) => {
      const next = zoomAround({ pxPerBeat: zoom, scrollPx }, factor, anchorPx, span, minPxPerBeat, width);
      setPxPerBeat(next.pxPerBeat);
      pendingScroll.current = next.scrollPx;
    },
    [zoom, scrollPx, span, minPxPerBeat, width],
  );

  // Ctrl/⌘ + scroll and a trackpad pinch (which Chromium sends as Ctrl + wheel) zoom around the pointer.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchor = event.clientX - element.getBoundingClientRect().left;
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, anchor);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
    };
  }, [zoomBy]);

  // The playhead follows the preview without re-rendering the timeline.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const line = playheadLine.current;
      const beat = playhead();
      if (line !== null) {
        line.hidden = beat === null;
        if (beat !== null) {
          const x = xOfBeat(beat, span, zoom);
          line.style.transform = `translateX(${String(x)}px)`;
          // Followed as rekordbox does: once it leaves the screen, the view jumps to keep it in sight.
          const view = scroller.current;
          if (view !== null && drag.current === null && (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth)) view.scrollLeft = Math.max(0, x - view.clientWidth * 0.2);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playhead, span, zoom]);

  const sliderValue = Math.round((Math.log(zoom / minPxPerBeat) / Math.log(MAX_PX_PER_BEAT / minPxPerBeat || 2)) * ZOOM_SLIDER_STEPS) || 0;
  const step = snapStep(zoom);
  const visibleFrom = beatOfX(scrollPx, span, zoom);
  const visibleTo = beatOfX(scrollPx + width, span, zoom);
  const marks = phraseMarks(transition, visibleFrom - BEATS_PER_PHRASE, visibleTo);
  const spanLeft = xOfBeat(0, span, zoom);

  const pointerToKeyframe = (event: ReactPointerEvent, laneIndex: number, keyframeIndex: number) => {
    const lane = transition.lanes[laneIndex];
    const row = rows.find((each) => each.kind === "lane" && each.lane === laneIndex);
    const box = content.current?.getBoundingClientRect();
    if (lane === undefined || row === undefined || box === undefined) return;
    const beat = snapBeat(beatOfX(event.clientX - box.left, span, zoom), step);
    const value = valueOfY(lane, event.clientY - box.top - row.top);
    dispatch({ kind: "move-keyframe", transition: transitionIndex, lane: laneIndex, keyframe: keyframeIndex, beat, value });
  };

  const onKeyframeKey = (event: KeyboardEvent, laneIndex: number, keyframeIndex: number) => {
    const lane = transition.lanes[laneIndex];
    const keyframe = lane?.keyframes[keyframeIndex];
    if (lane === undefined || keyframe === undefined) return;
    const by = event.shiftKey ? BEATS_PER_BAR : step;
    const moves: Record<string, readonly [number, number]> = {
      ArrowLeft: [-by, 0],
      ArrowRight: [by, 0],
      ArrowUp: [0, valueStep(lane)],
      ArrowDown: [0, -valueStep(lane)],
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      dispatch({ kind: "move-keyframe", transition: transitionIndex, lane: laneIndex, keyframe: keyframeIndex, beat: keyframe.beat + move[0], value: keyframe.value + move[1] });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ kind: "remove-keyframe", transition: transitionIndex, lane: laneIndex, keyframe: keyframeIndex });
      onSelect({ lane: laneIndex, keyframe: null });
    }
  };

  return (
    <section className="me-timeline" aria-label="Timeline">
      <div className="me-zoom" role="group" aria-label="Zoom">
        <button type="button" className="btn btn-quiet" aria-label="Zoom out" onClick={() => {
            zoomBy(1 / ZOOM_STEP);
          }}>
          −
        </button>
        <input
          type="range"
          aria-label="Zoom"
          min={0}
          max={ZOOM_SLIDER_STEPS}
          step={5}
          value={sliderValue}
          onChange={(event) => {
            const fraction = Number(event.currentTarget.value) / ZOOM_SLIDER_STEPS;
            zoomBy((minPxPerBeat * (MAX_PX_PER_BEAT / minPxPerBeat) ** fraction) / zoom);
          }}
        />
        <button type="button" className="btn btn-quiet" aria-label="Zoom in" onClick={() => {
            zoomBy(ZOOM_STEP);
          }}>
          +
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => {
            zoomBy(minPxPerBeat / zoom, 0);
          }}>
          Whole pair
        </button>
        <span className="me-caption" data-testid="zoom-level">
          {zoom >= 10 ? `${String(Math.round(zoom))} px a beat` : `${String(Math.round((width / zoom / BEATS_PER_BAR) * 10) / 10)} bars in view`}
        </span>
      </div>
      <div className="me-frame">
        <div className="me-labels" aria-hidden="true">
          {rows.map((row, index) => {
            if (row.kind === "ruler") return null;
            const lane = row.lane === undefined ? undefined : transition.lanes[row.lane];
            const text = row.kind === "wave" ? (row.track === "outgoing" ? outgoing.label : incoming.label) : row.kind === "ghost" ? "Moves (FLX4)" : lane === undefined ? "" : laneLabel(lane.param);
            return (
              <span key={index} className={`me-label me-label-${row.kind}`} style={{ top: row.top, height: row.height }}>
                {text}
              </span>
            );
          })}
        </div>
        <div
          ref={scroller}
          className="me-scroll"
          tabIndex={-1}
          onScroll={(event) => {
            setScrollPx(event.currentTarget.scrollLeft);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
            else if (event.key === "-") zoomBy(1 / ZOOM_STEP);
          }}
        >
          <div ref={content} className="me-content" style={{ width: totalPx, height }} data-testid="timeline-content">
            <canvas ref={canvas} className="me-canvas" style={{ width, height }} />
            {marks.map((mark) => (
              <span key={mark.phrase} className="me-phrase" style={{ left: xOfBeat(mark.beat, span, zoom) }} data-phrase={mark.phrase}>
                Phrase {mark.phrase}
              </span>
            ))}
            <span className="me-span-edge" style={{ left: spanLeft, top: RULER_H, height: height - RULER_H }} aria-hidden="true" />
            <span className="me-span-edge" style={{ left: spanLeft + transition.lengthBeats * zoom, top: RULER_H, height: height - RULER_H }} aria-hidden="true" />
            {rows.map((row) => {
              if (row.kind === "lane" && row.lane !== undefined) {
                const laneIndex = row.lane;
                const lane = transition.lanes[laneIndex];
                if (lane === undefined) return null;
                const lit = highlighted.includes(laneIndex);
                return (
                  <div
                    key={`lane-${String(laneIndex)}`}
                    className={`me-lane${lit ? " me-lane-lit" : ""}${selection.lane === laneIndex ? " me-lane-selected" : ""}`}
                    style={{ top: row.top, left: spanLeft, width: Math.max(1, transition.lengthBeats * zoom), height: row.height }}
                    data-lane={`${lane.track}:${lane.param}`}
                    onDoubleClick={(event) => {
                      const box = content.current?.getBoundingClientRect();
                      if (box === undefined) return;
                      const beat = snapBeat(beatOfX(event.clientX - box.left, span, zoom), step);
                      dispatch({ kind: "add-keyframe", transition: transitionIndex, lane: laneIndex, beat });
                    }}
                  >
                    <svg className="me-lane-shape" width="100%" height={row.height} aria-hidden="true">
                      <path d={lanePath(lane, transition, zoom)} />
                    </svg>
                    {lane.keyframes.map((keyframe, keyframeIndex) => {
                      const selected = selection.lane === laneIndex && selection.keyframe === keyframeIndex;
                      const where = positionText(transition, keyframe.beat);
                      return (
                        <button
                          key={keyframeIndex}
                          type="button"
                          className={`me-kf${selected ? " me-kf-selected" : ""}`}
                          style={{ left: keyframe.beat * zoom, top: yOfValue(lane, keyframe.value) }}
                          aria-label={`${laneLabel(lane.param)}, ${lane.track} track: keyframe ${String(keyframeIndex + 1)} at ${where}, ${formatLaneValue(lane.param, keyframe.value)}`}
                          aria-pressed={selected}
                          title={`${where} · beat ${String(keyframe.beat)} · ${formatLaneValue(lane.param, keyframe.value)} · ${keyframe.curve}`}
                          data-keyframe={keyframeIndex}
                          onFocus={() => {
                            onSelect({ lane: laneIndex, keyframe: keyframeIndex });
                          }}
                          onKeyDown={(event) => {
                            onKeyframeKey(event, laneIndex, keyframeIndex);
                          }}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.currentTarget.focus();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            drag.current = { lane: laneIndex, keyframe: keyframeIndex, pointer: event.pointerId };
                            onSelect({ lane: laneIndex, keyframe: keyframeIndex });
                          }}
                          onPointerMove={(event) => {
                            if (drag.current?.pointer !== event.pointerId) return;
                            pointerToKeyframe(event, laneIndex, keyframeIndex);
                          }}
                          onPointerUp={(event) => {
                            if (drag.current?.pointer === event.pointerId) drag.current = null;
                          }}
                        />
                      );
                    })}
                  </div>
                );
              }
              if (row.kind === "ghost") {
                return (
                  <div key="ghost" className="me-ghost" style={{ top: row.top, left: spanLeft, height: row.height }} aria-label="Controller moves" role="list">
                    {execution.steps.map((each, index) => (
                      <span
                        key={index}
                        role="listitem"
                        className={`me-ghost-step me-ghost-${each.hand}`}
                        style={{ left: each.startBeat * zoom, width: Math.max(4, (each.endBeat - each.startBeat) * zoom) }}
                        title={`${stepLabel(each)} · ${each.hand} hand · ${positionText(transition, each.startBeat)}`}
                      >
                        {stepLabel(each)}
                      </span>
                    ))}
                  </div>
                );
              }
              return null;
            })}
            <div ref={playheadLine} className="me-playhead" style={{ height }} hidden aria-hidden="true" />
          </div>
        </div>
      </div>
      <p className="me-caption">
        Drag keyframes to move them, snapped to {step === 1 ? "beats" : "half beats"} · double-click a lane to add one · arrows nudge, Shift by a bar · Ctrl/⌘ + scroll or
        pinch zooms
      </p>
    </section>
  );
}
