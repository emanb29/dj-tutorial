// The controls a Learner has learned, for their own Complexity rating: a control whose Lesson isn't
// Passed yet makes a Transition harder for them (it never limits what they can plan).
import type { ControllerUnlocks } from "@app/controller/control-ids.ts";
import { unlocksAfter } from "@lessons";
import type { LearnerRecord } from "@shared/learner.ts";

export function plannerUnlocks(learner: LearnerRecord): ControllerUnlocks {
  const passed = Object.values(learner.skillProfile.lessons).flatMap((record) => (record.passedAt != null ? [record.lessonId] : []));
  return unlocksAfter(passed);
}
