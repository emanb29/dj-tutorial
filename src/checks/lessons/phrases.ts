// Lesson 3, `phrases`: tap each phrase start, then name the breakdown and the drop (check-design §4).
import type { CheckVariant, CtxTime } from "@shared/attempt.ts";
import type { CriterionResult } from "@shared/check-result.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import { scoreTaps, tapDetail, tapsFor } from "../taps.ts";
import { beatSeconds, heardTimesOf } from "../timeline.ts";

export type PhraseQuestion = "breakdown" | "drop";

const QUESTIONS: readonly PhraseQuestion[] = ["breakdown", "drop"];

const LIMITS: Readonly<Record<CheckVariant, { matched: number; extras: number; questions: readonly PhraseQuestion[] }>> = {
  full: { matched: 6, extras: 1, questions: QUESTIONS },
  short: { matched: 3, extras: 0, questions: ["drop"] },
};

/** A tap this many beats from a missed phrase start (but outside the tolerance) was for it: early or late. */
const NEAR_BEATS = 4;

// `CriterionResult.detail` is a flat map of numbers, so per-question and per-phrase facts are dotted
// keys. The writers in `run` and the readers below are the one place that knows them.
const answeredKey = (question: PhraseQuestion) => `${question}.answered`;
const correctKey = (question: PhraseQuestion) => `${question}.correct`;

export const phrases: LessonCheck<TaskOf<"phrases">> = {
  situations: { transition: false },
  criteria: ["phrases.phrase-taps", "phrases.name-sections"],
  run(context, { tapSection, sections }) {
    const limits = LIMITS[context.spec.variant];
    const deckA = loadedDeck(context, "A");
    const tolerance = deckA === null ? 0 : beatSeconds(deckA.playhead, deckA.grid, tapSection.from);
    const starts = deckA === null ? [] : heardTimesOf(deckA.playhead, deckA.phraseMarkers, tapSection);
    const taps = tapsFor(context, tapSection, tolerance);
    const scored = scoreTaps(taps, starts, tolerance);
    const answers = context.attempt.answers;
    const wrongAnswers = limits.questions.filter((question) => answers[question] !== sections[question]).length;

    return {
      criteria: [
        judgeAll(
          {
            id: "phrases.phrase-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: ">=", value: limits.matched, unit: "count" },
            measured: scored.matched,
            detail: { ...tapDetail(scored), ...missDetail(starts, scored.matchedTargets, taps, tolerance) },
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
          detail: {
            questions: limits.questions.length,
            ...Object.fromEntries(
              limits.questions.flatMap((question) => {
                const answered = answers[question];
                const correct: [string, number] = [correctKey(question), sections[question]];
                return answered === undefined ? [correct] : [[answeredKey(question), answered] as [string, number], correct];
              }),
            ),
          },
        }),
      ],
      metrics: {},
    };
  },
};

/**
 * Each phrase start no tap matched, by phrase number (1-based, as the answer chips count): `late.N` or
 * `early.N` (beats off) when a tap came within a bar of it, else `missed.N` (1).
 */
function missDetail(starts: readonly CtxTime[], matched: readonly CtxTime[], taps: readonly CtxTime[], beat: number): Record<string, number> {
  if (beat <= 0) return {};
  return Object.fromEntries(
    starts.flatMap((start, index): [string, number][] => {
      if (matched.includes(start)) return [];
      const phrase = String(index + 1);
      const nearest = taps
        .map((tap) => (tap - start) / beat)
        .filter((beats) => Math.abs(beats) <= NEAR_BEATS)
        .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      if (nearest === undefined) return [[`missed.${phrase}`, 1]];
      return [[`${nearest > 0 ? "late" : "early"}.${phrase}`, Math.round(Math.abs(nearest) * 10) / 10]];
    }),
  );
}

export interface SectionAnswer {
  readonly question: PhraseQuestion;
  /** The phrase the Learner picked; null when they picked none. */
  readonly answered: number | null;
  readonly correct: number;
}

/** The Learner's pick and the right phrase for each question `phrases.name-sections` graded, in order. */
export function sectionAnswersOf(criterion: CriterionResult): SectionAnswer[] {
  const detail = criterion.detail ?? {};
  return QUESTIONS.flatMap((question) => {
    const correct = detail[correctKey(question)];
    return correct === undefined ? [] : [{ question, answered: detail[answeredKey(question)] ?? null, correct }];
  });
}

export type PhraseTapMiss =
  | { readonly phrase: number; readonly kind: "missed" }
  | { readonly phrase: number; readonly kind: "late" | "early"; readonly beats: number };

/** The phrase starts `phrases.phrase-taps` found no tap on, by phrase. */
export function phraseTapMissesOf(criterion: CriterionResult): PhraseTapMiss[] {
  return Object.entries(criterion.detail ?? {})
    .flatMap(([key, value]): PhraseTapMiss[] => {
      const [kind, phraseText] = key.split(".");
      const phrase = Number(phraseText);
      if (!Number.isInteger(phrase)) return [];
      if (kind === "missed") return [{ phrase, kind }];
      return kind === "late" || kind === "early" ? [{ phrase, kind, beats: value }] : [];
    })
    .sort((a, b) => a.phrase - b.phrase);
}
