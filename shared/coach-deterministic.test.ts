import { describe, expect, it } from "vitest";
import { LESSON_IDS, catalogueIndex, lessonById, type LessonId } from "./catalogue.ts";
import type { CheckLineRequest, CurriculumOutput } from "./coach-contract.ts";
import {
  criterionPlainName,
  curriculumFromOutput,
  curriculumOutputProblems,
  deterministicCurriculum,
  deterministicLine,
  lineProblems,
  mergeCurriculum,
  requiredRoute,
} from "./coach-deterministic.ts";

const FOUNDATIONS_AND_TIMING: LessonId[] = [
  "deck-basics",
  "beats-and-bars",
  "phrases",
  "gain-staging",
  "headphone-cue",
  "cue-point",
  "cut-on-phrase",
];

function expectPrerequisitesInOrder(curriculum: readonly LessonId[], demonstrated: readonly LessonId[]) {
  for (const [position, id] of curriculum.entries()) {
    for (const prerequisite of lessonById(id).prerequisites) {
      const ok = demonstrated.includes(prerequisite) || curriculum.indexOf(prerequisite) < position;
      expect(ok, `${prerequisite} before ${id}`).toBe(true);
    }
  }
}

describe("deterministic Curriculum", () => {
  it("for a new Learner, is every Lesson with each elective right after its last prerequisite", () => {
    const { curriculum, missionTags } = deterministicCurriculum([]);

    expect(curriculum).toEqual([
      "deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point",
      "hot-cues", "cut-on-phrase", "tempo-fader", "sync-blend", "crossfader", "loop-transition",
      "echo-out", "eq-basics", "filter-transition", "bass-swap", "nudge-phase", "tempo-by-ear",
      "blend-by-ear", "final-mix",
    ]);
    expect(missionTags).toEqual([]);
    expectPrerequisitesInOrder(curriculum, []);
  });

  it("skips demonstrated Lessons and starts at tempo-fader after Foundations and Timing (eval C2)", () => {
    const { curriculum } = deterministicCurriculum(FOUNDATIONS_AND_TIMING);

    expect(curriculum).toEqual([
      "hot-cues", "tempo-fader", "sync-blend", "crossfader", "loop-transition", "echo-out",
      "eq-basics", "filter-transition", "bass-swap", "nudge-phase", "tempo-by-ear", "blend-by-ear",
      "final-mix",
    ]);
    expectPrerequisitesInOrder(curriculum, FOUNDATIONS_AND_TIMING);
  });

  it("is only final-mix when everything else is demonstrated (eval C7)", () => {
    const everythingElse = LESSON_IDS.filter((id) => id !== "final-mix");
    expect(deterministicCurriculum(everythingElse).curriculum).toEqual(["final-mix"]);
  });

  it("never drops final-mix from the required route", () => {
    expect(requiredRoute([...LESSON_IDS])).toEqual(["final-mix"]);
  });

  it("keeps catalogue order when two electives share an anchor", () => {
    const merged = mergeCurriculum(["sync-blend", "final-mix"], [
      { lessonId: "echo-out", placeAfter: "sync-blend" },
      { lessonId: "crossfader", placeAfter: "sync-blend" },
    ]);
    expect(merged).toEqual(["sync-blend", "crossfader", "echo-out", "final-mix"]);
  });
});

