import { describe, expect, expectTypeOf, it } from "vitest";
import type { RecordedAttempt } from "@audio";
import type { MeterFrame } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import type { GradedAttempt } from "./deck-controls.ts";
import { runCheck } from "./run-check.ts";
import { BLEND_WINDOW, LESSON_AIDS, attempt, blendScenario, event, spec, type BlendScenario } from "./testing/synthetic.ts";

function syncBlend(scenario: BlendScenario, degraded: boolean): CheckResult {
  const result = runCheck(spec({ lessonId: "sync-blend" }, BLEND_WINDOW, { aids: { ...LESSON_AIDS, sync: true } }), {
    ...blendScenario(scenario),
    degraded,
  });
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("degraded recordings", () => {
  it("grades the recorder's RecordedAttempt shape directly", () => {
    expectTypeOf<RecordedAttempt>().toExtend<GradedAttempt>();
  });

  it("keeps met measures, but does not count 'no violation' as met past the point the recorder dropped data", () => {
    // The last continuous move kept is A's fader at 56 s: moves after it may have been dropped.
    const result = syncBlend({}, true);

    expect(byId(result, "sync-blend.blend-length")?.status).toBe("met");
    expect(byId(result, "sync-blend.trim-untouched")).toMatchObject({
      status: "notApplicable",
      measured: null,
      detail: { keptMeasured: 0, recordingDegraded: 1 },
    });
    // A fail-severity criterion went ungraded, so the attempt cannot pass, yet nothing failed.
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: [] });
    expect(result.metrics).toMatchObject({ recordingDegraded: 1 });
    expect(syncBlend({}, false).outcome).toEqual({ kind: "passed" });
  });

  it("still fails a violation the recorder kept, from before the drop", () => {
    const result = syncBlend({ extraEvents: [event(40, "trim", -2, "B")] }, true);

    expect(byId(result, "sync-blend.trim-untouched")).toMatchObject({ status: "notMet", measured: 1 });
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["sync-blend.trim-untouched"] });
  });

  it("never fails a continuous measure on lost data: not graded", () => {
    const result = syncBlend({ outA: 200 }, true);

    expect(byId(result, "sync-blend.blend-length")).toMatchObject({ status: "notApplicable", detail: { recordingDegraded: 1 } });
    expect(syncBlend({ outA: 200 }, false).outcome).toMatchObject({ kind: "failed" });
  });

  it("dates the drop from the meters too, when their frames stop before the attempt ends", () => {
    const scenario = blendScenario({ extraEvents: [event(70, "trim", -2, "B")] });
    const cut = (frames: readonly MeterFrame[] | undefined) => (frames ?? []).filter((frame) => frame.ctx < 60);
    const result = runCheck(spec({ lessonId: "sync-blend" }, BLEND_WINDOW, { aids: { ...LESSON_AIDS, sync: true }, passedLessons: ["gain-staging"] }), {
      ...scenario,
      meters: { master: cut(scenario.meters.master), A: cut(scenario.meters.A), B: cut(scenario.meters.B) },
      degraded: true,
    });
    if (!("criteria" in result)) throw new Error("expected a graded result");

    // Clips cannot be ruled out after 60 s.
    expect(byId(result, "standing.no-clip")).toMatchObject({ status: "notApplicable", detail: { recordingDegraded: 1 } });
  });

  it("grades CUE-button criteria (no-recue, cued-first) as usual: buttons are never dropped", () => {
    const result = runCheck(
      spec({ lessonId: "sync-blend" }, BLEND_WINDOW, {
        mode: "cold",
        aids: { ...LESSON_AIDS, sync: true },
        passedLessons: ["gain-staging", "cut-on-phrase", "nudge-phase"],
      }),
      { ...blendScenario({ extraEvents: [event(40, "deckCue", 1, "B"), event(41, "deckCue", 1, "B")] }), degraded: true },
    );
    if (!("criteria" in result)) throw new Error("expected a graded result");

    expect(byId(result, "standing.no-recue")).toMatchObject({ status: "notMet", measured: 2 });
    expect(byId(result, "standing.cued-first")?.status).toBe("met");
  });

  it("still fails criteria read only from data the recorder always keeps (buttons, playheads)", () => {
    const result = runCheck(spec({ lessonId: "nudge-phase", phaseFrom: 4 }, { from: 0, to: 40 }, { aids: LESSON_AIDS }), {
      ...attempt({
        decks: {
          A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }] } },
          B: { trackId: "track-b", playhead: { segments: [{ fromCtx: 4, pos: 4, rate: 1 }] } },
        },
        events: [event(5, "deckCue", 1, "B"), event(6, "deckCue", 1, "B")],
      }),
      degraded: true,
    });

    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["nudge-phase.cue-presses"] });
  });
});
