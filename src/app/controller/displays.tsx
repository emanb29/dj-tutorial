// Displays that change every frame: level meters, the beat counter and the phase strip. Each draws from
// the engine on the shared frame loop and writes to the DOM through refs, never through React state.

import { useRef } from "react";
import type { DeckId, MeterBus } from "@audio";
import type { ControlId } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlFrame } from "./ControlFrame.tsx";
import { useFrame } from "./frame-loop.ts";

export const METER_SEGMENTS = 11;
const METER_FLOOR_DB = -42;
const METER_CEILING_DB = 3;
/** The top segment lights at or above this sample peak. */
const CLIP_DB = -0.5;
/** Falling meters drop this many dB per second, so short peaks stay readable. */
const METER_FALL_DB_PER_SEC = 24;

/** 0…1 meter height for a sample peak in dBFS. */
export function meterFraction(peakDb: number): number {
  if (peakDb >= CLIP_DB) return 1;
  const fraction = (peakDb - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
  return Math.max(0, Math.min((METER_SEGMENTS - 1) / METER_SEGMENTS, fraction));
}

export function LevelMeter({ id, bus, label }: { readonly id: ControlId; readonly bus: MeterBus; readonly label: string }) {
  const { frames, meters } = useController();
  const lit = useRef<HTMLDivElement>(null);
  const shown = useRef({ db: Number.NEGATIVE_INFINITY, atMs: 0, fraction: -1 });
  useFrame(frames, (nowMs) => {
    const state = shown.current;
    const fallen = state.db - (METER_FALL_DB_PER_SEC * (nowMs - state.atMs)) / 1000;
    const db = Math.max(meters.get(bus) ?? Number.NEGATIVE_INFINITY, fallen);
    state.db = db;
    state.atMs = nowMs;
    // Whole segments only, like LEDs; skip the DOM write when nothing changed.
    const fraction = Math.ceil(meterFraction(db) * METER_SEGMENTS) / METER_SEGMENTS;
    if (fraction === state.fraction || lit.current === null) return;
    state.fraction = fraction;
    lit.current.style.clipPath = `inset(${String((1 - fraction) * 100)}% 0 0 0)`;
  });
  return (
    <ControlFrame id={id} className="meter" label={label}>
      <div className="meter-body" role="img" aria-label={`${label} level meter`}>
        <div className="meter-segments meter-unlit" />
        <div ref={lit} className="meter-segments meter-lit" style={{ clipPath: "inset(100% 0 0 0)" }} />
      </div>
    </ControlFrame>
  );
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  return `${String(minutes)}:${(whole - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/** Track name, BPM, bar.beat and time for one deck. BPM is a lockable display (Lessons cover it). */
export function DeckReadout({ deck }: { readonly deck: DeckId }) {
  const { frames, engine } = useController();
  const trackId = useSessionValue((snapshot) => snapshot.decks[deck].trackId);
  const bpm = useSessionValue((snapshot) => snapshot.bpm[deck]);
  const rangePercent = useSessionValue((snapshot) => snapshot.decks[deck].tempoRangePercent);
  const position = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const beats = useRef<HTMLSpanElement>(null);
  const last = useRef({ position: "", time: "", beat: -1 });
  useFrame(frames, () => {
    const reading = engine.playhead(deck);
    const positionText = reading.ok && reading.bar !== null && reading.beatInBar !== null ? `${String(reading.bar)}.${String(reading.beatInBar)}` : "–.–";
    const timeText = reading.ok ? formatTime(reading.positionSec) : "–:––.–";
    const beat = reading.ok && reading.beatInBar !== null ? reading.beatInBar : 0;
    const seen = last.current;
    if (position.current !== null && positionText !== seen.position) position.current.textContent = positionText;
    if (time.current !== null && timeText !== seen.time) time.current.textContent = timeText;
    if (beats.current !== null && beat !== seen.beat) beats.current.dataset["beat"] = String(beat);
    last.current = { position: positionText, time: timeText, beat };
  });
  return (
    <div className={`deck-readout deck-${deck}`} data-testid={`readout-${deck}`}>
      <span className="deck-letter">{deck}</span>
      <span className="readout-track">{trackId ?? "No track"}</span>
      <ControlFrame id={`${deck}.bpm`} className="readout-bpm">
        <span className="readout-number">{bpm === null ? "–" : bpm.toFixed(1)}</span>
        <span className="readout-unit">BPM ±{rangePercent}%</span>
      </ControlFrame>
      <span className="readout-position" title="Bar.beat">
        <span className="readout-unit">BAR</span> <span ref={position} className="readout-number" data-testid={`position-${deck}`} />
      </span>
      <span ref={beats} className="beat-dots" data-beat="0" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span ref={time} className="readout-time" />
    </div>
  );
}

/**
 * The phase meter: each deck's beat within the bar, and how far B's beat is ahead of or behind A's.
 * The marker sits in the middle when the beats line up.
 */
export function PhaseStrip() {
  const { frames, engine } = useController();
  const marker = useRef<HTMLDivElement>(null);
  const rows = useRef<Record<DeckId, HTMLDivElement | null>>({ A: null, B: null });
  const last = useRef({ A: -1, B: -1, offset: Number.NaN });
  useFrame(frames, () => {
    const a = engine.playhead("A");
    const b = engine.playhead("B");
    const seen = last.current;
    for (const [deck, reading] of [["A", a], ["B", b]] as const) {
      const beat = reading.ok && reading.beatInBar !== null ? reading.beatInBar : 0;
      const row = rows.current[deck];
      if (row !== null && beat !== seen[deck]) row.dataset["beat"] = String(beat);
      seen[deck] = beat;
    }
    const offset = a.ok && b.ok && a.beat !== null && b.beat !== null ? wrapHalf(b.beat - a.beat) : Number.NaN;
    const rounded = Math.round(offset * 200) / 200;
    if (marker.current !== null && rounded !== seen.offset && !(Number.isNaN(rounded) && Number.isNaN(seen.offset))) {
      marker.current.style.left = Number.isNaN(rounded) ? "50%" : `${String(50 + rounded * 100)}%`;
      marker.current.dataset["aligned"] = String(Math.abs(rounded) < 0.03);
    }
    seen.offset = rounded;
  });
  return (
    <ControlFrame id="phase-meter" className="phase-strip" label="PHASE">
      <div className="phase-body" role="img" aria-label="Phase meter">
        {(["A", "B"] as const).map((deck) => (
          <div
            key={deck}
            className={`phase-row deck-${deck}`}
            data-beat="0"
            ref={(node) => {
              rows.current[deck] = node;
            }}
          >
            <i />
            <i />
            <i />
            <i />
          </div>
        ))}
        <div className="phase-offset">
          <span className="phase-centre" />
          <div ref={marker} className="phase-marker" style={{ left: "50%" }} />
        </div>
      </div>
    </ControlFrame>
  );
}

/** Wraps a beat difference into [-0.5, 0.5): how far B is ahead (+) or behind (−) A, in beats. */
export function wrapHalf(beats: number): number {
  return beats - Math.round(beats);
}
