import { describe, expect, it } from "vitest";
import { CheckLineRequestSchema } from "@shared/coach-contract.ts";
import type { CheckResult, CriterionResult } from "@shared/check-result.ts";
import { checkLineRequest, describeCriterion, toCoachSummary } from "./coach.ts";

const fadeOut: CriterionResult = {
  id: "deck-basics.fade-out",
  severity: "fail",
  status: "notMet",
  measured: 0.4,
  unit: "position",
  threshold: { op: "<=", value: 0, unit: "position" },
  margin: -1,
  evidence: [],
};

const beatTaps: CriterionResult = {
  id: "beats-and-bars.beat-taps",
  severity: "fail",
  status: "met",
  measured: 0.9375,
  unit: "ratio",
  threshold: { op: ">=", value: 0.9, unit: "ratio" },
  margin: 0.04,
  evidence: [],
  detail: { matched: 30, extras: 1, targets: 32 },
};

const skipped: CriterionResult = { ...beatTaps, id: "standing.no-clip", status: "notApplicable", measured: null, margin: null };

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
  outcome: { kind: "failed", failedCriteria: ["deck-basics.fade-out"] },
  criteria: [fadeOut, beatTaps, skipped],
  tracks: [],
  aids: { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: true },
  metrics: { medianTapOffsetMs: 12 },
};

describe("toCoachSummary", () => {
  it("keeps what the Coach may see, in the units its contract knows", () => {
    expect(toCoachSummary(result)).toEqual({
      lessonId: "deck-basics",
      mode: "lesson",
      variant: "full",
      outcome: "failed",
      criteria: [
        { id: "deck-basics.fade-out", severity: "fail", status: "notMet", measured: 0.4, unit: "ratio", threshold: { op: "<=", value: 0, unit: "ratio" }, margin: -1 },
        { id: "beats-and-bars.beat-taps", severity: "fail", status: "met", measured: 0.9375, unit: "ratio", threshold: { op: ">=", value: 0.9, unit: "ratio" }, margin: 0.04 },
      ],
      metrics: { medianTapOffsetMs: 12 },
    });
  });

  it("builds a request the server accepts", () => {
    const request = checkLineRequest(result, { requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e", lessonTitle: "Play a track out loud", attemptToday: 2, recentLines: ["x"] });
    expect(CheckLineRequestSchema.safeParse(request).success).toBe(true);
  });
});

describe("describeCriterion", () => {
  it("says taps in plain words: how many landed and how many are needed", () => {
    expect(describeCriterion(beatTaps)).toBe("Beats: 30 of 32 on time (need 29), 1 extra");
  });

  it("says where the fader ended", () => {
    expect(describeCriterion(fadeOut)).toBe("Fade out: fader ended at 40% (needs 0%)");
  });
});
