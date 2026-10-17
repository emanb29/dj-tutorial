// Lesson 16, `blend-by-ear`: a long blend with a bass swap, held in phase by ear (check-design §4).
import { blendAtLeast, blendPhaseHold, clashShort, handover, loudSteady, swapOnPhrase } from "../blend.ts";
import type { LessonCheck, TaskOf } from "../context.ts";
import { overlapSpans } from "../mix.ts";

/** `blend-length`: at least 16 bars − 1 beat; 8 bars − 1 beat in the short form. */
const MIN_BLEND_BARS = { full: 16 - 0.25, short: 8 - 0.25 } as const;

export const blendByEar: LessonCheck<TaskOf<"blend-by-ear">> = {
  situations: { transition: true },
  run(context) {
    const move = handover(context, "A", "B");
    return {
      criteria: [
        blendAtLeast("blend-by-ear.blend-length", move, MIN_BLEND_BARS[context.spec.variant]),
        blendPhaseHold("blend-by-ear.phase-hold", "fail", context, overlapSpans(context.attempt, context.window)),
        swapOnPhrase("blend-by-ear.swap-time", context, move),
        clashShort("blend-by-ear.clash-short", context, move),
        loudSteady("blend-by-ear.loud-steady", context, move),
      ],
      metrics: {},
    };
  },
};
