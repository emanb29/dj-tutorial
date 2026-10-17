import { describe, expect, it } from "vitest";
import { applyCheckResult } from "@checks";
import type { CheckResult } from "./check-result.ts";
import { CriterionIdSchema } from "./check-types.ts";
import { emptyLearnerRecord, LearnerRecordSchema, withHeadphonesChecked, withSkillProfile } from "./learner.ts";

describe("criterion ids in the Skill profile", () => {
  it("accepts the per-deck gain-staging criteria (trim-A, trim-B), so a gain-staging result can be saved", () => {
    expect(CriterionIdSchema.safeParse("gain-staging.trim-A").success).toBe(true);
    expect(CriterionIdSchema.safeParse("gain-staging.trim-B").success).toBe(true);
    expect(CriterionIdSchema.safeParse("gain-staging.Trim A").success).toBe(false);
    expect(CriterionIdSchema.safeParse("nope.trim-A").success).toBe(false);
  });
});

describe("the headphones check in the record", () => {
  it("is kept once passed, and a record from before it still loads", () => {
    const record = withHeadphonesChecked(emptyLearnerRecord("default"), "2026-10-17T10:00:00.000Z");
    expect(LearnerRecordSchema.parse(record).headphones).toEqual({ checkedAt: "2026-10-17T10:00:00.000Z" });
    const older: Record<string, unknown> = { ...record };
    delete older["headphones"];
    expect(LearnerRecordSchema.safeParse(older).success).toBe(true);
  });

  it("refuses a check time that is not a wall-clock time", () => {
    expect(LearnerRecordSchema.safeParse({ ...emptyLearnerRecord("default"), headphones: { checkedAt: "yesterday" } }).success).toBe(false);
  });
});

describe("withSkillProfile", () => {
  it("accepts a Skill profile written after a criterion with nothing to measure (fade in never heard)", () => {
    const record = emptyLearnerRecord("default");
    const result: CheckResult = {
      schemaVersion: 1,
      attemptId: "a1",
      learnerId: "default",
      lessonId: "deck-basics",
      mode: "lesson",
      variant: "full",
      startedAt: "2026-10-17T10:00:00.000Z",
      endedAt: "2026-10-17T10:00:20.000Z",
      inputDevice: "keyboard",
      endReason: "done",
      outcome: { kind: "failed", failedCriteria: ["deck-basics.fade-in"] },
      criteria: [
        {
          id: "deck-basics.fade-in",
          severity: "fail",
          status: "notMet",
          measured: null,
          unit: "bars",
          threshold: { op: "<=", value: 4, unit: "bars" },
          margin: null,
          evidence: [],
        },
      ],
      tracks: [],
      aids: { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: true },
      metrics: {},
    };
    const { profile } = applyCheckResult(record.skillProfile, result);
    const updated = withSkillProfile(record, profile);
    expect(updated).toMatchObject({ ok: true });
    expect(updated.ok && updated.record.skillProfile.criteria["deck-basics.fade-in"]?.last?.measured).toBeNull();
  });
});
