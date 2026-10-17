import { describe, expect, it } from "vitest";
import type { CheckMode, TaskSpec } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, BLEND_WINDOW, LESSON_AIDS, blendScenario, engineCommand, event, spec, type BlendScenario } from "../testing/synthetic.ts";

/** Swap at A's phrase start 48 s (B in at 32 s, A out at 56 s). */
function swap(bUp = 48, aDown = 48): BlendScenario {
  return { initialB: { eqLowDb: -120 }, extraEvents: [event(bUp, "eqLow", 0, "B"), event(aDown, "eqLow", -120, "A")] };
}

function check(scenario: BlendScenario, mode: CheckMode = "lesson", overrides: Partial<TaskSpec> = {}): CheckResult {
  const result = runCheck(
    spec({ lessonId: "bass-swap" }, BLEND_WINDOW, {
      mode,
      variant: mode === "placement" ? "short" : "full",
      aids: { ...LESSON_AIDS, sync: true },
      ...overrides,
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

  it("pairs B's up-crossing with A's down-crossing nearest it, not an earlier EQ move on A", () => {
    const earlyCut = { ...swap(), extraEvents: [event(10, "eqLow", -120, "A"), event(12, "eqLow", 0, "A"), ...(swap().extraEvents ?? [])] };
    expect(byId(check(earlyCut), "bass-swap.swap-time")).toMatchObject({ status: "met", measured: 0 });
    // A's only down-crossing is long before the blend (more than 2 bars before the overlap): no swap.
    const onlyEarly = { initialB: { eqLowDb: -120 }, extraEvents: [event(10, "eqLow", -120, "A"), event(48, "eqLow", 0, "B")] };
    expect(byId(check(onlyEarly), "bass-swap.swap-time")).toMatchObject({ status: "notMet", measured: null });
  });

  it("fails the swap when the lows never cross", () => {
    expect(byId(check({ initialB: { eqLowDb: -120 } }), "bass-swap.swap-time")).toMatchObject({ status: "notMet", measured: null });
  });

  it("in Placement, also measures the credited sync-blend skills", () => {
    const result = check(swap(), "placement");

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "bass-swap.enter-low-cut",
      "bass-swap.swap-time",
      "bass-swap.clash-short",
      "sync-blend.blend-start",
      "sync-blend.blend-length",
      "sync-blend.loud-steady",
      "tempo-fader.tempo-matched",
    ]);
    expect(byId(check({ ...swap(), outA: 32 + 18 * BAR }, "placement"), "sync-blend.blend-length")?.status).toBe("notMet");
  });

  it("in Placement, measures tempo-fader only when the tempos started apart and SYNC stayed off", () => {
    // B plays 2% fast from 24 s and is matched by its tempo fader at 28 s, before it comes in at 32 s.
    const matchedByHand = { ...swap(), bSegments: [{ fromCtx: 24, pos: 0, rate: 1.02 }, { fromCtx: 28, pos: 4.08, rate: 1 }] };
    expect(byId(check(matchedByHand, "placement"), "tempo-fader.tempo-matched")).toMatchObject({ status: "met", measured: 0 });
    const unmatched = check({ ...swap(), bRate: 1.01 }, "placement");
    expect(byId(unmatched, "tempo-fader.tempo-matched")).toMatchObject({ status: "notMet" });
    expect(byId(unmatched, "tempo-fader.tempo-matched")?.measured).toBeCloseTo(1.2);

    // Same tempo from the start: nothing to match, so tempo-fader is not credited by this task.
    expect(byId(check(swap(), "placement"), "tempo-fader.tempo-matched")).toMatchObject({
      status: "notApplicable",
      detail: { tempoGapAtStartBpm: 0, syncUsed: 0 },
    });
    // SYNC did the matching: not a tempo-fader skill either.
    const synced = { ...matchedByHand, engineEvents: [engineCommand(27, "sync", "B", true)] };
    expect(byId(check(synced, "placement"), "tempo-fader.tempo-matched")).toMatchObject({ status: "notApplicable", detail: { syncUsed: 1 } });
    const syncedFromStart = check(matchedByHand, "placement", { syncedAtStart: ["B"] });
    expect(byId(syncedFromStart, "tempo-fader.tempo-matched")?.status).toBe("notApplicable");
  });
});
