import { describe, expect, it } from "vitest";
import { CurriculumRequestSchema } from "@shared/coach-contract.ts";
import type { CheckResult, CriterionId, CriterionResult, CriterionStatus } from "@shared/check-result.ts";
import { LESSON_IDS, RECORDED_PATH_LESSON_IDS, type LessonId } from "@shared/catalogue.ts";
import { LearnerRecordSchema, emptyLearnerRecord } from "@shared/learner.ts";
import { PlacementResultSchema, type PlacementResult } from "@shared/placement.ts";
import { emptySkillProfile, type SkillProfile } from "@shared/skill-profile.ts";
import {
  ancestorsOf,
  applyPlacement,
  creditedLessons,
  hasPlacement,
  nextStep,
  nextTask,
  placementCurriculumRequest,
  startLesson,
  withPlacement,
  withTaskOutcome,
  type PlacementTask,
  type PlacementTaskId,
  type TaskOutcome,
} from "./placement.ts";

const STARTED = "2026-10-17T10:00:00.000Z";
const ENDED = "2026-10-17T10:05:00.000Z";

function criterion(id: CriterionId, status: CriterionStatus): CriterionResult {
  const measured = status === "notApplicable" ? null : 1;
  return { id, severity: "fail", status, measured, unit: "beats", threshold: { op: "<=", value: 2, unit: "beats" }, margin: measured === null ? null : 0.5, evidence: [] };
}

let attempts = 0;

/** A graded Placement attempt; `criteria` defaults to one met criterion of the Lesson's own. */
function graded(lessonId: LessonId, passed: boolean, criteria: readonly CriterionResult[] = [criterion(`${lessonId}.own` as CriterionId, passed ? "met" : "notMet")]): CheckResult {
  attempts += 1;
  return {
    schemaVersion: 1,
    attemptId: `attempt-${String(attempts)}`,
    learnerId: "default",
    lessonId,
    mode: "placement",
    variant: "short",
    startedAt: STARTED,
    endedAt: ENDED,
    inputDevice: "keyboard",
    endReason: "done",
    outcome: passed ? { kind: "passed" } : { kind: "failed", failedCriteria: criteria.filter((c) => c.status === "notMet").map((c) => c.id) },
    criteria,
    tracks: [],
    aids: { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: false },
    metrics: {},
  };
}

function emptyResult(): PlacementResult {
  return { schemaVersion: 1, placementId: "p1", learnerId: "default", run: "first", startedAt: STARTED, endedAt: ENDED, endReason: "noTaskLeft", mission: "", tasks: [] };
}

const NONE = emptySkillProfile("default");

/** Runs Placement with fixed answers per task (pass, fail, not yet); returns the result and the order run. */
function run(answers: Partial<Record<PlacementTaskId, "pass" | "fail" | "notYet" | CheckResult>>, profile: SkillProfile = NONE) {
  let result = emptyResult();
  const order: PlacementTaskId[] = [];
  const checks: CheckResult[] = [];
  for (let step = nextStep(result, profile, 0); step.kind === "task"; step = nextStep(result, profile, 0)) {
    const { task } = step;
    order.push(task.lessonId);
    const answer = answers[task.lessonId] ?? "fail";
    let outcome: TaskOutcome;
    if (answer === "notYet") outcome = { kind: "notYet" };
    else {
      const check = typeof answer === "object" ? answer : graded(task.lessonId, answer === "pass");
      checks.push(check);
      outcome = { kind: "graded", result: check };
    }
    result = withTaskOutcome(result, task, outcome, 0).result;
  }
  return { result, order, checks, end: nextStep(result, profile, 0) };
}

const passedProfile = (ids: readonly LessonId[]): SkillProfile => ({
  ...NONE,
  lessons: Object.fromEntries(ids.map((lessonId) => [lessonId, { lessonId, passedAt: STARTED, passedVia: "lesson" as const, attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }])),
});

describe("ancestorsOf", () => {
  it("follows prerequisites transitively, in catalogue order", () => {
    expect(ancestorsOf("cut-on-phrase")).toEqual(["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"]);
    expect(ancestorsOf("deck-basics")).toEqual([]);
  });
});

