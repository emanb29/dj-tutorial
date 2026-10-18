// Lesson 3, `phrases`: tap each phrase start, then name the breakdown and the drop (check-design §4).
import type { CheckVariant } from "@shared/attempt.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import { scoreTaps, tapDetail, tapsFor } from "../taps.ts";
import { beatSeconds, heardTimesOf } from "../timeline.ts";

const LIMITS: Readonly<Record<CheckVariant, { matched: number; extras: number; questions: readonly ("breakdown" | "drop")[] }>> = {
  full: { matched: 6, extras: 1, questions: ["breakdown", "drop"] },
  short: { matched: 3, extras: 0, questions: ["drop"] },
};

export const phrases: LessonCheck<TaskOf<"phrases">> = {
  situations: { transition: false },
  criteria: ["phrases.phrase-taps", "phrases.name-sections"],
  run(context, { tapSection, sections }) {
    const limits = LIMITS[context.spec.variant];
    const deckA = loadedDeck(context, "A");
    const tolerance = deckA === null ? 0 : beatSeconds(deckA.playhead, deckA.grid, tapSection.from);
    const starts = deckA === null ? [] : heardTimesOf(deckA.playhead, deckA.phraseMarkers, tapSection);
    const scored = scoreTaps(tapsFor(context, tapSection, tolerance), starts, tolerance);
    const wrongAnswers = limits.questions.filter((question) => context.attempt.answers[question] !== sections[question]).length;

    return {
      criteria: [
        judgeAll(
          {
            id: "phrases.phrase-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: ">=", value: limits.matched, unit: "count" },
            measured: scored.matched,
            detail: tapDetail(scored),
          },
          {
            id: "phrases.phrase-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: "<=", value: limits.extras, unit: "count" },
            measured: scored.extras,
            scale: 1,
          },
        ),
        judge({
          id: "phrases.name-sections",
          severity: "fail",
          unit: "count",
          threshold: { op: "<=", value: 0, unit: "count" },
          measured: wrongAnswers,
          scale: 1,
          detail: { questions: limits.questions.length },
        }),
      ],
      metrics: {},
    };
  },
};
