// When the Lesson's practice set-up is (re)applied: LessonPlayer cues the decks whenever this changes.
import type { LessonPhase } from "@lessons";

/**
 * The practice set-up the decks should be in, or null outside the hook and practice. A two-deck
 * Lesson's hook (one without a by-ear drill, which starts its own rounds) leaves the decks mid-transition (bass-swap: B playing with fader B up and LOW A down;
 * loop-transition: A caught in a loop), so practice cues them again; a one-deck Lesson plays straight
 * on from its hook.
 */
export function practiceSetUp(phase: LessonPhase["kind"], twoDecks: boolean): "hook" | "practice" | null {
  if (phase === "hook") return twoDecks ? "hook" : "practice";
  return phase === "practice" ? "practice" : null;
}
