import { describe, expect, it } from "vitest";
import { applyCheckResult } from "@checks";
import type { CheckResult } from "./check-result.ts";
import { CriterionIdSchema } from "./check-types.ts";
import { emptyLearnerRecord, LearnerRecordSchema, withHeadphonesChecked, withOutsidePractice, withSkillProfile } from "./learner.ts";
import { OUTSIDE_PRACTICE_KEPT, type OutsidePractice } from "./outside-practice.ts";

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

describe("outside practice in the record (ISS-96)", () => {
  const AT = "2026-10-18T09:00:00.000Z";
  const tally = { met: 1, of: 1 };
  const entry = (id: string): OutsidePractice => ({
    id,
    kind: "mix-recording",
    gradedAt: AT,
    durationSec: 1200,
    transitions: 6,
    blends: 4,
    clean: false,
    checks: { onPhrase: { met: 5, of: 6 }, drift: { met: 3, of: 4 }, levels: tally, clipping: tally, deadAir: tally, oneBass: { met: 4, of: 4 } },
  });

  it("is absent in records from before it, and they still load", () => {
    const older = emptyLearnerRecord("default");
    expect("outsidePractice" in older).toBe(false);
    expect(LearnerRecordSchema.safeParse(older).success).toBe(true);
  });

  it("keeps a graded mix, and only the newest 12", () => {
    const one = withOutsidePractice(emptyLearnerRecord("default"), entry("m0"));
    expect(one.ok && one.record.outsidePractice?.map((kept) => kept.id)).toEqual(["m0"]);
    let record = emptyLearnerRecord("default");
    for (let i = 0; i < OUTSIDE_PRACTICE_KEPT + 3; i++) {
      const next = withOutsidePractice(record, entry(`m${String(i)}`));
      if (!next.ok) throw new Error(next.issues.join("; "));
      record = next.record;
    }
    expect(record.outsidePractice).toHaveLength(OUTSIDE_PRACTICE_KEPT);
    expect(record.outsidePractice?.at(-1)?.id).toBe(`m${String(OUTSIDE_PRACTICE_KEPT + 2)}`);
    // Twelve of them stay far under the server's 32 KB body limit (server/app.ts MAX_BODY_BYTES).
    expect(JSON.stringify(record.outsidePractice).length).toBeLessThan(6 * 1024);
  });

  it("refuses an entry with a made-up check, more met than judged, or no wall-clock time, saying where", () => {
    const base = emptyLearnerRecord("default");
    const good = entry("m");
    const extraCheck = { ...good, checks: { ...good.checks, keyClash: tally } };
    const overMet = { ...good, checks: { ...good.checks, drift: { met: 5, of: 4 } } };
    const badTime = { ...good, gradedAt: "today" };
    for (const bad of [extraCheck, overMet, badTime]) {
      expect(LearnerRecordSchema.safeParse({ ...base, outsidePractice: [bad] }).success).toBe(false);
    }
    const refused = withOutsidePractice(base, overMet);
    expect(refused.ok ? [] : refused.issues).toEqual([expect.stringContaining("outsidePractice.0.checks.drift")]);
    const tooMany = Array.from({ length: OUTSIDE_PRACTICE_KEPT + 1 }, (_, i) => entry(`m${String(i)}`));
    expect(LearnerRecordSchema.safeParse({ ...base, outsidePractice: tooMany }).success).toBe(false);
  });
});
