// Expected failures are values (AGENTS.md): every engine command returns one of these.

import type { DeckId } from "./types.ts";

export type AudioEngineError =
  | { kind: "tempo-out-of-range"; requestedRate: number; rangePercent: number }
  | { kind: "value-out-of-range"; control: string; value: number; min: number; max: number }
  | { kind: "no-track-loaded"; deck: DeckId }
  | { kind: "deck-loading"; deck: DeckId }
  | { kind: "invalid-track"; problems: readonly string[] }
  | { kind: "track-load-failed"; deck: DeckId; reason: string }
  | { kind: "no-beat-grid"; deck: DeckId }
  | { kind: "tempo-locked-by-sync"; deck: DeckId }
  | { kind: "master-tempo-unavailable"; reason: string }
  | { kind: "playhead-out-of-order"; atCtx: number; lastCtx: number }
  | { kind: "playhead-full"; limit: number }
  | { kind: "output-not-running" }
  | { kind: "engine-closed" }
  | { kind: "recorder-not-recording" }
  | { kind: "recorder-already-recording" }
  | { kind: "recorder-full"; capacity: number }
  | { kind: "recorder-track-changed"; deck: DeckId }
  | { kind: "recorder-no-input-device" }
  | { kind: "meter-drain-timeout"; waitedMs: number };

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: AudioEngineError };

export const OK = { ok: true } as const;

export function fail(error: AudioEngineError): { ok: false; error: AudioEngineError } {
  return { ok: false, error };
}

/** One readable sentence per error, stating the problem and the fix. */
export function describeError(error: AudioEngineError): string {
  switch (error.kind) {
    case "tempo-out-of-range":
      return `Rate ${error.requestedRate.toFixed(4)} is outside the ±${String(error.rangePercent)}% tempo range; widen the range or pick a closer track.`;
    case "value-out-of-range":
      return `${error.control} = ${String(error.value)} is outside [${String(error.min)}, ${String(error.max)}]; send a value inside the range.`;
    case "no-track-loaded":
      return `Deck ${error.deck} has no track; load one before using the transport.`;
    case "deck-loading":
      return `Deck ${error.deck} is still loading a track; wait for load() to resolve.`;
    case "invalid-track":
      return `The track cannot be loaded: ${error.problems.join("; ")}. Fix the analysis result or the buffer and load again.`;
    case "track-load-failed":
      return `Loading deck ${error.deck} failed (${error.reason}); the deck is empty. Try loading again.`;
    case "no-beat-grid":
      return `Deck ${error.deck} has no beat grid; analyse the track or load it with a grid before syncing.`;
    case "tempo-locked-by-sync":
      return `Deck ${error.deck} follows the other deck's tempo with SYNC on; turn SYNC off to move its tempo fader.`;
    case "master-tempo-unavailable":
      return `Master Tempo (key lock) is unavailable: ${error.reason}. Tempo still works with key lock off.`;
    case "playhead-out-of-order":
      return `A deck change at ${String(error.atCtx)} s is before the last one at ${String(error.lastCtx)} s; schedule deck changes in time order.`;
    case "playhead-full":
      return `The deck's playhead model reached ${String(error.limit)} changes; throttle jog-bend commands.`;
    case "output-not-running":
      return "The audio output is not running; resume the AudioContext from a user gesture first.";
    case "engine-closed":
      return "The audio engine is closed; create a new one.";
    case "recorder-not-recording":
      return "The attempt recorder is not recording; call start() first.";
    case "recorder-already-recording":
      return "The attempt recorder is already recording; call stop() before starting a new attempt.";
    case "recorder-full":
      return `The attempt recorder reached its capacity of ${String(error.capacity)} entries; end the attempt sooner or raise the capacity.`;
    case "recorder-track-changed":
      return `Deck ${error.deck} loaded a second track during the attempt; v1 attempts allow one track per deck.`;
    case "recorder-no-input-device":
      return "The attempt has no commands to infer the input device from; pass inputDevice in the attempt details.";
    case "meter-drain-timeout":
      return `Meter frames up to the end of the attempt did not arrive within ${String(error.waitedMs)} ms; is the AudioContext running?`;
  }
}
