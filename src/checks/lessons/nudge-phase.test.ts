import { describe, expect, it } from "vitest";
import type { CheckVariant, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, LESSON_AIDS, attempt, event, spec } from "../testing/synthetic.ts";

const PHASE_FROM = 4;
const WINDOW = { from: 0, to: 40 };

/** B starts `behindS` behind A at PHASE_FROM and is bent back at `bendRate` from 5 s. */
function bentBack(behindS: number, bendRate = 1.1): PlayheadSegment[] {
  const bendEnd = 5 + behindS / (bendRate - 1);
  return [
    { fromCtx: PHASE_FROM, pos: PHASE_FROM - behindS, rate: 1 },
    { fromCtx: 5, pos: 5 - behindS, rate: bendRate },
    { fromCtx: bendEnd, pos: bendEnd, rate: 1 },
  ];
}

function check(
  bSegments: readonly PlayheadSegment[],
  options: { variant?: CheckVariant; cuePresses?: readonly number[]; aids?: Partial<typeof LESSON_AIDS> } = {},
): CheckResult {
  const result = runCheck(
    spec({ lessonId: "nudge-phase", phaseFrom: PHASE_FROM }, WINDOW, {
      variant: options.variant ?? "full",
      aids: { ...LESSON_AIDS, phaseMeter: true, ...options.aids },
    }),
    attempt({
      decks: {
        A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }] } },
        B: { trackId: "track-b", playhead: { segments: bSegments } },
      },
      events: (options.cuePresses ?? []).map((ctx) => event(ctx, "deckCue", 1, "B")),
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("nudge-phase", () => {
  it("passes a ¼-beat error bent back within 4 bars and held for 8", () => {
    const result = check(bentBack(BEAT / 4));

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "nudge-phase.converge",
      "nudge-phase.hold",
      "nudge-phase.cue-presses",
    ]);
    // Error falls linearly from 125 ms at 5 s to 0 at 6.25 s: under 15 ms from 6.1 s, 2.1 s = 1.05 bars in.
    expect(byId(result, "nudge-phase.converge")?.measured).toBeCloseTo(2.1 / BAR, 1);
  });

  it("fails convergence later than 4 bars after the task starts", () => {
    // A slow bend: 125 ms at 1% takes 12.5 s, under 15 ms after 11 s + 5 s = 16 s, 6 bars in.
    expect(byId(check(bentBack(BEAT / 4, 1.01)), "nudge-phase.converge")?.status).toBe("notMet");
  });

  it("times the convergence from where the hold starts when the first nudge overshoots and comes back within 4 bars", () => {
    // 125 ms behind; bent forward past A to 35 ms ahead by 6.6 s, held there, then bent back into line by 8.85 s.
    const overshoot: PlayheadSegment[] = [
      { fromCtx: PHASE_FROM, pos: PHASE_FROM - 0.125, rate: 1 },
      { fromCtx: 5, pos: 4.875, rate: 1.1 },
      { fromCtx: 6.6, pos: 6.635, rate: 1 },
      { fromCtx: 8.5, pos: 8.535, rate: 0.9 },
      { fromCtx: 8.85, pos: 8.85, rate: 1 },
    ];
    const result = check(overshoot);

    expect(result.outcome).toEqual({ kind: "passed" });
    // Under 15 ms for good from about 8.7 s: 2.35 bars after the task starts.
    expect(byId(result, "nudge-phase.converge")?.measured).toBeCloseTo((8.7 - PHASE_FROM) / BAR, 1);
  });

  it("still fails an overshoot that never settles: the first crossing is reported", () => {
    const neverSettles: PlayheadSegment[] = [
      { fromCtx: PHASE_FROM, pos: PHASE_FROM - 0.125, rate: 1 },
      { fromCtx: 5, pos: 4.875, rate: 1.1 },
      { fromCtx: 6.6, pos: 6.635, rate: 1 },
    ];
    const result = check(neverSettles);

    expect(byId(result, "nudge-phase.converge")).toMatchObject({ status: "met" });
    expect(byId(result, "nudge-phase.hold")?.status).toBe("notMet");
  });

  it("fails a hold that drifts out again within 8 bars", () => {
    const drifting = [...bentBack(BEAT / 4), { fromCtx: 10, pos: 10, rate: 1.01 }];
    const result = check(drifting);

    expect(byId(result, "nudge-phase.converge")?.status).toBe("met");
    expect(byId(result, "nudge-phase.hold")?.status).toBe("notMet");
  });

  it("holds only 4 bars in the short form", () => {
    // In phase from 6.25 s; drifts from 6.1 + 4 bars + 1 s (≈ 15 s), so 8 bars fails but 4 bars passes.
    const drifting = [...bentBack(BEAT / 4), { fromCtx: 15.1, pos: 15.1, rate: 1.02 }];

    expect(byId(check(drifting), "nudge-phase.hold")?.status).toBe("notMet");
    expect(byId(check(drifting, { variant: "short" }), "nudge-phase.hold")?.status).toBe("met");
  });

  it("does not count a hold cut short by the attempt ending: missing time is not held", () => {
    const stopsEarly = [...bentBack(BEAT / 4), { fromCtx: 12, pos: 12, rate: 0 }];

    expect(byId(check(stopsEarly), "nudge-phase.hold")?.status).toBe("notMet");
  });

  it("allows one CUE press on B and fails two (re-cueing instead of nudging)", () => {
    expect(byId(check(bentBack(BEAT / 4), { cuePresses: [3] }), "nudge-phase.cue-presses")?.status).toBe("met");
    expect(byId(check(bentBack(BEAT / 4), { cuePresses: [3, 8] }), "nudge-phase.cue-presses")).toMatchObject({
      status: "notMet",
      measured: 2,
    });
  });

  it("refuses to grade with sync on: a Lesson-content bug, not a pass", () => {
    expect(() => check(bentBack(BEAT / 4), { aids: { sync: true } })).toThrow(/sync/);
  });
});
