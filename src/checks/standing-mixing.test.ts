import { describe, expect, it } from "vitest";
import { LESSON_IDS, type LessonId, type PlayheadSegment, type TaskSpec } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import type { CheckContext } from "./context.ts";
import type { EngineCommandRecord } from "./deck-commands.ts";
import { runCheck } from "./run-check.ts";
import { standingSeverity } from "./standing.ts";
import { drift } from "./standing-mixing.ts";
import {
  BAR,
  BEAT,
  BLEND_WINDOW,
  LESSON_AIDS,
  blendScenario,
  engineCommand,
  event,
  passedBefore,
  spec,
  type BlendScenario,
} from "./testing/synthetic.ts";

const SYNC_AIDS = { ...LESSON_AIDS, sync: true };

/** B in at 32 s with its lows cut, the lows swapped at 48 s, A out at 56 s. */
function swapped(overrides: BlendScenario = {}): BlendScenario {
  return { initialB: { eqLowDb: -120 }, extraEvents: [event(48, "eqLow", 0, "B"), event(48, "eqLow", -120, "A"), event(57, "eqLow", 0, "A")], ...overrides };
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
  const jog = (ctx: number): EngineCommandRecord[] => [engineCommand(ctx, "jog-bend", "B", 0.02), engineCommand(ctx + 0.3, "jog-bend", "B", 0)];

  it("warns on a jog bend on a deck synced from the start, without blocking the pass", () => {
    const result = cold("bass-swap", swapped({ engineEvents: jog(40) }), { spec: { syncedAtStart: ["B"] } });

    expect(byId(result, "standing.sync-kept")).toMatchObject({ severity: "warn", status: "notMet", measured: 1 });
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("follows SYNC on and off, including the engine dropping it and refused presses", () => {
    const engineEvents = [
      engineCommand(30, "sync", "B", true),
      ...jog(35), // synced: counted
      engineCommand(38, "sync", "B", false),
      ...jog(45), // off: not counted
      engineCommand(50, "sync", "B", true),
      engineCommand(52, "sync", "B", false, { byEngine: true }),
      ...jog(55), // the engine dropped sync: not counted
      engineCommand(60, "sync", "A", true, { rejected: true }),
      engineCommand(61, "jog-bend", "A", 0.02), // A's SYNC press was refused: not counted
    ];
    expect(byId(cold("bass-swap", swapped({ engineEvents })), "standing.sync-kept")?.measured).toBe(1);
  });

  it("counts one bend per jog turn, not per coalesced move", () => {
    const turn = [0.01, 0.02, 0.03, 0].map((value, index) => engineCommand(40 + index * 0.05, "jog-bend", "B", value));
    expect(byId(cold("bass-swap", swapped({ engineEvents: turn }), { spec: { syncedAtStart: ["B"] } }), "standing.sync-kept")?.measured).toBe(1);
  });

  it("applies only where the task offers sync, and never in final-mix", () => {
    const noSync = cold("bass-swap", swapped({ engineEvents: jog(40) }), { spec: { syncedAtStart: ["B"], aids: LESSON_AIDS } });
    expect(byId(noSync, "standing.sync-kept")).toBeUndefined();
    expect(standingSeverity("sync-kept", "final-mix")).toBeNull();
    expect(byId(cold("bass-swap", swapped(), { passedUpTo: "sync-blend" }), "standing.sync-kept")).toBeUndefined();
  });
});

describe("standing.controls-reset", () => {
  const eqLeft = (backAt: number | null): BlendScenario => ({
    extraEvents: [event(50, "eqLow", -120, "A"), ...(backAt === null ? [] : [event(backAt, "eqLow", 0, "A")])],
  });

  it("needs A's EQs back within ±1 dB within 1 bar of A going silent, once eq-basics is passed", () => {
    expect(byId(cold("sync-blend", eqLeft(56 + BAR)), "standing.controls-reset")).toMatchObject({ severity: "warn", status: "met", measured: 1 });
    expect(byId(cold("sync-blend", eqLeft(56 + BAR + 0.1)), "standing.controls-reset")?.status).toBe("notMet");
    expect(byId(cold("sync-blend", eqLeft(null)), "standing.controls-reset")).toMatchObject({ status: "notMet", measured: null });
    expect(byId(cold("sync-blend", eqLeft(null), { passedUpTo: "eq-basics" }), "standing.controls-reset")).toBeUndefined();
  });

  it("adds the CFX part only once filter-transition is passed", () => {
    const filterLeftOn = { engineEvents: [engineCommand(50, "filter", "A", 0.8)] };
    expect(byId(cold("sync-blend", filterLeftOn), "standing.controls-reset")?.status).toBe("met");
    expect(byId(cold("sync-blend", filterLeftOn, { passedUpTo: "nudge-phase" }), "standing.controls-reset")?.status).toBe("notMet");
    const filterBack = { engineEvents: [engineCommand(50, "filter", "A", 0.8), engineCommand(57, "filter", "A", 0.04)] };
    expect(byId(cold("sync-blend", filterBack, { passedUpTo: "nudge-phase" }), "standing.controls-reset")?.status).toBe("met");
  });
});

describe("standing.one-bass", () => {
  const clash = (aDown: number): BlendScenario => ({
    initialB: { eqLowDb: -120 },
    extraEvents: [event(48, "eqLow", 0, "B"), event(aDown, "eqLow", -120, "A"), event(57, "eqLow", 0, "A")],
  });

  it("warns past 1 beat of bass clash in a blend, once blend-by-ear is passed", () => {
    expect(byId(cold("bass-swap", clash(48 + BEAT), { passedUpTo: "hot-cues" }), "standing.one-bass")).toMatchObject({
      severity: "warn",
      status: "met",
      measured: 1,
    });
    expect(byId(cold("bass-swap", clash(48 + BEAT + 0.04), { passedUpTo: "hot-cues" }), "standing.one-bass")?.status).toBe("notMet");
    expect(byId(cold("bass-swap", clash(48 + BEAT + 0.04)), "standing.one-bass")).toBeUndefined();
  });

  it("does not grade an overlap shorter than 4 bars: that is a cut, not a blend", () => {
    expect(byId(cold("bass-swap", { ...clash(48), inB: 32, outA: 32 + 3 * BAR }, { passedUpTo: "hot-cues" }), "standing.one-bass")?.status).toBe(
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
        ...blendScenario(),
        decks: { A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }] } }, B: { trackId: "track-b", playhead: { segments } } },
        engineEvents: [engineCommand(8, "tempo", "B", -0.05), engineCommand(12, "tempo", "B", 0), engineCommand(30, "jog-bend", "B", 0.03), engineCommand(30.02, "jog-bend", "B", 0)],
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
