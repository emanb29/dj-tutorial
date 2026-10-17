// Tap Checks: which taps belong to a section, and scoring them against heard targets.
import type { CtxSpan } from "@shared/attempt.ts";
import type { CheckContext } from "./context.ts";
import { matchTaps, TIME_EPSILON, type TapMatch } from "./measures.ts";
import { controlEvents } from "./timeline.ts";

/**
 * Taps that belong to `section`: from `tolerance` before it starts to `tolerance` before it ends,
 * so an early tap on a section's first target counts in that section, not the previous one.
 */
export function tapsFor(context: CheckContext, section: CtxSpan, tolerance: number): number[] {
  return controlEvents(context.attempt.events, "tap", undefined, {
    from: section.from - tolerance,
    to: section.to - tolerance + TIME_EPSILON,
  }).map((event) => event.ctx);
}

export interface ScoredTaps extends TapMatch {
  readonly targets: number;
  readonly ratio: number;
}

export function scoreTaps(taps: readonly number[], targets: readonly number[], tolerance: number): ScoredTaps {
  const match = matchTaps(taps, targets, tolerance);
  return { ...match, targets: targets.length, ratio: targets.length === 0 ? 0 : match.matched / targets.length };
}

export function tapDetail(scored: ScoredTaps): Record<string, number> {
  return { matched: scored.matched, extras: scored.extras, targets: scored.targets };
}
