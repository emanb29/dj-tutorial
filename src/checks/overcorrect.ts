// Overcorrecting tempo (beginner mistake 8, check-design §3 `overcorrect`): tempo-fader reversals
// and the largest jog bend. Report-only: a metric for the Coach, never pass/fail.
import type { DeckId } from "@shared/attempt.ts";
import { loadedDeck, type CheckContext } from "./context.ts";
import { deckControlChanges } from "./deck-controls.ts";
import { TIME_EPSILON } from "./measures.ts";
import { tempoBpmAt } from "./phase.ts";

/** A tempo move counts once it goes this far against the current direction (catalogue: step > 0.02 BPM). */
export const REVERSAL_STEP_BPM = 0.02;

/**
 * Sign changes of Δtempo, with hysteresis: a reversal is counted when the tempo moves more than
 * 0.02 BPM back from its furthest point in the current direction. A per-event step test would miss
 * a slow drag, whose coalesced events are each smaller than 0.02 BPM.
 */
export function countReversals(bpms: readonly number[]): number {
  let direction = 0;
  let extreme = bpms[0] ?? 0;
  let reversals = 0;
  for (const bpm of bpms.slice(1)) {
    if (direction === 0) {
      if (Math.abs(bpm - extreme) > REVERSAL_STEP_BPM + TIME_EPSILON) direction = Math.sign(bpm - extreme);
      if (direction !== 0) extreme = bpm;
    } else if ((bpm - extreme) * direction > 0) {
      extreme = bpm;
    } else if ((extreme - bpm) * direction > REVERSAL_STEP_BPM + TIME_EPSILON) {
      reversals += 1;
      direction = -direction;
      extreme = bpm;
    }
  }
  return reversals;
}

/**
 * The tempo-fader BPM sequence of a deck: its tempo before the first move in the window, then
 * after each of the Learner's accepted tempo moves (read from the playhead, so only while playing).
 */
function tempoSequence(context: CheckContext, deck: DeckId): number[] {
  const loaded = loadedDeck(context, deck);
  if (loaded === null) return [];
  const moves = deckControlChanges(context.attempt, "tempo", deck).filter(
    (move) => !move.byEngine && move.ctx >= context.window.from && move.ctx < context.window.to,
  );
  const first = moves[0];
  const before = first === undefined ? null : tempoBpmAt(context.attempt, loaded, first.ctx - 1e-6);
  return [before, ...moves.map((move) => tempoBpmAt(context.attempt, loaded, move.ctx))].filter((bpm) => bpm !== null);
}

export interface Overcorrection {
  readonly tempoReversals: number;
  /** Largest |jog bend| in the window, percent of the rate. */
  readonly maxBendPercent: number;
}

export function overcorrection(context: CheckContext): Overcorrection {
  const decks: readonly DeckId[] = ["A", "B"];
  const bends = decks.flatMap((deck) =>
    deckControlChanges(context.attempt, "jogBend", deck).filter((bend) => bend.ctx >= context.window.from && bend.ctx < context.window.to),
  );
  return {
    tempoReversals: decks.reduce((total, deck) => total + countReversals(tempoSequence(context, deck)), 0),
    maxBendPercent: bends.reduce((most, bend) => Math.max(most, Math.abs(bend.value) * 100), 0),
  };
}
