import { describe, expect, it } from "vitest";
import type { CheckMode } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BEAT, BLEND_WINDOW, LESSON_AIDS, blendScenario, event, spec, type BlendScenario } from "../testing/synthetic.ts";

/** Swap at A's phrase start 48 s (B in at 32 s, A out at 56 s). */
function swap(bUp = 48, aDown = 48): BlendScenario {
  return { initialB: { eqLowDb: -120 }, extraEvents: [event(bUp, "eqLow", 0, "B"), event(aDown, "eqLow", -120, "A")] };
}

function check(scenario: BlendScenario, mode: CheckMode = "lesson"): CheckResult {
  const result = runCheck(
    spec({ lessonId: "bass-swap" }, BLEND_WINDOW, {
      mode,
      variant: mode === "placement" ? "short" : "full",
      aids: { ...LESSON_AIDS, sync: true },
    }),
    blendScenario(scenario),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("bass-swap", () => {
  it("passes B entering with its lows cut and a clean swap on A's phrase start", () => {
    const result = check(swap());

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "bass-swap.enter-low-cut",
      "bass-swap.swap-time",
      "bass-swap.clash-short",
    ]);
    expect(byId(result, "bass-swap.clash-short")?.measured).toBe(0);
  });

  it("needs B's LOW at or below −20 dB when it comes in", () => {
    expect(byId(check({ ...swap(), initialB: { eqLowDb: -20 } }), "bass-swap.enter-low-cut")?.status).toBe("met");
    expect(byId(check({ ...swap(), initialB: { eqLowDb: -19 } }), "bass-swap.enter-low-cut")?.status).toBe("notMet");
  });

  it("allows both basslines together for 1 beat in total and fails beyond", () => {
    expect(byId(check(swap(48, 48 + BEAT)), "bass-swap.clash-short")).toMatchObject({ status: "met", measured: 1 });
    expect(byId(check(swap(48, 48 + BEAT + 0.02)), "bass-swap.clash-short")?.status).toBe("notMet");
  });

  it("counts clash only while both decks are audible", () => {
    // A's lows stay up, but A is gone at 56 s; B's lows came up at 55.5 s: 1 beat of clash.
    expect(byId(check(swap(56 - BEAT, 90)), "bass-swap.clash-short")).toMatchObject({ status: "met" });
    expect(byId(check(swap(56 - BEAT, 90)), "bass-swap.clash-short")?.measured).toBeCloseTo(1, 1);
  });

  it("times the swap as the mean of the two −6 dB crossings, within 1 beat of a phrase start", () => {
    expect(byId(check(swap(48 + BEAT, 48 + BEAT)), "bass-swap.swap-time")?.status).toBe("met");
    expect(byId(check(swap(48 + 2 * BEAT, 48 + 2 * BEAT)), "bass-swap.swap-time")).toMatchObject({ status: "notMet", measured: 2 });
    expect(byId(check(swap(48 - 0.5, 48 + 0.5)), "bass-swap.swap-time")?.measured).toBeCloseTo(0);
  });

  it("fails the swap when the lows never cross", () => {
    expect(byId(check({ initialB: { eqLowDb: -120 } }), "bass-swap.swap-time")).toMatchObject({ status: "notMet", measured: null });
  });

  it("in Placement, also measures the credited sync-blend and tempo-fader skills", () => {
    const result = check(swap(), "placement");

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "bass-swap.enter-low-cut",
      "bass-swap.swap-time",
      "bass-swap.clash-short",
      "sync-blend.blend-start",
      "sync-blend.loud-steady",
      "tempo-fader.tempo-matched",
    ]);
    const unmatched = check({ ...swap(), bRate: 1.01 }, "placement");
    expect(byId(unmatched, "tempo-fader.tempo-matched")).toMatchObject({ status: "notMet" });
    expect(byId(unmatched, "tempo-fader.tempo-matched")?.measured).toBeCloseTo(1.2);
  });
});
