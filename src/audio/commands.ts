// The engine's command vocabulary. The virtual controller, the keyboard and later a MIDI adapter all
// send these, and the AttemptRecorder logs each one (check-design §1, "Control-event timeline").

import type { TempoRangePercent } from "./tempo.ts";
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
   * after searching). The recorder keeps the command itself in `engineEvents`.
   */
  | { control: "jog-search"; deck: DeckId; value: number }
  | { control: ChannelControl; deck: DeckId; value: number }
  /**
   * Crossfader is 0 (full A) … 1 (full B); master level is a centred knob (-1…1); cue mix is 0 (cue) … 1
   * (master); headphone level is 0 (silent) … 0.5 (unity) … 1 (+6 dB), the MonitorOutput's headphone gain.
   */
  | { control: "crossfader" | "master-level" | "cue-mix" | "headphone-level"; value: number }
  /** Lesson buttons with no audio effect, recorded for the Checks: the tap key, "Done", and "Ready" for a deck. */
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
} as const satisfies Partial<Record<Control, readonly [number, number]>>;

/** Controls that move continuously under a pointer; the recorder coalesces their events. */
export const CONTINUOUS_CONTROLS: ReadonlySet<Control> = new Set(Object.keys(CONTROL_RANGES) as Control[]);
