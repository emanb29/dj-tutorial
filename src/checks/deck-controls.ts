// Deck controls on the event timeline (tempo, jog bend, SYNC, Master Tempo) and the CFX filter: their
// timelines, values at a moment and the Play press that started a play run. Units are the contract's
// (shared/attempt.ts `ControlId`); starting values come from the attempt's initial snapshots.
import type { Attempt, ControlEvent, CtxTime, DeckId } from "@shared/attempt.ts";
import { TIME_EPSILON } from "./measures.ts";

/**
 * What runCheck grades: the contract `Attempt`, plus the flag src/audio `RecordedAttempt` adds. It is
 * optional so plain contract attempts (and the eval scripts) still grade.
 */
export interface GradedAttempt extends Attempt {
  /** The recorder ran out of room: some continuous moves or meter frames were left out. */
  readonly degraded?: boolean;
}

export type DeckControl = "tempo" | "jogBend" | "sync" | "masterTempo" | "filter";

export interface DeckControlChange {
  /**
   * When it took effect. Deck controls (tempo, jog bend, SYNC, Master Tempo) use `appliedCtx`, the time
   * the playhead model changed, so they line up with it; the filter knob uses heard time like the
   * other mixer controls.
   */
  readonly ctx: CtxTime;
  readonly value: number;
  readonly byEngine: boolean;
}

const PLAYHEAD_CONTROLS: ReadonlySet<DeckControl> = new Set(["tempo", "jogBend", "sync", "masterTempo"]);

function appliedTime(event: ControlEvent): CtxTime {
  return event.appliedCtx ?? event.ctx;
}

/** Changes of one control on one deck, in time order. */
export function deckControlChanges(attempt: Attempt, control: DeckControl, deck: DeckId): DeckControlChange[] {
  const timeOf = PLAYHEAD_CONTROLS.has(control) ? appliedTime : (event: ControlEvent) => event.ctx;
  return attempt.events
    .filter((event) => event.control === control && event.deck === deck)
    .map((event) => ({ ctx: timeOf(event), value: event.value, byEngine: event.byEngine === true }))
    .sort((a, b) => a.ctx - b.ctx);
}

/** A control's value at `t`: the latest change at or before `t`, else `initial`. */
export function deckControlValueAt(changes: readonly DeckControlChange[], t: CtxTime, initial: number): number {
  return changes.filter((change) => change.ctx <= t + TIME_EPSILON).at(-1)?.value ?? initial;
}

/** The jog bend at `t`, as a fraction of the rate (0 = none). Bends are released (0) between turns. */
export function jogBendAt(attempt: Attempt, deck: DeckId, t: CtxTime): number {
  return deckControlValueAt(deckControlChanges(attempt, "jogBend", deck), t, attempt.initialDecks[deck].jogBend);
}

/** The CFX filter knob at `t`: −1 (full LPF) … 0 (centre, off) … +1 (full HPF). */
export function filterAt(attempt: Attempt, deck: DeckId, t: CtxTime): number {
  return deckControlValueAt(deckControlChanges(attempt, "filter", deck), t, attempt.initialMixer[deck].filter);
}

/** Whether the deck follows the other deck's tempo (SYNC on) at `t`. */
export function isSyncedAt(attempt: Attempt, deck: DeckId, t: CtxTime): boolean {
  return deckControlValueAt(deckControlChanges(attempt, "sync", deck), t, attempt.initialDecks[deck].sync ? 1 : 0) > 0;
}

/**
 * When the Learner pressed the button that started the deck's play run at `runStart` (the playhead
 * segment where it went from stopped to playing): the heard time of that Play, or of the deck CUE
 * press that started a preview. A point action is timed from the action (check-design, "Input
 * leeway"), so the output latency and the engine's lookahead between the press and the audio never
 * count against the Learner. The press is the one whose applied time is the run start; without one
 * (an attempt built by hand) the run start is used.
 */
export function playPressTime(attempt: Attempt, deck: DeckId, runStart: CtxTime): CtxTime {
  const press = attempt.events.find(
    (event) =>
      event.deck === deck &&
      event.byEngine !== true &&
      (event.control === "play" || (event.control === "deckCue" && event.value === 1)) &&
      Math.abs(appliedTime(event) - runStart) <= TIME_EPSILON,
  );
  return Math.min(press?.ctx ?? runStart, runStart);
}
