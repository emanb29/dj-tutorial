import { describe, expect, it } from "vitest";
import { LESSON_IDS, type ControlEvent, type LessonId, type PlayheadSegment, type TaskSpec } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import type { CheckContext } from "./context.ts";
import { runCheck } from "./run-check.ts";
import { standingSeverity } from "./standing.ts";
import { drift } from "./standing-mixing.ts";
import {
  BAR,
  BEAT,
  BLEND_WINDOW,
  LESSON_AIDS,
  blendScenario,
  byEngine,
  event,
  passedBefore,
  spec,
  type BlendScenario,
} from "./testing/synthetic.ts";

const SYNC_AIDS = { ...LESSON_AIDS, sync: true };

/** B in at 32 s with its lows cut, the lows swapped at 48 s, A out at 56 s; `moves` are merged in. */
function swapped(overrides: BlendScenario = {}, moves: readonly ControlEvent[] = []): BlendScenario {
  return {
    initialB: { eqLowDb: -120 },
    extraEvents: [event(48, "eqLow", 0, "B"), event(48, "eqLow", -120, "A"), event(57, "eqLow", 0, "A"), ...moves],
    ...overrides,
  };
}

function cold(
  lessonId: "bass-swap" | "sync-blend",
  scenario: BlendScenario,
  options: { passedUpTo?: LessonId; spec?: Partial<TaskSpec> } = {},
): CheckResult {
  const result = runCheck(
    spec({ lessonId }, BLEND_WINDOW, {
      mode: "warmup",
      variant: "short",
      aids: SYNC_AIDS,
      passedLessons: passedBefore(LESSON_IDS, options.passedUpTo ?? "filter-transition"),
      ...options.spec,
    }),
    blendScenario(scenario),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("standing.sync-kept", () => {
  const jog = (ctx: number): ControlEvent[] => [event(ctx, "jogBend", 0.02, "B"), event(ctx + 0.3, "jogBend", 0, "B")];

  it("warns on a jog bend on a deck synced from the start, without blocking the pass", () => {
    const result = cold("bass-swap", swapped({ syncedAtStart: ["B"] }, jog(40)));

    expect(byId(result, "standing.sync-kept")).toMatchObject({ severity: "warn", status: "notMet", measured: 1 });
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("follows SYNC on and off, including the engine dropping it", () => {
    const moves = [
      event(30, "sync", 1, "B"),
      ...jog(35), // synced: counted
      event(38, "sync", 0, "B"),
      ...jog(45), // off: not counted
      event(50, "sync", 1, "B"),
      byEngine(52, "sync", 0, "B"),
      ...jog(55), // the engine dropped sync: not counted
      event(61, "jogBend", 0.02, "A"), // A never had SYNC on (a refused press is not in the timeline): not counted
    ];
    expect(byId(cold("bass-swap", swapped({}, moves)), "standing.sync-kept")?.measured).toBe(1);
  });

  it("counts one bend per jog turn, not per coalesced move", () => {
    const turn = [0.01, 0.02, 0.03, 0].map((value, index) => event(40 + index * 0.05, "jogBend", value, "B"));
    expect(byId(cold("bass-swap", swapped({ syncedAtStart: ["B"] }, turn)), "standing.sync-kept")?.measured).toBe(1);
  });

  it("applies only where the task offers sync, and never in final-mix", () => {
    const noSync = cold("bass-swap", swapped({ syncedAtStart: ["B"] }, jog(40)), { spec: { aids: LESSON_AIDS } });
    expect(byId(noSync, "standing.sync-kept")).toBeUndefined();
    expect(standingSeverity("sync-kept", "final-mix")).toBeNull();
    expect(byId(cold("bass-swap", swapped(), { passedUpTo: "sync-blend" }), "standing.sync-kept")).toBeUndefined();
  });
});

describe("standing.controls-reset", () => {
  const eqLeft = (backAt: number | null): BlendScenario => ({
    extraEvents: [event(50, "eqLow", -120, "A"), ...(backAt === null ? [] : [event(backAt, "eqLow", 0, "A")])],
  });

  it("needs A's EQs back within ±1 dB before A can be heard again (here: by the window's end), once eq-basics is passed", () => {
    // A goes silent at 56 s and stays out; the window ends at 96 s. Measured: bars past that deadline.
    expect(byId(cold("sync-blend", eqLeft(56 + 3 * BAR)), "standing.controls-reset")).toMatchObject({ severity: "warn", status: "met", measured: -17 });
    expect(byId(cold("sync-blend", eqLeft(95)), "standing.controls-reset")?.status).toBe("met");
    expect(byId(cold("sync-blend", eqLeft(null)), "standing.controls-reset")).toMatchObject({ status: "notMet", measured: null });
    expect(byId(cold("sync-blend", eqLeft(null), { passedUpTo: "eq-basics" }), "standing.controls-reset")).toBeUndefined();
  });

  it("fails A's EQ still cut when A's fader brings it back in", () => {
    const reopened = (backAt: number): BlendScenario => ({
      ...eqLeft(backAt),
      faderEvents: [event(32, "channelFader", 1, "B"), event(56, "channelFader", 0, "A"), event(70, "channelFader", 1, "A")],
    });
    expect(byId(cold("sync-blend", reopened(69)), "standing.controls-reset")?.status).toBe("met");
    expect(byId(cold("sync-blend", reopened(72)), "standing.controls-reset")).toMatchObject({ status: "notMet", measured: expect.closeTo(1, 1) as number });
  });

  it("adds the CFX part only once filter-transition is passed", () => {
    const filterLeftOn = { extraEvents: [event(50, "filter", 0.8, "A")] };
    expect(byId(cold("sync-blend", filterLeftOn), "standing.controls-reset")?.status).toBe("met");
    expect(byId(cold("sync-blend", filterLeftOn, { passedUpTo: "nudge-phase" }), "standing.controls-reset")?.status).toBe("notMet");
    const filterBack = { extraEvents: [event(50, "filter", 0.8, "A"), event(57, "filter", 0.04, "A")] };
    expect(byId(cold("sync-blend", filterBack, { passedUpTo: "nudge-phase" }), "standing.controls-reset")?.status).toBe("met");
  });

  it("counts from A's fader closing, not from a high-pass that thinned A under the audible line first", () => {
    // The channel meter reads after the filter: from 50 s A is a whisper, but its fader closes at 56 s.
    const filteredOut = {
      extraEvents: [event(46, "filter", 0.5, "A"), event(50, "filter", 0.85, "A"), event(57, "filter", 0, "A")],
      aLevels: (t: number) => (t >= 50 ? { peak: -30, momentary: -45 } : { peak: -3, momentary: -14 }),
    };
    // Silent from 56 s, not 50 s: had it counted from 50 s, A would read as reopened… it is the fader that counts.
    expect(byId(cold("sync-blend", filteredOut, { passedUpTo: "nudge-phase" }), "standing.controls-reset")).toMatchObject({ status: "met", evidence: [{ from: 56, to: 57 }] });
  });
});

describe("standing.level-match", () => {
  const level = (shortTerm: number) => ({ peak: -3, momentary: shortTerm, shortTerm });

  it("compares the two tracks as their trims set them: before A's filter or EQ moves, after B's are centred", () => {
    // A high-passed out from 40 s; B unfiltered at A's earlier level.
    const filterOut = cold("sync-blend", {
      extraEvents: [event(40, "filter", 0.3, "A"), event(50, "filter", 0.85, "A"), event(57, "filter", 0, "A")],
      aLevels: (t) => level(t >= 40 ? -32 : -14),
    });
    expect(byId(filterOut, "standing.level-match")).toMatchObject({ status: "met" });
    expect(byId(filterOut, "standing.level-match")?.measured).toBeCloseTo(0);
    // A bass swap: B comes in with its LOW cut and A leaves with its LOW cut.
    const bassSwap = cold("bass-swap", swapped({ aLevels: (t) => level(t >= 48 ? -30 : -14), bLevels: (t) => level(t >= 48 ? -14 : -21) }));
    expect(byId(bassSwap, "standing.level-match")?.measured).toBeCloseTo(0);
  });

  it("still catches two tracks trimmed apart", () => {
    const apart = cold("bass-swap", swapped({ aLevels: (t) => level(t >= 48 ? -30 : -14), bLevels: (t) => level(t >= 48 ? -10 : -17) }));
    expect(byId(apart, "standing.level-match")).toMatchObject({ status: "notMet" });
    expect(byId(apart, "standing.level-match")?.measured).toBeCloseTo(4);
  });
});

describe("standing.one-bass", () => {
  const clash = (aDown: number): BlendScenario => ({
    initialB: { eqLowDb: -120 },
    extraEvents: [event(48, "eqLow", 0, "B"), event(aDown, "eqLow", -120, "A"), event(57, "eqLow", 0, "A")],
  });

  it("warns past 1 beat of bass clash in a blend, once blend-by-ear is passed", () => {
    expect(byId(cold("bass-swap", clash(48 + BEAT), { passedUpTo: "final-mix" }), "standing.one-bass")).toMatchObject({
      severity: "warn",
      status: "met",
      measured: 1,
    });
    expect(byId(cold("bass-swap", clash(48 + BEAT + 0.04), { passedUpTo: "final-mix" }), "standing.one-bass")?.status).toBe("notMet");
    expect(byId(cold("bass-swap", clash(48 + BEAT + 0.04)), "standing.one-bass")).toBeUndefined();
  });

  it("does not grade an overlap shorter than 4 bars: that is a cut, not a blend", () => {
    expect(byId(cold("bass-swap", { ...clash(48), inB: 32, outA: 32 + 3 * BAR }, { passedUpTo: "final-mix" }), "standing.one-bass")?.status).toBe(
      "notApplicable",
    );
  });
});

describe("standing.drift", () => {
  it("applies only in final-mix, where it fails the Check", () => {
    expect(standingSeverity("drift", "blend-by-ear")).toBeNull();
    expect(standingSeverity("drift", "final-mix")).toBe("fail");
    expect(byId(cold("bass-swap", swapped(), { passedUpTo: "final-mix" }), "standing.drift")).toBeUndefined();
  });

  it("fails a blend over 60 ms for more than 1 bar", () => {
    const bSegments = (holdUntil: number): PlayheadSegment[] => [
      { fromCtx: 32, pos: 0, rate: 1 },
      { fromCtx: 40, pos: 8, rate: 1.1 },
      { fromCtx: 40.65, pos: 8.715, rate: 1 },
      { fromCtx: holdUntil, pos: 8.715 + (holdUntil - 40.65), rate: 0.9 },
      { fromCtx: holdUntil + 0.65, pos: 8.715 + (holdUntil - 40.65) + 0.585, rate: 1 },
    ];
    const contextFor = (holdUntil: number): CheckContext => {
      const taskSpec = spec({ lessonId: "blend-by-ear" }, BLEND_WINDOW, { aids: { ...LESSON_AIDS, bpmDisplay: false } });
      return { spec: taskSpec, attempt: blendScenario({ outA: 32 + 18 * BAR, bSegments: bSegments(holdUntil) }), window: BLEND_WINDOW, lessonId: "final-mix" };
    };
    expect(drift(contextFor(42.75), "fail")).toMatchObject({ id: "standing.drift", status: "notMet" });
    expect(drift(contextFor(42.45), "fail")).toMatchObject({ status: "met" });
  });
});

describe("standing.overcorrect", () => {
  it("reports tempo-fader reversals and the largest bend once tempo-by-ear is passed, never blocking", () => {
    const segments: PlayheadSegment[] = [
      { fromCtx: 4, pos: 4, rate: 1.02 },
      { fromCtx: 8, pos: 8.08, rate: 0.995 },
      { fromCtx: 12, pos: 12, rate: 1 },
    ];
    const result = runCheck(
      spec({ lessonId: "tempo-by-ear", matchFrom: 4 }, { from: 0, to: 60 }, {
        mode: "cold",
        aids: { ...LESSON_AIDS, bpmDisplay: false },
        passedLessons: passedBefore(LESSON_IDS, "blend-by-ear"),
      }),
      {
        ...blendScenario({ extraEvents: [event(8, "tempo", 0.995, "B"), event(12, "tempo", 1, "B"), event(30, "jogBend", 0.03, "B"), event(30.02, "jogBend", 0, "B")] }),
        decks: { A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }] } }, B: { trackId: "track-b", playhead: { segments } } },
      },
    );
    if (!("criteria" in result)) throw new Error("expected a graded result");

    expect(byId(result, "standing.overcorrect")).toMatchObject({
      severity: "report",
      status: "met",
      measured: 1,
      threshold: null,
      detail: { tempoReversals: 1, maxBendPercent: 3 },
    });
    expect(result.outcome).toEqual({ kind: "passed" });
  });
});
