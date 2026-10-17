import { describe, expect, it } from "vitest";
import type { CheckVariant, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BLEND_WINDOW, LESSON_AIDS, blendScenario, event, ramp, spec, type BlendScenario } from "../testing/synthetic.ts";

const BY_EAR_AIDS = { ...LESSON_AIDS, bpmDisplay: false, phaseMeter: false };

/** B from 32 s at track 0 (in phase with A), changing rate at each `[ctx, rate]`; positions stay continuous. */
function bRates(changes: readonly (readonly [number, number])[]): PlayheadSegment[] {
  const segments: PlayheadSegment[] = [{ fromCtx: 32, pos: 0, rate: 1 }];
  for (const [fromCtx, rate] of changes) {
    const last = segments.at(-1) ?? { fromCtx: 32, pos: 0, rate: 1 };
    segments.push({ fromCtx, pos: last.pos + last.rate * (fromCtx - last.fromCtx), rate });
  }
  return segments;
}

/** An 18-bar blend from 32 s, swapping the bass at 48 s. */
function blend(overrides: BlendScenario = {}): BlendScenario {
  return {
    outA: 32 + 18 * BAR,
    initialB: { eqLowDb: -120 },
    extraEvents: [event(48, "eqLow", 0, "B"), event(48, "eqLow", -120, "A")],
    ...overrides,
  };
}

function check(scenario: BlendScenario, variant: CheckVariant = "full"): CheckResult {
  const result = runCheck(spec({ lessonId: "blend-by-ear" }, BLEND_WINDOW, { variant, aids: BY_EAR_AIDS }), blendScenario(scenario));
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("blend-by-ear", () => {
  it("passes an 18-bar blend held in phase with a clean bass swap", () => {
    const result = check(blend());

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.aids).toMatchObject({ sync: false, bpmDisplay: false, phaseMeter: false });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "blend-by-ear.blend-length",
      "blend-by-ear.phase-hold",
      "blend-by-ear.swap-time",
      "blend-by-ear.clash-short",
      "blend-by-ear.loud-steady",
    ]);
  });

  it("needs at least 16 bars − 1 beat (8 bars − 1 beat in the short form)", () => {
    expect(byId(check(blend({ outA: 32 + 15.75 * BAR })), "blend-by-ear.blend-length")?.status).toBe("met");
    expect(byId(check(blend({ outA: 32 + 15.5 * BAR })), "blend-by-ear.blend-length")?.status).toBe("notMet");
    expect(byId(check(blend({ outA: 32 + 8 * BAR }), "short"), "blend-by-ear.blend-length")?.status).toBe("met");
  });

  it("passes a 17-bar blend whose outgoing fader is dragged slowly: the blend lasts until A is not audible", () => {
    // A's fader dragged down at 50 Hz from 60 s (14 bars in); it drops under −24 dB at about 66 s, 17 bars in.
    const result = check(blend({ faderEvents: [event(32, "channelFader", 1, "B"), ...ramp("channelFader", "A", { from: 60, to: 68 }, 1, 0)] }));
    expect(byId(result, "blend-by-ear.blend-length")?.measured).toBeCloseTo(17, 1);
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("fails drift over 60 ms for more than 1 bar, even with the hold fraction met", () => {
    // Out by 65 ms at 40.65 s, held there, then bent back: over 60 ms for 2.2 s (> 1 bar of 2 s).
    const drifted = check(blend({ bSegments: bRates([[40, 1.1], [40.65, 1], [42.75, 0.9], [43.4, 1]]) }));
    expect(byId(drifted, "blend-by-ear.phase-hold")).toMatchObject({ status: "notMet" });
    expect(byId(drifted, "blend-by-ear.phase-hold")?.measured).toBeGreaterThanOrEqual(0.85);
    expect(drifted.outcome).toMatchObject({ kind: "failed", failedCriteria: ["blend-by-ear.phase-hold"] });

    // The same excursion 0.3 s shorter: over 60 ms for 1.9 s, within a bar.
    const recovered = check(blend({ bSegments: bRates([[40, 1.1], [40.65, 1], [42.45, 0.9], [43.1, 1]]) }));
    expect(byId(recovered, "blend-by-ear.phase-hold")?.status).toBe("met");
  });

  it("fails a blend under 25 ms for less than 85% of the overlap", () => {
    // 30 ms out (but never over 60) from 40 s to the end of the blend.
    const offset = check(blend({ bSegments: bRates([[40, 1.1], [40.3, 1]]) }));
    expect(byId(offset, "blend-by-ear.phase-hold")).toMatchObject({ status: "notMet" });
  });

  it("refuses to grade with the BPM display or phase meter shown", () => {
    expect(() =>
      runCheck(spec({ lessonId: "blend-by-ear" }, BLEND_WINDOW, { aids: { ...BY_EAR_AIDS, phaseMeter: true } }), blendScenario(blend())),
    ).toThrow(/phaseMeter/);
  });
});
