// Test support: the Lesson catalogue as it was before the two paths (2026-11-03), frozen, so tests can
// prove a stored Skill profile never loses an open Lesson under the new course.
import type { LessonId } from "./catalogue.ts";

/** Every Lesson's prerequisites before the two paths. */
export const PREREQUISITES_BEFORE_PATHS: Readonly<Record<LessonId, readonly LessonId[]>> = {
  "deck-basics": [],
  "beats-and-bars": ["deck-basics"],
  phrases: ["beats-and-bars"],
  "gain-staging": ["deck-basics"],
  "headphone-cue": ["deck-basics"],
  "cue-point": ["beats-and-bars", "headphone-cue"],
  "cut-on-phrase": ["phrases", "gain-staging", "cue-point"],
  "tempo-fader": ["deck-basics"],
  "sync-blend": ["cut-on-phrase", "tempo-fader"],
  crossfader: ["sync-blend"],
  "eq-basics": ["gain-staging", "phrases"],
  "bass-swap": ["eq-basics", "sync-blend"],
  "filter-transition": ["eq-basics", "sync-blend"],
  "nudge-phase": ["cut-on-phrase", "tempo-fader"],
  "tempo-by-ear": ["nudge-phase"],
  "blend-by-ear": ["tempo-by-ear", "bass-swap"],
  "hot-cues": ["cue-point", "phrases"],
  "loop-transition": ["sync-blend", "phrases"],
  "echo-out": ["cut-on-phrase", "sync-blend"],
  "final-mix": ["blend-by-ear", "cut-on-phrase"],
};

/** Whether a Lesson was open (its prerequisites passed) under the catalogue before the two paths. */
export function openBeforePaths(lessonId: LessonId, passed: ReadonlySet<LessonId>): boolean {
  return PREREQUISITES_BEFORE_PATHS[lessonId].every((id) => passed.has(id));
}
