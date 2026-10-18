// Lesson 9, `sync-blend`: blend B in over a phrase with sync on (check-design §4).
import { blendLength, blendStart, handover, loudSteady, trimUntouched } from "../blend.ts";
import type { LessonCheck, TaskOf } from "../context.ts";

/** `blend-length`: 8 bars − 1 beat … 16 bars + 1 beat; the short form is an 8–9 bar blend. */
export const SYNC_BLEND_BARS = { full: [8 - 0.25, 16 + 0.25], short: [8, 9] } as const;

export const syncBlend: LessonCheck<TaskOf<"sync-blend">> = {
  situations: { transition: true },
  criteria: ["sync-blend.blend-start", "sync-blend.blend-length", "sync-blend.loud-steady", "sync-blend.trim-untouched"],
  run(context) {
    const move = handover(context, "A", "B");
    return {
      criteria: [
        blendStart("sync-blend.blend-start", move),
        blendLength("sync-blend.blend-length", move, SYNC_BLEND_BARS[context.spec.variant]),
        loudSteady("sync-blend.loud-steady", context, move),
        trimUntouched("sync-blend.trim-untouched", context),
      ],
      metrics: {},
    };
  },
};