describe("nextStep: descent and narrowing (placement-design §3)", () => {
  it("starts with the recorded-mix path's hardest group task, not the live path's", () => {
    expect(nextTask(emptyResult(), NONE, 0)).toBe("bass-swap");
  });

  it("asks the live path's task only once Sync mixing is credited, and ends when it passes", () => {
    const { order, end } = run({ "bass-swap": "pass", "blend-by-ear": "pass" });
    expect(order).toEqual(["bass-swap", "blend-by-ear"]);
    expect(end).toEqual({ kind: "end", reason: "noTaskLeft" });
  });

  it("narrows the live path to nudge-phase when blend-by-ear fails on top of a Sync mixing pass", () => {
    expect(run({ "bass-swap": "pass" }).order).toEqual(["bass-swap", "blend-by-ear", "nudge-phase"]);
  });

  it("fails Sync mixing, passes Foundations, then narrows Sync mixing; the live path is never asked (3 tasks)", () => {
    const { order } = run({ "cut-on-phrase": "pass" });
    expect(order).toEqual(["bass-swap", "cut-on-phrase", "sync-blend"]);
  });

  it("never tests a Lesson on top of a just-failed prerequisite: every group fails → cue-point, beats-and-bars (5 tasks)", () => {
    const { order, end } = run({});
    expect(order).toEqual(["bass-swap", "cut-on-phrase", "phrases", "cue-point", "beats-and-bars"]);
    expect(end).toEqual({ kind: "end", reason: "noTaskLeft" });
  });

  it("skips a narrowing task that an earlier narrowing pass already credited", () => {
    const { order } = run({ "cue-point": "pass" });
    // cue-point credits beats-and-bars, so the Timing narrowing task is not run.
    expect(order).toEqual(["bass-swap", "cut-on-phrase", "phrases", "cue-point"]);
  });

  it("counts Not yet as not passed, for narrowing and for the ancestor rule", () => {
    const { order } = run({ "bass-swap": "notYet", "cut-on-phrase": "notYet", phrases: "pass" });
    // sync-blend sits on cut-on-phrase (not yet): skipped. cue-point does not.
    expect(order).toEqual(["bass-swap", "cut-on-phrase", "phrases", "cue-point"]);
  });

  it("starts no new task at or after 6:00 from the first hook", () => {
    const one = withTaskOutcome(emptyResult(), { lessonId: "bass-swap", groupId: "syncMixing", step: "group" }, { kind: "notYet" }, 0).result;
    expect(nextStep(one, NONE, 359)).toMatchObject({ kind: "task" });
    expect(nextStep(one, NONE, 360)).toEqual({ kind: "end", reason: "timeCap" });
  });

  it("on a re-take, never re-tests a passed Lesson and skips a group whose task is passed", () => {
    const { order } = run({}, passedProfile(["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase"]));
    expect(order).toEqual(["bass-swap", "sync-blend"]);
  });

  it("on a re-take with Sync mixing already passed, goes straight to the live path's task", () => {
    const passed = ancestorsOf("bass-swap").concat("bass-swap");
    expect(nextTask(emptyResult(), passedProfile(passed), 0)).toBe("blend-by-ear");
  });
});

