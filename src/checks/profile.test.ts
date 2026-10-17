import { describe, expect, it } from "vitest";
import type { CheckMode, LessonId } from "@shared/attempt.ts";
import type { CheckResult, CriterionId, CriterionResult, Severity } from "@shared/check-result.ts";
import { emptySkillProfile, type SkillProfile } from "@shared/skill-profile.ts";
import { applyCheckResult, FINAL_MIX_ROUTE, lessonRetention } from "./profile.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-01T18:00:00.000Z");
const iso = (hoursAfterT0: number) => new Date(T0 + hoursAfterT0 * HOUR).toISOString();

type Row = readonly [id: CriterionId, met: boolean, margin?: number, severity?: Severity];

function result(lessonId: LessonId, mode: CheckMode, hours: number, rows: readonly Row[], attemptId = `a-${String(hours)}`): CheckResult {
  const criteria: CriterionResult[] = rows.map(([id, met, margin = met ? 0.5 : -0.5, severity = "fail"]) => ({
    id,
    severity,
    status: met ? "met" : "notMet",
    measured: 1 - margin,
    unit: "ratio",
    threshold: { op: "<=", value: 1, unit: "ratio" },
    margin,
    evidence: [],
  }));
  const failed = criteria.filter((criterion) => criterion.severity === "fail" && criterion.status === "notMet");
  return {
    schemaVersion: 1,
    attemptId,
    learnerId: "learner-1",
    lessonId,
    mode,
    variant: mode === "lesson" ? "full" : "short",
    startedAt: iso(hours - 0.01),
    endedAt: iso(hours),
    inputDevice: "keyboard",
    endReason: "done",
    outcome: failed.length === 0 ? { kind: "passed" } : { kind: "failed", failedCriteria: failed.map((criterion) => criterion.id) },
    criteria,
    tracks: [],
    aids: { sync: false, quantize: false, bpmDisplay: true, phaseMeter: false, lessonText: mode === "lesson" },
    metrics: {},
  };
}

const TAPS: CriterionId = "beats-and-bars.beat-taps";
const DOWNBEATS: CriterionId = "beats-and-bars.downbeat-taps";
const pass = (mode: CheckMode, hours: number, met = true) =>
  result("beats-and-bars", mode, hours, [
    [TAPS, met],
    [DOWNBEATS, true],
  ]);

function apply(...results: readonly CheckResult[]): SkillProfile {
  return results.reduce((profile, next) => applyCheckResult(profile, next).profile, emptySkillProfile("learner-1"));
}

describe("passing a Lesson Check", () => {
  it("marks each criterion passed, due again 20 h later (1 day minus 4 h slack)", () => {
    const profile = apply(pass("lesson", 0));

    expect(profile.criteria[TAPS]?.retention).toEqual({ state: "passed", step: 0, nextDueAt: iso(20), lastColdPassAt: null });
    expect(profile.criteria[TAPS]).toMatchObject({ lessonId: "beats-and-bars", firstPassedAt: iso(0), passDates: [iso(0)], consecutiveFails: 0 });
    expect(profile.lessons["beats-and-bars"]).toMatchObject({ passedAt: iso(0), passedVia: "lesson", attempts: 1 });
  });

  it("does not mark a criterion passed when the Check as a whole failed", () => {
    const profile = apply(result("beats-and-bars", "lesson", 0, [[TAPS, true], [DOWNBEATS, false]]));

    expect(profile.criteria[TAPS]?.retention?.state).toBe("notPassed");
    expect(profile.criteria[DOWNBEATS]).toMatchObject({ consecutiveFails: 1, last: { status: "notMet" } });
    expect(profile.lessons["beats-and-bars"]).toMatchObject({ passedAt: null, attempts: 1 });
  });

  it("keeps the best margin and the newest 20 pass dates", () => {
    const results = Array.from({ length: 22 }, (_, index) =>
      result("beats-and-bars", "lesson", index, [[TAPS, true, index === 5 ? 0.9 : 0.1], [DOWNBEATS, true]]),
    );
    const record = apply(...results).criteria[TAPS];

    expect(record?.best).toMatchObject({ margin: 0.9, at: iso(5) });
    expect(record?.passDates).toHaveLength(20);
    expect(record?.passDates[0]).toBe(iso(2));
  });
});

