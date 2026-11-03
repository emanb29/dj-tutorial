// One Transition, edited: breadcrumbs (Set → Track 2 → Track 3 → lane) with the previous and next pair
// and "+ new pair"; the recipes first (picking one gives a good Transition with no lane editing); where
// it starts and how long it is; one-tap Preview with a loop; the quiet Complexity chip, whose reasons
// and the Execution strip open on demand; and the timeline, where "Edit moves" opens the lanes.
// The editor warns past rating 3 and never blocks or changes a design.
import { useState } from "react";
import type { WaveformOverview } from "@analysis";
import { BEATS_PER_BAR, BEATS_PER_PHRASE, beatIndexOf, beatsInTrack, CONTROL_RANGES, LANE_PARAMS, phraseOf, RECIPE_IDS, type LaneParam, type MixPlan } from "@shared/mix-plan.ts";
import { RECIPES } from "@shared/mix-plan-recipes.ts";
import { KeyHint } from "../controller/KeyHint.tsx";
import type { EditorAction } from "./editor-state.ts";
import { barsText, formatLaneValue, hardWarning, laneLabel, positionText, recipeName } from "./editor-text.ts";
import type { ExecutionPlan } from "./execution-plan.ts";
import { ExecutionStrip, RatingChip } from "./ExecutionStrip.tsx";
import { LOW_GRID_CONFIDENCE, type PlanTrackData } from "./plan-tracks.ts";
import { Timeline, type Selection } from "./Timeline.tsx";

/** The lengths the stepper offers, bars. */
export const LENGTH_BARS: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64];

export interface TransitionEditorProps {
  readonly plan: MixPlan;
  readonly index: number;
  readonly tracks: readonly (PlanTrackData | undefined)[];
  /** Waveforms drawn from the decoded audio, for tracks whose analysis is not cached. */
  readonly waveforms: ReadonlyMap<string, WaveformOverview>;
  readonly execution: ExecutionPlan;
  readonly dispatch: (action: EditorAction) => void;
  readonly previewing: boolean;
  readonly previewLoading: boolean;
  readonly loop: boolean;
  readonly onPreview: () => void;
  readonly onLoop: (loop: boolean) => void;
  readonly playhead: () => number | null;
  readonly onPair: (index: number) => void;
  readonly onNewPair: () => void;
  readonly onClose: () => void;
}

const trackName = (index: number) => `Track ${String(index + 1)}`;

function Stepper({ label, value, onLess, onMore, lessDisabled, moreDisabled }: { readonly label: string; readonly value: string; readonly onLess: () => void; readonly onMore: () => void; readonly lessDisabled?: boolean; readonly moreDisabled?: boolean }) {
  return (
    <div className="me-stepper" role="group" aria-label={label}>
      <span className="me-stepper-label">{label}</span>
      <button type="button" className="btn btn-quiet" aria-label={`${label}: less`} onClick={onLess} disabled={lessDisabled}>
        −
      </button>
      <output className="me-stepper-value">{value}</output>
      <button type="button" className="btn btn-quiet" aria-label={`${label}: more`} onClick={onMore} disabled={moreDisabled}>
        +
      </button>
    </div>
  );
}

