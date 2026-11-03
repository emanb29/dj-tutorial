// Which hand plays each step, and when a hand is busy. The FLX4's layout decides: deck A's half is the
// left hand's, deck B's half and Beat FX the right's, and the crossfader goes to whichever hand is free.
// When a step's own hand is busy and the other is free, the other hand reaches across for it; when both
// are busy it stays on its own hand, and the Complexity rating counts the overlap.

import { flx4LayoutControl } from "@app/controller/flx4-keys.ts";
import type { ExecutionStep, Hand } from "./execution-plan.ts";

/** Two presses closer together than this are at once; a hand needs this long for a button. */
export const AT_ONCE_BEATS = 1 / 4;

/** When a step keeps its hand busy: [from, to) in beats. */
export interface Occupancy {
  readonly from: number;
  readonly to: number;
}

/**
 * A button or jump holds its hand for AT_ONCE_BEATS from its beat. A ramp holds it from just after its
 * start to its end, so a hand can press a button and then start a ramp, or finish a ramp and then
 * press, without that counting as two moves at once.
 */
export function occupancy(step: Pick<ExecutionStep, "startBeat" | "endBeat">): Occupancy {
  const { startBeat, endBeat } = step;
  return endBeat - startBeat <= AT_ONCE_BEATS ? { from: startBeat, to: startBeat + AT_ONCE_BEATS } : { from: startBeat + AT_ONCE_BEATS, to: endBeat };
}

export function overlaps(a: Occupancy, b: Occupancy): boolean {
  return a.from < b.to && b.from < a.to;
}

export const otherHand = (hand: Hand): Hand => (hand === "left" ? "right" : "left");

export type UnassignedStep = Omit<ExecutionStep, "hand">;

/**
 * Hands for steps already in time order. First every deck-side step takes its own side's hand. Then, in
 * order, a step that collides with an earlier one on its hand moves across if the other hand is free
 * for it, and each crossfader step takes the free hand (both free or both busy: the one that has rested
 * longer; left on a tie).
 */
export function assignHands(steps: readonly UnassignedStep[]): ExecutionStep[] {
  const entries = steps.map((step, order) => {
    const side = flx4LayoutControl(step.control).side;
    const hand: Hand | null = side === "centre" ? null : side;
    return { step, order, span: occupancy(step), hand };
  });
  type Entry = (typeof entries)[number];
  /** Whether `hand` has a step at the same time as `entry`, among those ordered before `before`. */
  const busy = (entry: Entry, hand: Hand, before = entries.length) =>
    entries.some((other) => other !== entry && other.order < before && other.hand === hand && overlaps(other.span, entry.span));
  /** When `hand` last let go, among the steps before `entry`. */
  const restedSince = (hand: Hand, entry: Entry) => Math.max(-Infinity, ...entries.filter((other) => other.order < entry.order && other.hand === hand).map(({ span }) => span.to));
  for (const entry of entries) {
    const own = entry.hand;
    if (own === null) {
      const free = (["left", "right"] as const).filter((hand) => !busy(entry, hand));
      const candidates = free.length === 0 ? (["left", "right"] as const) : free;
      entry.hand = candidates.reduce((best, hand) => (restedSince(hand, entry) < restedSince(best, entry) ? hand : best));
    } else if (busy(entry, own, entry.order) && !busy(entry, otherHand(own))) {
      entry.hand = otherHand(own);
    }
  }
  return entries.map(({ step, hand }) => {
    if (hand === null) throw new Error(`${step.control} at beat ${String(step.startBeat)} got no hand: assignHands must give every step one.`);
    return { ...step, hand };
  });
}