describe("retention ladder (cold re-passes)", () => {
  it("retains a criterion met cold once due (≥ 20 h), next due in 3 days minus 4 h", () => {
    const profile = apply(pass("lesson", 0), pass("warmup", 20));

    expect(profile.criteria[TAPS]?.retention).toEqual({
      state: "retained",
      step: 1,
      nextDueAt: iso(20 + 72 - 4),
      lastColdPassAt: iso(20),
    });
  });

  it("does not advance on an early cold pass: only last and best change", () => {
    const profile = apply(pass("lesson", 0), pass("cold", 19.9));

    expect(profile.criteria[TAPS]?.retention).toMatchObject({ state: "passed", step: 0, nextDueAt: iso(20) });
    expect(profile.criteria[TAPS]?.last).toMatchObject({ at: iso(19.9), mode: "cold" });
  });

  it("climbs 1 → 3 → 7 → 21 → 60 days and stays at 60", () => {
    let hours = 0;
    const steps = [pass("lesson", hours)];
    for (const days of [1, 3, 7, 21, 60, 60]) {
      hours += days * 24 - 4;
      steps.push(pass("warmup", hours));
    }
    const profile = apply(...steps);

    expect(profile.criteria[TAPS]?.retention).toMatchObject({ state: "retained", step: 4, nextDueAt: iso(hours + 60 * 24 - 4) });
  });

  it("lapses on any cold miss, due again in a day, without re-locking the Lesson", () => {
    const update = applyCheckResult(apply(pass("lesson", 0), pass("warmup", 20)), pass("warmup", 30, false));

    expect(update.profile.criteria[TAPS]?.retention).toMatchObject({ state: "lapsed", step: 0, nextDueAt: iso(30 + 20) });
    expect(update.profile.lessons["beats-and-bars"]?.passedAt).toBe(iso(0));
    expect(update.retentionChanges).toContainEqual({ criterionId: TAPS, from: "retained", to: "lapsed", nextDueAt: iso(50) });
  });

  it("lapses even on an early cold miss (a miss is real evidence of forgetting)", () => {
    expect(apply(pass("lesson", 0), pass("cold", 5, false)).criteria[TAPS]?.retention?.state).toBe("lapsed");
  });

  it("keeps a lapsed criterion lapsed after a Review, then retains it on a due cold pass", () => {
    const lapsed = [pass("lesson", 0), pass("warmup", 20, false)];
    const afterReview = apply(...lapsed, pass("lesson", 25));

    expect(afterReview.criteria[TAPS]?.retention).toMatchObject({ state: "lapsed", step: 0, nextDueAt: iso(45) });
    expect(apply(...lapsed, pass("lesson", 25), pass("cold", 45)).criteria[TAPS]?.retention).toMatchObject({ state: "retained", step: 1 });
  });

  it("needs 20 h since the last pass, even when due", () => {
    // Due at 20 h, but a Lesson re-pass at 10 h resets the 20 h gap.
    const profile = apply(pass("lesson", 0), pass("lesson", 10), pass("cold", 21));

    expect(profile.criteria[TAPS]?.retention?.state).toBe("passed");
  });

  it("derives a Lesson's retention as the worst of its criteria", () => {
    const mixed = apply(
      pass("lesson", 0),
      result("beats-and-bars", "warmup", 20, [
        [TAPS, true],
        [DOWNBEATS, false],
      ]),
    );

    expect(mixed.criteria[TAPS]?.retention?.state).toBe("retained");
    expect(lessonRetention(mixed, "beats-and-bars")).toBe("lapsed");
    expect(lessonRetention(mixed, "phrases")).toBe("notPassed");
  });
});

describe("Placement", () => {
  it("writes passed, never retained, and records the pass as via Placement", () => {
    const profile = apply(pass("placement", 0));

    expect(profile.criteria[TAPS]?.retention).toMatchObject({ state: "passed", step: 0, nextDueAt: iso(20) });
    expect(profile.lessons["beats-and-bars"]).toMatchObject({ passedVia: "placement" });
  });

  it("writes nothing for a failed task", () => {
    const empty = emptySkillProfile("learner-1");

    expect(applyCheckResult(empty, pass("placement", 0, false)).profile).toEqual(empty);
  });

  it("never touches the retention of an already-passed criterion", () => {
    const profile = apply(pass("lesson", 0), pass("warmup", 20), pass("placement", 30));

    expect(profile.criteria[TAPS]?.retention).toMatchObject({ state: "retained", step: 1 });
  });
});