export function TransitionEditor(props: TransitionEditorProps) {
  const { plan, index, tracks, execution, dispatch } = props;
  const transition = plan.transitions[index];
  const [selection, setSelection] = useState<Selection>({ lane: null, keyframe: null });
  const [editMoves, setEditMoves] = useState(false);
  const [ghostMoves, setGhostMoves] = useState(false);
  const [why, setWhy] = useState(false);
  const [highlighted, setHighlighted] = useState<readonly number[]>([]);
  const [newLane, setNewLane] = useState("");
  if (transition === undefined) return null;
  const outgoing = tracks[index];
  const incoming = tracks[index + 1];
  const outTrack = plan.tracks[index];
  const inTrack = plan.tracks[index + 1];
  const gridsKnown = outgoing?.grid != null && incoming?.grid != null;
  const warning = hardWarning(execution.complexity, transition);
  const startPhrase = phraseOf(transition.outgoingAt).phrase;
  const inPhrase = phraseOf(transition.incomingAt).phrase;
  const lastStartPhrase = outgoing?.grid == null ? null : Math.max(1, Math.floor(beatsInTrack(outgoing.grid) / BEATS_PER_PHRASE) + 1);
  const lastInPhrase = incoming?.grid == null ? null : Math.max(1, Math.floor(beatsInTrack(incoming.grid) / BEATS_PER_PHRASE) + 1);
  const bars = transition.lengthBeats / BEATS_PER_BAR;
  const lengthIndex = LENGTH_BARS.findIndex((each) => each >= bars);
  const selectedLane = selection.lane === null ? undefined : transition.lanes[selection.lane];
  const selectedKeyframe = selection.keyframe === null ? undefined : selectedLane?.keyframes[selection.keyframe];
  const missingLanes = (["outgoing", "incoming"] as const).flatMap((track) =>
    LANE_PARAMS.filter((param) => !transition.lanes.some((lane) => lane.track === track && lane.param === param)).map((param) => ({ track, param })),
  );
  const lowConfidence = [outgoing, incoming].flatMap((each, at) =>
    each?.analysis != null && !each.fromRekordbox && each.analysis.confidence < LOW_GRID_CONFIDENCE ? [{ name: trackName(index + at), confidence: each.analysis.confidence }] : [],
  );

  const highlight = (lanes: readonly number[]) => {
    setHighlighted(lanes);
    if (lanes.length > 0) setEditMoves(true);
  };

  return (
    <section className="me-editor" aria-label="Transition editor" data-transition={index}>
      <nav className="me-crumbs" aria-label="Breadcrumbs">
        <button type="button" className="btn btn-quiet" onClick={props.onClose}>
          Set
        </button>
        <span aria-hidden="true">›</span>
        <span className="me-crumb-here" data-testid="pair">
          {trackName(index)} → {trackName(index + 1)}
        </span>
        {selectedLane === undefined ? null : (
          <>
            <span aria-hidden="true">›</span>
            <span className="me-crumb-lane">
              {laneLabel(selectedLane.param)} ({selectedLane.track === "outgoing" ? trackName(index) : trackName(index + 1)})
            </span>
          </>
        )}
        <span className="me-crumb-moves">
          <button type="button" className="btn btn-quiet" disabled={index === 0} onClick={() => {
              props.onPair(index - 1);
            }}>
            ◀ Previous pair
          </button>
          <button type="button" className="btn btn-quiet" disabled={index >= plan.transitions.length - 1} onClick={() => {
              props.onPair(index + 1);
            }}>
            Next pair ▶
          </button>
          <button type="button" className="btn btn-quiet" onClick={props.onNewPair}>
            + New pair
          </button>
        </span>
      </nav>
      <p className="me-pair-names">
        <span className="me-out">{outTrack?.title ?? outTrack?.fileName}</span> → <span className="me-in">{inTrack?.title ?? inTrack?.fileName}</span>
      </p>

      <div className="me-recipes" role="group" aria-label="Recipes">
        {RECIPE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="me-recipe"
            aria-pressed={transition.recipe === id}
            disabled={id === "tempo-ride" && !gridsKnown}
            title={id === "tempo-ride" && !gridsKnown ? "Needs both tracks' beat grids" : undefined}
            onClick={() => {
              setSelection({ lane: null, keyframe: null });
              dispatch({ kind: "recipe", transition: index, recipe: id });
            }}
          >
            {RECIPES[id].name}
          </button>
        ))}
        {transition.recipe === "custom" ? <span className="me-recipe me-recipe-custom" aria-current="true">Custom</span> : null}
      </div>

      <div className="me-controls">
        <Stepper
          label="Starts at"
          value={`Phrase ${String(startPhrase)}`}
          lessDisabled={startPhrase <= 1}
          moreDisabled={lastStartPhrase !== null && startPhrase >= lastStartPhrase}
          onLess={() => {
            dispatch({ kind: "start-phrase", transition: index, phrase: startPhrase - 1 });
          }}
          onMore={() => {
            dispatch({ kind: "start-phrase", transition: index, phrase: startPhrase + 1 });
          }}
        />
        <Stepper
          label="Length"
          value={barsText(transition.lengthBeats)}
          lessDisabled={bars <= (LENGTH_BARS[0] ?? 1)}
          moreDisabled={bars >= (LENGTH_BARS.at(-1) ?? 64)}
          onLess={() => {
            const shorter = [...LENGTH_BARS].reverse().find((each) => each < bars) ?? bars;
            dispatch({ kind: "length", transition: index, lengthBeats: shorter * BEATS_PER_BAR });
          }}
          onMore={() => {
            const longer = LENGTH_BARS[lengthIndex === -1 ? LENGTH_BARS.length - 1 : LENGTH_BARS[lengthIndex] === bars ? lengthIndex + 1 : lengthIndex] ?? bars;
            dispatch({ kind: "length", transition: index, lengthBeats: longer * BEATS_PER_BAR });
          }}
        />
        <Stepper
          label="Next track from"
          value={`Phrase ${String(inPhrase)}`}
          lessDisabled={inPhrase <= 1}
          moreDisabled={lastInPhrase !== null && inPhrase >= lastInPhrase}
          onLess={() => {
            dispatch({ kind: "incoming-phrase", transition: index, phrase: inPhrase - 1 });
          }}
          onMore={() => {
            dispatch({ kind: "incoming-phrase", transition: index, phrase: inPhrase + 1 });
          }}
        />
        <div className="me-preview" role="group" aria-label="Preview">
          <button type="button" className="btn btn-primary" onClick={props.onPreview} disabled={!gridsKnown || props.previewLoading} data-nav-default>
            {props.previewing ? "■ Stop" : props.previewLoading ? "Loading…" : "▶ Preview"} <KeyHint k="Enter" />
          </button>
          <button type="button" className="btn btn-quiet" aria-pressed={props.loop} onClick={() => {
              props.onLoop(!props.loop);
            }}>
            Loop {props.loop ? "on" : "off"}
          </button>
        </div>
        <RatingChip
          rating={execution.complexity.rating}
          expanded={why}
          onClick={() => {
            setWhy(!why);
          }}
        />
      </div>
      {warning === null ? null : (
        <p className="me-warning" role="status" data-testid="hard-warning">
          ⚠ {warning}
        </p>
      )}
      {lowConfidence.map((each) => (
        <p key={each.name} className="me-caption me-grid-note">
          {each.name}'s beat grid is uncertain ({String(Math.round(each.confidence * 100))}% sure): check the phrase marks against its waveform. Link its rekordbox grid on the Controller page to use that one.
        </p>
      ))}

      <div className="me-toggles">
        <button type="button" className="btn btn-quiet" aria-pressed={editMoves} onClick={() => {
            setEditMoves(!editMoves);
          }}>
          Edit moves
        </button>
        <button type="button" className="btn btn-quiet" aria-pressed={ghostMoves} onClick={() => {
            setGhostMoves(!ghostMoves);
          }}>
          Ghost moves
        </button>
        {highlighted.length === 0 ? null : (
          <button type="button" className="btn btn-quiet" onClick={() => {
              setHighlighted([]);
            }}>
            Clear highlight
          </button>
        )}
      </div>

      <Timeline
        transitionIndex={index}
        transition={transition}
        outgoing={{ label: trackName(index), grid: outgoing?.grid ?? null, waveform: outgoing?.analysis?.waveformOverview ?? props.waveforms.get(outTrack?.contentHash ?? "") ?? null }}
        incoming={{ label: trackName(index + 1), grid: incoming?.grid ?? null, waveform: incoming?.analysis?.waveformOverview ?? props.waveforms.get(inTrack?.contentHash ?? "") ?? null }}
        editMoves={editMoves}
        ghostMoves={ghostMoves}
        execution={execution}
        selection={selection}
        highlighted={highlighted}
        onSelect={setSelection}
        dispatch={dispatch}
        playhead={props.playhead}
      />
      {why ? <ExecutionStrip transition={transition} execution={execution} onHighlight={highlight} /> : null}

      {editMoves ? (
        <div className="me-inspector" aria-label="Keyframe">
          {selectedLane === undefined || selection.lane === null ? (
            <p className="me-caption">Pick a keyframe on the timeline (or turn BROWSE to one) to set it exactly.</p>
          ) : (
            <>
              <span className="me-inspector-title">
                {laneLabel(selectedLane.param)}, {selectedLane.track === "outgoing" ? trackName(index) : trackName(index + 1)}
              </span>
              {selectedKeyframe === undefined || selection.keyframe === null ? null : (
                <>
                  <label className="me-field">
                    Beat ({positionText(transition, selectedKeyframe.beat)})
                    <input
                      type="range"
                      min={0}
                      max={transition.lengthBeats}
                      step={1}
                      value={selectedKeyframe.beat}
                      onChange={(event) => {
                        if (selection.lane === null || selection.keyframe === null) return;
                        dispatch({ kind: "move-keyframe", transition: index, lane: selection.lane, keyframe: selection.keyframe, beat: Number(event.currentTarget.value), value: selectedKeyframe.value });
                      }}
                    />
                  </label>
                  <label className="me-field">
                    Value ({formatLaneValue(selectedLane.param, selectedKeyframe.value)})
                    <input
                      type="range"
                      min={CONTROL_RANGES[selectedLane.param].min}
                      max={CONTROL_RANGES[selectedLane.param].max}
                      step={selectedLane.param === "loop" || selectedLane.param === "tempo" ? 1 : 0.05}
                      value={selectedKeyframe.value}
                      onChange={(event) => {
                        if (selection.lane === null || selection.keyframe === null) return;
                        dispatch({ kind: "move-keyframe", transition: index, lane: selection.lane, keyframe: selection.keyframe, beat: selectedKeyframe.beat, value: Number(event.currentTarget.value) });
                      }}
                    />
                  </label>
                  <label className="me-field">
                    Curve
                    <select
                      value={selectedKeyframe.curve}
                      onChange={(event) => {
                        if (selection.lane === null || selection.keyframe === null) return;
                        dispatch({ kind: "curve", transition: index, lane: selection.lane, keyframe: selection.keyframe, curve: event.currentTarget.value as "jump" | "linear" | "ease" });
                      }}
                    >
                      <option value="jump">jump</option>
                      <option value="linear">linear</option>
                      <option value="ease">ease</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      if (selection.lane === null || selection.keyframe === null) return;
                      dispatch({ kind: "remove-keyframe", transition: index, lane: selection.lane, keyframe: selection.keyframe });
                      setSelection({ lane: selection.lane, keyframe: null });
                    }}
                  >
                    Delete keyframe
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  if (selection.lane === null) return;
                  const after = selectedKeyframe?.beat ?? 0;
                  dispatch({ kind: "add-keyframe", transition: index, lane: selection.lane, beat: Math.min(transition.lengthBeats, after + BEATS_PER_BAR) });
                }}
              >
                + Keyframe
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  if (selection.lane === null) return;
                  dispatch({ kind: "remove-lane", transition: index, lane: selection.lane });
                  setSelection({ lane: null, keyframe: null });
                }}
              >
                Remove lane
              </button>
            </>
          )}
          <label className="me-field">
            Add a lane
            <select
              value={newLane}
              onChange={(event) => {
                setNewLane(event.currentTarget.value);
              }}
            >
              <option value="">Pick one…</option>
              {missingLanes.map(({ track, param }) => (
                <option key={`${track}:${param}`} value={`${track}:${param}`}>
                  {laneLabel(param)}, {track === "outgoing" ? trackName(index) : trackName(index + 1)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={newLane === ""}
            onClick={() => {
              const [track, param] = newLane.split(":") as ["outgoing" | "incoming", LaneParam];
              dispatch({ kind: "add-lane", transition: index, track, param });
              setNewLane("");
            }}
          >
            Add
          </button>
        </div>
      ) : (
        <p className="me-caption">
          {recipeName(transition)} from {positionText(transition, 0)} of {trackName(index)} (bar {String(beatIndexOf(transition.outgoingAt) / BEATS_PER_BAR + 1)}) · Edit moves to shape the lanes yourself
        </p>
      )}
    </section>
  );
}