describe("withTaskOutcome: voids", () => {
  const task: PlacementTask = { lessonId: "phrases", groupId: "timing", step: "group" };

  it("re-runs a first void silently and records nothing", () => {
    const { result, rerun } = withTaskOutcome(emptyResult(), task, { kind: "void" }, 0);
    expect(rerun).toBe(true);
    expect(result.tasks).toEqual([]);
  });

  it("counts a second void as Not yet", () => {
    const { result, rerun } = withTaskOutcome(emptyResult(), task, { kind: "void" }, 1);
    expect(rerun).toBe(false);
    expect(result.tasks).toEqual([{ ...task, outcome: "notYet", checkResult: null, voidRuns: 2 }]);
  });

  it("keeps the void count on a graded re-run", () => {
    const { result } = withTaskOutcome(emptyResult(), task, { kind: "graded", result: graded("phrases", true) }, 1);
    expect(result.tasks[0]).toMatchObject({ outcome: "passed", voidRuns: 1 });
    expect(PlacementResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("creditedLessons", () => {
  it("credits nothing from fails or Not yet (untested = not passed)", () => {
    expect(creditedLessons(run({ "bass-swap": "notYet" }).result)).toEqual([]);
  });

  it("credits a passed group task's Lesson, its skip group and every ancestor", () => {
    expect(creditedLessons(run({ "cut-on-phrase": "pass" }).result)).toEqual([
      "deck-basics",
      "beats-and-bars",
      "phrases",
      "gain-staging",
      "headphone-cue",
      "cue-point",
      "cut-on-phrase",
    ]);
  });

  it("credits a narrowing task's Lesson and ancestors only, not the rest of its group", () => {
    const credited = creditedLessons(run({ "cue-point": "pass" }).result);
    expect(credited).toEqual(["deck-basics", "beats-and-bars", "headphone-cue", "cue-point"]);
  });

  it("credits the whole critical path except final-mix for blend-by-ear, tempo-fader included", () => {
    const credited = creditedLessons(run({ "bass-swap": "pass", "blend-by-ear": "pass" }).result);
    expect(credited).toContain("tempo-fader");
    expect(credited).toContain("tempo-by-ear");
    expect(credited).not.toContain("final-mix");
    expect(credited.filter((id) => ["crossfader", "filter-transition", "hot-cues", "loop-transition", "echo-out"].includes(id))).toEqual([]);
  });

  describe("tempo-fader from the bass-swap task (ISS-81)", () => {
    const bassSwap = (tempo: CriterionStatus) => graded("bass-swap", true, [criterion("bass-swap.swap-time", "met"), criterion("tempo-fader.tempo-matched", tempo)]);

    it("is credited when tempo-fader.tempo-matched is met (tempos matched by hand)", () => {
      const credited = creditedLessons(run({ "blend-by-ear": "fail", "bass-swap": bassSwap("met") }).result);
      expect(credited).toContain("tempo-fader");
      expect(credited).toContain("sync-blend");
    });

    it("is not credited when it is notApplicable (SYNC used, or tempos did not start apart); the rest of the group is", () => {
      const credited = creditedLessons(run({ "blend-by-ear": "fail", "bass-swap": bassSwap("notApplicable") }).result);
      expect(credited).not.toContain("tempo-fader");
      expect(credited).toEqual(expect.arrayContaining(["sync-blend", "eq-basics", "bass-swap", "cut-on-phrase"]));
    });

    it("is not credited by a sync-blend or nudge-phase pass, which never measure the tempo fader", () => {
      expect(creditedLessons(run({ "cut-on-phrase": "pass", "sync-blend": "pass" }).result)).not.toContain("tempo-fader");
      const credited = creditedLessons(run({ "bass-swap": "pass", "blend-by-ear": "fail", "nudge-phase": "pass" }).result);
      expect(credited).toEqual(expect.arrayContaining(["nudge-phase", "sync-blend"]));
      expect(credited).not.toContain("tempo-fader");
    });
  });
});

describe("startLesson", () => {
  it("follows the recorded-mix path first: the crossfader, the filter and the performance Lessons come before the live path", () => {
    expect(startLesson(passedProfile(["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend"]))).toBe("crossfader");
    expect(startLesson(passedProfile([...RECORDED_PATH_LESSON_IDS]))).toBe("nudge-phase");
    expect(startLesson(passedProfile([...LESSON_IDS]))).toBe("final-mix");
  });

  it("is the first Lesson not passed in course order", () => {
    expect(startLesson(NONE)).toBe("deck-basics");
    expect(startLesson(passedProfile(["deck-basics", "beats-and-bars", "phrases"]))).toBe("gain-staging");
    expect(startLesson(passedProfile(["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "sync-blend", "eq-basics", "bass-swap"]))).toBe("tempo-fader");
  });
});

describe("applyPlacement (placement-design §6)", () => {
  it("passes credited Lessons via Placement and writes measured criteria as passed, never retained", () => {
    const { result, checks } = run({ "cut-on-phrase": "pass" });
    const profile = applyPlacement(NONE, { ...result, endedAt: ENDED }, checks);
    expect(profile.lessons["cue-point"]).toMatchObject({ passedAt: ENDED, passedVia: "placement" });
    expect(profile.lessons["cut-on-phrase"]).toMatchObject({ passedAt: ENDED, passedVia: "placement" });
    expect(profile.lessons["tempo-fader"]).toBeUndefined();
    const records = Object.values(profile.criteria);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(record?.retention?.state ?? "passed").toBe("passed");
    expect(profile.criteria["cut-on-phrase.own" as CriterionId]?.retention).toMatchObject({ state: "passed", step: 0 });
  });

  it("never writes retained, even for a large margin or a criterion due for a re-pass", () => {
    const big = { ...criterion("phrases.phrase-taps", "met"), margin: 10 };
    const { result, checks } = run({ "blend-by-ear": "fail", "bass-swap": "fail", "cut-on-phrase": "fail", phrases: graded("phrases", true, [big]) });
    const profile = applyPlacement(NONE, result, checks);
    expect(profile.criteria["phrases.phrase-taps"]?.retention).toMatchObject({ state: "passed", step: 0, nextDueAt: "2026-10-18T06:05:00.000Z" });
    expect(Object.values(profile.criteria).some((record) => record?.retention?.state === "retained")).toBe(false);
  });

  it("gives a group credited without its task run that task's criteria, unmeasured, due in a day", () => {
    const { result, checks } = run({ "blend-by-ear": "fail", "bass-swap": "pass" });
    const profile = applyPlacement(NONE, result, checks);
    for (const id of ["cut-on-phrase.cut-start", "cut-on-phrase.loud-jump", "phrases.phrase-taps"] as const) {
      expect(profile.criteria[id]).toMatchObject({ last: null, best: null, retention: { state: "passed", step: 0, nextDueAt: "2026-10-18T06:05:00.000Z" } });
    }
    // The measured group task is not given unmeasured records.
    expect(profile.criteria["bass-swap.enter-low-cut"]).toBeUndefined();
  });

  it("writes nothing for fails: no consecutiveFails, no last", () => {
    const { result, checks } = run({});
    expect(applyPlacement(NONE, result, checks)).toEqual(NONE);
  });

  it("only adds on a re-take: an earlier pass and a retained criterion keep what they had", () => {
    const before: SkillProfile = {
      ...passedProfile(["deck-basics"]),
      criteria: {
        "deck-basics.fade-in": {
          criterionId: "deck-basics.fade-in",
          lessonId: "deck-basics",
          last: null,
          best: null,
          firstPassedAt: STARTED,
          passDates: [STARTED],
          consecutiveFails: 0,
          retention: { state: "retained", step: 2, nextDueAt: "2026-11-01T00:00:00.000Z", lastColdPassAt: STARTED },
          practice: { attempts: 0, met: 0, lastAt: null },
        },
      },
    };
    const { result, checks } = run({ phrases: "pass" }, before);
    const after = applyPlacement(before, { ...result, run: "retake" }, checks);
    expect(after.lessons["deck-basics"]).toEqual(before.lessons["deck-basics"]);
    expect(after.criteria["deck-basics.fade-in"]).toEqual(before.criteria["deck-basics.fade-in"]);
    expect(after.lessons.phrases).toMatchObject({ passedVia: "placement" });
  });

  it("produces a record the server accepts", () => {
    const { result, checks } = run({ "blend-by-ear": "fail", "bass-swap": "pass" });
    const record = { ...emptyLearnerRecord("default"), placements: [result], skillProfile: applyPlacement(NONE, result, checks) };
    const parsed = LearnerRecordSchema.safeParse(record);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe("withPlacement", () => {
  it("keeps the Mission, the run and a deterministic Curriculum that starts at the Start Lesson", () => {
    const { result, checks } = run({ "blend-by-ear": "notYet", "bass-swap": "notYet", "cut-on-phrase": "notYet", phrases: "pass" });
    const placed = withPlacement(emptyLearnerRecord("default"), { ...result, mission: "post my mixes" }, checks);
    if (!placed.ok) throw new Error(placed.issues.join("; "));
    expect(placed.record.mission).toBe("post my mixes");
    expect(placed.record.placements).toHaveLength(1);
    expect(hasPlacement(placed.record)).toBe(true);
    expect(placed.record.curriculum?.[0]).toBe(startLesson(placed.record.skillProfile));
    expect(startLesson(placed.record.skillProfile)).toBe("gain-staging");
  });

  it("records a Placement skipped at the Mission, with nothing credited", () => {
    const placed = withPlacement(emptyLearnerRecord("default"), { ...emptyResult(), endReason: "skippedAtMission" }, []);
    if (!placed.ok) throw new Error(placed.issues.join("; "));
    expect(placed.record.skillProfile).toEqual(NONE);
    expect(placed.record.curriculum?.[0]).toBe("deck-basics");
  });
});

describe("placementCurriculumRequest (placement-design §7)", () => {
  it("sends every passed Lesson and one summary per graded attempt, with reason placement", () => {
    const { result, checks } = run({ "cut-on-phrase": "pass" });
    const profileAfter = applyPlacement(NONE, result, checks);
    const request = placementCurriculumRequest({ mission: "  post mixes  ", profileAfter, graded: checks }, "6f2a1d8e-6a59-4c1b-9a0e-0e9f0b2f4c11");
    expect(request.reason).toBe("placement");
    expect(request.mission).toBe("post mixes");
    expect(request.demonstrated).toEqual(creditedLessons(result));
    // bass-swap failed, cut-on-phrase passed, sync-blend failed: three graded, one summary each.
    expect(request.placementResults.map((summary) => [summary.lessonId, summary.outcome])).toEqual([
      ["bass-swap", "failed"],
      ["cut-on-phrase", "passed"],
      ["sync-blend", "failed"],
    ]);
    expect(CurriculumRequestSchema.safeParse(request).success).toBe(true);
  });
});
