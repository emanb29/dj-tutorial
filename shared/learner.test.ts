import { describe, expect, it } from "vitest";
import { applyCheckResult } from "@checks";
import type { CheckResult } from "./check-result.ts";
import { emptyLearnerRecord, withSkillProfile } from "./learner.ts";

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