describe("model Curriculum output", () => {
  const validOutput: CurriculumOutput = {
    missionTags: ["record-mixes", "edits"],
    electives: [
      { lessonId: "crossfader", include: false, placeAfter: "sync-blend", why: "Not needed for recorded mixes." },
      { lessonId: "filter-transition", include: true, placeAfter: "bass-swap", why: "A common move in house edits." },
      { lessonId: "hot-cues", include: true, placeAfter: "tempo-fader", why: "Edits lean on hot cues." },
      { lessonId: "loop-transition", include: true, placeAfter: "blend-by-ear", why: "Buys time in a long mix." },
      { lessonId: "echo-out", include: true, placeAfter: "sync-blend", why: "A clean exit for recorded sets." },
    ],
  };

  it("accepts valid output and merges it after the anchors", () => {
    expect(curriculumOutputProblems(validOutput, FOUNDATIONS_AND_TIMING)).toEqual([]);

    const data = curriculumFromOutput(validOutput, FOUNDATIONS_AND_TIMING);
    expect(data.curriculum).toEqual([
      "tempo-fader", "hot-cues", "sync-blend", "echo-out", "eq-basics", "bass-swap",
      "filter-transition", "nudge-phase", "tempo-by-ear", "blend-by-ear", "loop-transition", "final-mix",
    ]);
    expect(data.missionTags).toEqual(["record-mixes", "edits"]);
    expect(data.electiveNotes).toEqual({
      "filter-transition": "A common move in house edits.",
      "hot-cues": "Edits lean on hot cues.",
      "loop-transition": "Buys time in a long mix.",
      "echo-out": "A clean exit for recorded sets.",
    });
    expectPrerequisitesInOrder(data.curriculum, FOUNDATIONS_AND_TIMING);
  });

  it("reports every broken rule at once", () => {
    const broken: CurriculumOutput = {
      missionTags: [],
      electives: [
        { lessonId: "crossfader", include: true, placeAfter: "tempo-fader", why: "Before sync-blend." },
        { lessonId: "crossfader", include: false, placeAfter: "sync-blend", why: "Duplicate." },
        { lessonId: "filter-transition", include: true, placeAfter: "final-mix", why: "Last." },
        { lessonId: "hot-cues", include: true, placeAfter: "cue-point", why: "Anchor demonstrated." },
        { lessonId: "loop-transition", include: true, placeAfter: "sync-blend", why: "" },
      ],
    };

    const problems = curriculumOutputProblems(broken, FOUNDATIONS_AND_TIMING);

    expect(problems).toEqual([
      "rule 1: available elective crossfader appears 2 times; it must appear once.",
      "rule 1: available elective echo-out appears 0 times; it must appear once.",
      "rule 2: crossfader would come before its prerequisite sync-blend.",
      "rule 3: filter-transition is placed after final-mix, which must stay last.",
      "rule 2: hot-cues is placed after cue-point, which is not in the route.",
      'rule 4: the "why" for loop-transition must be 1–120 characters on one line.',
    ]);
  });

  it("rejects an elective the Learner already demonstrated", () => {
    const problems = curriculumOutputProblems(
      { missionTags: [], electives: [{ lessonId: "crossfader", include: false, placeAfter: "final-mix", why: "x" }] },
      LESSON_IDS.filter((id) => id !== "final-mix"),
    );
    expect(problems).toEqual(["rule 1: elective crossfader is not available (already demonstrated)."]);
  });

  it("keeps catalogue order across the whole merged route", () => {
    const { curriculum } = deterministicCurriculum([]);
    const required = curriculum.filter((id) => lessonById(id).skipGroup !== null || id === "final-mix");
    expect(required).toEqual([...required].sort((a, b) => catalogueIndex(a) - catalogueIndex(b)));
  });
});

function lineRequest(overrides: {
  outcome?: "passed" | "failed";
  criteria?: CheckLineRequest["result"]["criteria"];
  recentLines?: string[];
  retentionChange?: string | null;
  attemptToday?: number;
}): CheckLineRequest {
  return {
    requestId: "7d6f8e0a-2b8c-4b3e-9a51-1f2d3c4b5a69",
    result: {
      lessonId: "cut-on-phrase",
      mode: "lesson",
      variant: "full",
      outcome: overrides.outcome ?? "passed",
      criteria: overrides.criteria ?? [
        { id: "cut-on-phrase.cut-start", severity: "fail", status: "met", measured: 32, unit: "ms", threshold: { op: "<=", value: 40, unit: "ms" }, margin: 0.2 },
        { id: "standing.no-clip", severity: "fail", status: "met", measured: -3, unit: "dBFS", threshold: { op: "<=", value: -0.1, unit: "dBFS" }, margin: 0.9 },
      ],
      metrics: {},
    },
    context: {
      lessonTitle: "Your first transition: the cut",
      focusHistory: [],
      bestMarginBefore: null,
      retentionChange: overrides.retentionChange ?? null,
      attemptToday: overrides.attemptToday ?? 1,
      missionTags: [],
      recentLines: overrides.recentLines ?? [],
    },
  };
}

