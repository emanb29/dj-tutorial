// Deck controls the attempt contract has no control id for (tempo fader, jog bend, SYNC, CFX filter),
// read from the recorder's `engineEvents` (src/audio RecordedAttempt). The structural type below is
// the subset the Checks read, so the Checks do not depend on the audio engine's module.
import type { Attempt, CtxTime, DeckId } from "@shared/attempt.ts";
import { TIME_EPSILON } from "./measures.ts";

/** One command the engine saw: the part of src/audio `CommandEvent` the Checks read. */
export interface EngineCommandRecord {
  readonly command: { readonly control: string; readonly deck?: DeckId; readonly value?: number | boolean };
  /** `"engine"` marks a change the engine made itself (e.g. SYNC dropped). */
  readonly device: string;
  readonly heardCtx: CtxTime | null;
  readonly appliedCtx: CtxTime;
  /** `null` when the command was accepted. */
  readonly rejected: unknown;
}

/**
 * What runCheck grades: the contract `Attempt`, plus what src/audio `RecordedAttempt` adds. Both
 * extras are optional so plain contract attempts (and the eval scripts) still grade.
 */
export interface GradedAttempt extends Attempt {
  readonly engineEvents?: readonly EngineCommandRecord[];
  /** The recorder ran out of room: some continuous moves or meter frames were left out. */
  readonly degraded?: boolean;
}

export type DeckCommandControl = "tempo" | "jog-bend" | "sync" | "filter";

export interface DeckCommand {
  /**
   * When it took effect. Rate changes (tempo, jog bend, SYNC) use `appliedCtx`, the time the
   * playhead model changed, so they line up with it; the filter knob uses heard time like the
   * mixer's contract events.
   */
  readonly ctx: CtxTime;
  readonly value: number;
  readonly byEngine: boolean;
}

const RATE_CONTROLS: ReadonlySet<DeckCommandControl> = new Set(["tempo", "jog-bend", "sync"]);

/** Accepted commands of one control on one deck, in time order. Booleans become 1/0. */
export function deckCommands(attempt: GradedAttempt, control: DeckCommandControl, deck: DeckId): DeckCommand[] {
  return (attempt.engineEvents ?? [])
    .filter((record) => record.rejected === null && record.command.control === control && record.command.deck === deck)
    .map((record) => ({
      ctx: RATE_CONTROLS.has(control) ? record.appliedCtx : (record.heardCtx ?? record.appliedCtx),
      value: Number(record.command.value ?? 0),
      byEngine: record.device === "engine",
    }))
    .sort((a, b) => a.ctx - b.ctx);
}

/** A deck command's value at `t`: the latest at or before `t`, else `initial`. */
export function deckCommandValueAt(commands: readonly DeckCommand[], t: CtxTime, initial: number): number {
  return commands.filter((command) => command.ctx <= t + TIME_EPSILON).at(-1)?.value ?? initial;
}

/** The jog bend at `t`, as a fraction of the rate (0 = none). Bends are released (0) between turns. */
export function jogBendAt(attempt: GradedAttempt, deck: DeckId, t: CtxTime): number {
  return deckCommandValueAt(deckCommands(attempt, "jog-bend", deck), t, 0);
}

/**
 * The CFX filter knob at `t`: −1 (full LPF) … 0 (centre, off) … +1 (full HPF). The contract's
 * mixer snapshot has no filter, so the knob is taken as centred at the start (Lessons reset it).
 */
export function filterAt(attempt: GradedAttempt, deck: DeckId, t: CtxTime): number {
  return deckCommandValueAt(deckCommands(attempt, "filter", deck), t, 0);
}

/** Whether the deck follows the other deck's tempo (SYNC on) at `t`. */
export function isSyncedAt(attempt: GradedAttempt, syncedAtStart: readonly DeckId[], deck: DeckId, t: CtxTime): boolean {
  return deckCommandValueAt(deckCommands(attempt, "sync", deck), t, syncedAtStart.includes(deck) ? 1 : 0) > 0;
}
