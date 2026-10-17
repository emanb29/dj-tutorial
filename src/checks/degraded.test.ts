import { describe, expect, expectTypeOf, it } from "vitest";
import type { RecordedAttempt } from "@audio";
import type { CheckResult } from "@shared/check-result.ts";
import type { GradedAttempt } from "./deck-commands.ts";
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

  it("grades a degraded attempt as usual when every criterion is met", () => {
    const result = syncBlend({}, true);

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.metrics).toMatchObject({ recordingDegraded: 1 });
  });

  it("never fails a continuous-control criterion on lost data: not graded, and the attempt cannot pass", () => {
    const result = syncBlend({ extraEvents: [event(40, "trim", -2, "B")] }, true);

    expect(byId(result, "sync-blend.trim-untouched")).toMatchObject({
      status: "notApplicable",
      measured: null,
      margin: null,
      detail: { keptMeasured: 1, recordingDegraded: 1 },
    });
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: [] });
    // The same attempt fully recorded fails on that criterion.
    expect(syncBlend({ extraEvents: [event(40, "trim", -2, "B")] }, false).outcome).toEqual({
      kind: "failed",
      failedCriteria: ["sync-blend.trim-untouched"],
    });
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
