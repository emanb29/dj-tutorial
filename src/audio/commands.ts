// The engine's command vocabulary. The virtual controller, the keyboard and later a MIDI adapter all
// send these, and the AttemptRecorder logs each one (check-design §1, "Control-event timeline").

import type { TempoRangePercent } from "./tempo.ts";
import type { BeatFxChannel } from "@shared/attempt.ts";
import type { DeckId, InputDevice } from "./types.ts";

export type EqControl = "eq-low" | "eq-mid" | "eq-high";

/** Knob and fader controls on one channel. Centred knobs are -1…1; the channel fader is 0…1. */
export type ChannelControl = "trim" | EqControl | "filter" | "channel-fader";

export type EngineCommand =
  | { control: "play" | "pause"; deck: DeckId }
  /**
   * The deck CUE button, pressed (true) and released (false), as on a CDJ: while playing, a press
   * returns to the cue point and pauses; while paused away from the cue point, a press sets the cue
   * point there; while paused on it, holding previews and releasing returns to it.
   */
  | { control: "deck-cue"; deck: DeckId; value: boolean }
  /** Track position in seconds. */
  | { control: "seek"; deck: DeckId; value: number }
  /** Tempo fader, -1…1 across the deck's tempo range. */
  | { control: "tempo"; deck: DeckId; value: number }
  | { control: "tempo-range"; deck: DeckId; value: TempoRangePercent }
  /** Master Tempo (key lock), headphone CUE and SYNC are on/off buttons. */
  | { control: "master-tempo" | "headphone-cue" | "sync"; deck: DeckId; value: boolean }
  /** Temporary rate bend while the jog wheel turns, as a fraction of the rate (0.05 is 5% faster); 0 releases it. */
  | { control: "jog-bend"; deck: DeckId; value: number }
  /**
   * The jog wheel turned on a paused deck: search. Moves the playhead by `value` track seconds (negative is
   * back), stopping at the start and end of the track; refused on a playing deck, where the jog bends
   * instead. The attempt contract has no control id for it: like `seek`, it shows in the deck's playhead
   * model (a segment at the new position, rate 0), which is what the Checks read (e.g. a cue point set
   * after searching). The recorder keeps the command itself only in its debugging `engineEvents`.
   */
  | { control: "jog-search"; deck: DeckId; value: number }
  | { control: ChannelControl; deck: DeckId; value: number }
  /**
   * Crossfader is 0 (full A) … 1 (full B); master level is a centred knob (-1…1); cue mix is 0 (cue) … 1
   * (master); headphone level is 0 (silent) … 0.5 (unity) … 1 (+6 dB), the MonitorOutput's headphone gain.
   */
  | { control: "crossfader" | "master-level" | "cue-mix" | "headphone-level"; value: number }
  /** Lesson buttons with no audio effect, recorded for the Checks: the tap key, "Done", and "Ready" for a deck. */
  /**
   * Hot cues, 8 pads per deck, `slot` 0–7. Set stores the heard position at the press (or `pos`, track
   * seconds, for a Lesson's set-up); a trigger jumps there and plays at once (quantize off); clear
   * empties the pad (SHIFT + pad).
   */
  | { control: "hot-cue-set"; deck: DeckId; slot: number; pos?: number }
  | { control: "hot-cue" | "hot-cue-clear"; deck: DeckId; slot: number }
  /**
   * Loops. LOOP IN marks the heard position; LOOP OUT closes a loop there from the IN point; loop-auto
   * (4 BEAT) loops `value` beats from the grid beat nearest the heard position; double and halve (SHIFT
   * + OUT / IN) move the loop's end; exit plays straight on. Loop points are whole samples.
   */
  | { control: "loop-in" | "loop-out" | "loop-double" | "loop-halve" | "loop-exit"; deck: DeckId }
  | { control: "loop-auto"; deck: DeckId; value: number }
  /** Beat FX (ECHO): ON/OFF, CH SELECT, BEAT ◀/▶ (one of BEAT_FX_BEATS) and LEVEL/DEPTH (0…1). */
  | { control: "beat-fx"; value: boolean }
  | { control: "beat-fx-channel"; value: BeatFxChannel }
  | { control: "beat-fx-beats" | "beat-fx-depth"; value: number }
  /** Beat FX tempo: a tapped BPM (TAP, SHIFT + BEAT ▶), or null to follow the selected deck again (AUTO, SHIFT + BEAT ◀). */
  | { control: "beat-fx-bpm"; value: number | null }
  | { control: "tap" | "done" }
  | { control: "ready"; deck: DeckId };

export type Control = EngineCommand["control"];

/** How and when a command was made. */
export interface CommandInput {
  readonly device: InputDevice;
  /** performance.now() milliseconds of the input (a DOM event's timeStamp). Defaults to the moment `command` is called. */
  readonly eventTimeMs?: number;
  /** The last event of a drag or turn; the recorder always keeps it, however fast the gesture was. */
  readonly gestureEnd?: boolean;
}

export const JOG_BEND_LIMIT = 0.5;

/** Valid ranges of numeric controls. `seek` is checked against the loaded track instead. */
export const CONTROL_RANGES = {
  tempo: [-1, 1],
  "jog-bend": [-JOG_BEND_LIMIT, JOG_BEND_LIMIT],
  trim: [-1, 1],
  "eq-low": [-1, 1],
  "eq-mid": [-1, 1],
  "eq-high": [-1, 1],
  filter: [-1, 1],
  "channel-fader": [0, 1],
  crossfader: [0, 1],
  "master-level": [-1, 1],
  "cue-mix": [0, 1],
  "headphone-level": [0, 1],
  "beat-fx-depth": [0, 1],
} as const satisfies Partial<Record<Control, readonly [number, number]>>;

/** Controls that move continuously under a pointer; the recorder coalesces their events. */
export const CONTINUOUS_CONTROLS: ReadonlySet<Control> = new Set(Object.keys(CONTROL_RANGES) as Control[]);