describe("deterministic post-Check line", () => {
  it("names the one missed criterion on a single-criterion fail", () => {
    const line = deterministicLine(
      lineRequest({
        outcome: "failed",
        attemptToday: 3,
        criteria: [
          { id: "standing.no-clip", severity: "fail", status: "notMet", measured: 0.4, unit: "dBFS", threshold: { op: "<=", value: -0.1, unit: "dBFS" }, margin: -5 },
          { id: "cut-on-phrase.cut-start", severity: "fail", status: "met", measured: 10, unit: "ms", threshold: { op: "<=", value: 40, unit: "ms" }, margin: 0.75 },
        ],
      }),
    );
    expect(line).toBe("Almost: just staying out of the red. Everything else held.");
  });

  it("points at the thin-margin criterion on a close pass", () => {
    const line = deterministicLine(
      lineRequest({
        attemptToday: 3,
        criteria: [
          { id: "cut-on-phrase.cut-start", severity: "fail", status: "met", measured: 38, unit: "ms", threshold: { op: "<=", value: 40, unit: "ms" }, margin: 0.05 },
        ],
      }),
    );
    expect(line).toBe("In. cutting on the phrase was close: that's the one to tighten next time.");
  });

  it("never repeats one of the last lines shown", () => {
    const first = deterministicLine(lineRequest({ attemptToday: 3 }));
    const second = deterministicLine(lineRequest({ attemptToday: 3, recentLines: [first] }));
    expect(second).not.toBe(first);
  });

  it("names the criterion to start with in the Learner's words, never its id (maintainer: \"Start with cfx back\")", () => {
    const failed = (id: "filter-transition.cfx-back" | "standing.level-match", margin: number, severity: "fail" | "warn" = "fail") =>
      ({ id, severity, status: "notMet", measured: 1.14, unit: "bars", threshold: { op: "<=", value: 1, unit: "bars" }, margin }) as const;
    const line = deterministicLine(lineRequest({ outcome: "failed", attemptToday: 0, criteria: [failed("filter-transition.cfx-back", -0.14), failed("standing.level-match", -1, "warn")] }));
    expect(line).toBe("Start with putting CFX A back; the rest gets easier once that holds.");
  });

  it("uses plain names for standing criteria and words for Lesson criteria", () => {
    expect(criterionPlainName("standing.one-bass")).toBe("one bassline at a time");
    expect(criterionPlainName("blend-by-ear.phase-hold")).toBe("keeping the kicks together");
    expect(criterionPlainName("filter-transition.cfx-back")).toBe("putting CFX A back");
  });
});

describe("model line validation", () => {
  const request = lineRequest({});
  const modelInput = { measured: 32, threshold: 40, retentionChange: "retained, next in 7 days" };

  it("accepts a short line whose numbers come from the input", () => {
    expect(lineProblems("Your play landed 32 ms from the phrase: keep that timing.", request, modelInput)).toEqual([]);
  });

  it("reports every broken rule at once", () => {
    const problems = lineProblems("You failed at 55 ms, so your score dropped.", request, modelInput);
    expect(problems).toEqual([
      "numbers: 55 is not in the input.",
      "outcome: a passed result must not say it failed.",
      'voice: never say "score" or "grade".',
    ]);
  });

  it("rejects long, multi-line and repeated lines", () => {
    expect(lineProblems("x".repeat(111), request, modelInput)).toEqual([
      "length: 111 characters; it must be 1–110.",
    ]);
    expect(lineProblems("One.\nTwo.", request, modelInput)).toEqual(["lines: the line must be a single line."]);
    expect(
      lineProblems("Nice one.", lineRequest({ recentLines: ["nice one."] }), modelInput),
    ).toEqual(["repeat: identical to one of the last lines shown."]);
  });

  it("rejects a line that shows a criterion's internal id", () => {
    expect(lineProblems("Work on cut-start next time.", request, modelInput)).toEqual([
      'names: "cut-start" is an internal id; use the criterion\'s name from the input.',
    ]);
  });

  it("rejects praise for a pass on a failed result", () => {
    expect(lineProblems("You nailed it.", lineRequest({ outcome: "failed" }), modelInput)).toEqual([
      "outcome: a failed result must not say it passed.",
    ]);
  });
});
