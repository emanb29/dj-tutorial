// Tolerance tiers (check-design, "Input leeway", maintainer 2026-10-16).
import type { LessonId } from "@shared/attempt.ts";

/** Keyboard taps, every Lesson. */
export const TAP_TOLERANCE_MS = 40;
/** Tapping B's beat in headphones (`headphone-cue`), check-design §4. */
export const CUED_TAP_TOLERANCE_MS = 50;
/** Cue points and hot cues are placed on a paused track, so no gesture leeway applies. */
export const CUE_PLACEMENT_TOLERANCE_MS = 20;

/**
 * Point-in-time actions (cut, hot-cue trigger, phrase-start Play): ±120 ms in the Lesson that
 * introduces the action, ±80 ms in later Lessons, ±60 ms in `final-mix`.
 */
export function pointActionToleranceMs(introducedIn: LessonId, checkLesson: LessonId): 120 | 80 | 60 {
  if (checkLesson === "final-mix") return 60;
  return checkLesson === introducedIn ? 120 : 80;
}