describe("bonus exercises", () => {
  it("change only practice counters, never pass, retention or the Review counter", () => {
    const before = apply(pass("lesson", 0));
    const after = applyCheckResult(before, pass("bonus", 21, false)).profile;

    expect(after.criteria[TAPS]?.practice).toEqual({ attempts: 1, met: 0, lastAt: iso(21) });
    expect(after.criteria[TAPS]?.retention).toEqual(before.criteria[TAPS]?.retention);
    expect(after.criteria[TAPS]?.consecutiveFails).toBe(0);
    expect(after.criteria[TAPS]?.last).toEqual(before.criteria[TAPS]?.last);
    expect(after.lessons).toEqual(before.lessons);
  });
});

describe("standing criteria", () => {
  it("get records but no retention schedule", () => {
    const profile = apply(
      result("cut-on-phrase", "lesson", 0, [
        ["cut-on-phrase.cut-start", true],
        ["standing.no-clip", true],
      ]),
    );

    expect(profile.criteria["standing.no-clip"]).toMatchObject({ lessonId: "gain-staging", retention: null, passDates: [iso(0)] });
  });
});

describe("Review trigger", () => {
  const miss = (hours: number, severity: Severity = "fail", mode: CheckMode = "lesson") =>
    result("beats-and-bars", mode, hours, [[TAPS, false, -0.5, severity]]);

  it("fires on the third consecutive gating fail of one criterion, naming the Lesson that introduced it", () => {
    const profile = apply(miss(0), miss(1));
    const third = applyCheckResult(profile, miss(2));

    expect(applyCheckResult(apply(miss(0)), miss(1)).reviewTriggers).toEqual([]);
    expect(third.reviewTriggers).toEqual([{ criterionId: TAPS, lessonId: "beats-and-bars" }]);
    expect(third.profile.criteria[TAPS]?.consecutiveFails).toBe(3);
  });

  it("resets on the next met result", () => {
    expect(apply(miss(0), miss(1), pass("lesson", 2), miss(3)).criteria[TAPS]?.consecutiveFails).toBe(1);
  });

  it("counts cold fails, but not warnings or bonus fails", () => {
    expect(apply(pass("lesson", 0), miss(20, "fail", "warmup"), miss(21), miss(22)).criteria[TAPS]?.consecutiveFails).toBe(3);
    expect(apply(miss(0, "warn"), miss(1, "warn"), miss(2, "warn")).criteria[TAPS]?.consecutiveFails).toBe(0);
    expect(apply(miss(0, "fail", "bonus"), miss(1, "fail", "bonus"), miss(2, "fail", "bonus")).criteria[TAPS]?.consecutiveFails ?? 0).toBe(0);
  });
});

describe("course complete", () => {
  it("latches once final-mix is passed and every criterion on its route is retained", () => {
    const route = FINAL_MIX_ROUTE.map((lessonId) => [`${lessonId}.only` as CriterionId, lessonId] as const);
    const passAll = route.map(([id, lessonId]) => result(lessonId, "lesson", 0, [[id, true]], `p-${lessonId}`));
    const retainAllButLast = route.slice(0, -1).map(([id, lessonId]) => result(lessonId, "cold", 20, [[id, true]], `c-${lessonId}`));
    const almost = apply(...passAll, ...retainAllButLast);

    expect(almost.courseCompletedAt).toBeNull();
    const [lastId, lastLesson] = route.at(-1) ?? ["final-mix.only", "final-mix"];
    const done = applyCheckResult(almost, result(lastLesson, "cold", 30, [[lastId, true]])).profile;
    expect(done.courseCompletedAt).toBe(iso(30));

    const lapsedLater = applyCheckResult(done, result("phrases", "cold", 200, [["phrases.only", false]])).profile;
    expect(lapsedLater.courseCompletedAt).toBe(iso(30));
  });
});
