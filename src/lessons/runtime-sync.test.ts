// The runtime for Lessons 8–11: hook triggers and practice reps for the tempo fader, SYNC, the
// crossfader and EQ.
import { describe, expect, it } from "vitest";
import { lessonDefinition } from "./catalogue.ts";
import { initialLessonState, lessonReducer, type LessonEvent, type LessonState } from "./runtime.ts";
import type { CheckResult, CriterionResult } from "@shared/check-result.ts";
import type { LessonDefinition, Observation } from "./types.ts";

function run(definition: LessonDefinition, events: readonly LessonEvent[], from?: LessonState): LessonState {
  const start = from ?? initialLessonState(definition.id as Parameters<typeof initialLessonState>[0]);
  return events.reduce(lessonReducer(definition), start);
}

const seen = (observation: Observation): LessonEvent => ({ type: "observed", observation });
const ready: LessonEvent = { type: "track-ready" };
const skip: LessonEvent = { type: "skip-hook" };

/** A graded sync-blend result that failed only `id`. */
function failedOn(id: CriterionResult["id"]): CheckResult {
  const criterion = (criterionId: CriterionResult["id"], met: boolean): CriterionResult => ({
    id: criterionId,
    severity: "fail",
    status: met ? "met" : "notMet",
    measured: met ? 1 : 5.7,
    unit: "dB",
    threshold: { op: "<=", value: 3, unit: "dB" },
    margin: met ? 2 : -2.7,
    evidence: [],
  });
  return {
    schemaVersion: 1,
    attemptId: "a1",
    learnerId: "default",
    lessonId: "sync-blend",
    mode: "lesson",
    variant: "full",
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: "2026-10-17T10:01:00.000Z",
    inputDevice: "trackpad",
    endReason: "done",
    outcome: { kind: "failed", failedCriteria: [id] },
    criteria: [criterion("sync-blend.blend-start", true), criterion(id, false)],
    tracks: [],
    aids: { sync: true, quantize: false, bpmDisplay: true, phaseMeter: false, lessonText: true },
    metrics: {},
  };
}

const graded = (outcome: CheckResult): LessonEvent => ({
  type: "graded",
  result: outcome,
  reviewTriggers: [],
  firstPass: false,
  lineFacts: { focusHistory: [], bestMarginBefore: null, retentionChange: null },
});

describe("tempo-fader", () => {
  const definition = lessonDefinition("tempo-fader");

  it("steps through TEMPO B (made fast, to hear it go higher), MASTER TEMPO B and the range", () => {
    const hooked = run(definition, [ready, seen({ kind: "touch", control: "B.tempo" }), seen({ kind: "tempo", deck: "A", percent: 6 })]);
    // A nudge is not enough to hear the pitch rise: the first step waits for B 4% faster or more.
    expect(run(definition, [seen({ kind: "tempo", deck: "B", percent: 1.2 }), seen({ kind: "tempo", deck: "B", percent: -5 })], hooked).phase).toMatchObject({ kind: "hook", step: 0 });
    const fast = run(definition, [seen({ kind: "tempo", deck: "B", percent: 4 })], hooked);
    expect(fast.phase).toMatchObject({ kind: "hook", step: 1, named: "TEMPO: faster, and higher. The BPM shows it." });
    const state = run(definition, [seen({ kind: "touch", control: "B.master-tempo" }), seen({ kind: "touch", control: "B.tempo-range" })], fast);
    expect(state.phase).toMatchObject({ kind: "practice", named: "Range: ±6% is fine, ±16% is wide." });
  });

  it("is ready after two Readies on the target BPM out of three", () => {
    const practising = run(definition, [ready, skip]);
    const set = (onTarget: boolean) => seen({ kind: "tempo-set", onTarget });
    expect(run(definition, [set(true), set(false)], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [set(true), set(false), set(true)], practising).phase).toMatchObject({ ready: true });
  });
});

describe("sync-blend", () => {
  const definition = lessonDefinition("sync-blend");

  it("moves on when SYNC turns on for B, not for A, and not when it turns off", () => {
    const hooked = run(definition, [ready, seen({ kind: "sync", deck: "A", on: true }), seen({ kind: "sync", deck: "B", on: false })]);
    expect(hooked.phase).toMatchObject({ kind: "hook", step: 0 });
    expect(run(definition, [seen({ kind: "sync", deck: "B", on: true })], hooked).phase).toMatchObject({ kind: "hook", step: 1 });
  });

  const step = (index: number, good = true, mistake: string | null = null) => seen({ kind: "blend-step", step: index, good, mistake });

  it("ends the hook when B and then A are at ¾ (the stepped blend's second step)", () => {
    const hooked = run(definition, [ready, seen({ kind: "sync", deck: "B", on: true }), seen({ kind: "play", deck: "B", playing: true })]);
    expect(run(definition, [step(0)], hooked).phase).toMatchObject({ kind: "hook", step: 2 });
    expect(run(definition, [step(0), step(1)], hooked).phase).toMatchObject({ kind: "practice", named: "Both at ¾: a blend. Then B up, A down." });
  });

  it("is ready once all four steps are made in order; a missed step says why at once", () => {
    const practising = run(definition, [ready, skip]);
    expect(run(definition, [step(0), step(1), step(2)], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [step(0), step(1), step(2), step(3)], practising).phase).toMatchObject({ ready: true });
    const tooLoud = run(definition, [step(0), step(1, false, "Both faders full: +3 dB louder. Stop B at ¾ first.")], practising);
    expect(tooLoud.phase).toMatchObject({ ready: false, named: "Both faders full: +3 dB louder. Stop B at ¾ first." });
  });

  it("explains the +3 dB after a second blend that was too loud (both faders full)", () => {
    const loud = graded(failedOn("sync-blend.loud-steady"));
    const once = run(definition, [ready, skip, { type: "start-check" }, { type: "audio-ended" }, loud]);
    expect(once.phase).toMatchObject({ kind: "result", tip: null });
    const twice = run(definition, [{ type: "practice-again" }, { type: "start-check" }, { type: "audio-ended" }, loud], once);
    expect(twice.phase).toMatchObject({ kind: "result", tip: expect.stringContaining("+3 dB") as string });
    expect(twice.phase).toMatchObject({ tip: expect.stringContaining("B to ¾, A to ¾") as string });
  });
});

describe("crossfader", () => {
  const definition = lessonDefinition("crossfader");

  it("moves on when the crossfader reaches B, then A", () => {
    const toB = run(definition, [ready, seen({ kind: "play", deck: "B", playing: true }), seen({ kind: "crossfader", value: 0.6 })]);
    expect(toB.phase).toMatchObject({ kind: "hook", step: 1 });
    const back = run(definition, [seen({ kind: "crossfader", value: 1 }), seen({ kind: "crossfader", value: 0.5 })], toB);
    expect(back.phase).toMatchObject({ kind: "hook", step: 2 });
    expect(run(definition, [seen({ kind: "crossfader", value: 0 })], back).phase).toMatchObject({ kind: "practice" });
  });
});

describe("eq-basics", () => {
  const definition = lessonDefinition("eq-basics");

  it("moves on when LOW A is cut to the kill line, then back within 1 dB of the middle", () => {
    const cut = run(definition, [ready, seen({ kind: "eq", deck: "A", band: "low", db: -12 }), seen({ kind: "eq", deck: "A", band: "high", db: -40 })]);
    expect(cut.phase).toMatchObject({ kind: "hook", step: 0 });
    const back = run(definition, [seen({ kind: "eq", deck: "A", band: "low", db: Number.NEGATIVE_INFINITY })], cut);
    expect(back.phase).toMatchObject({ kind: "hook", step: 1 });
    expect(run(definition, [seen({ kind: "eq", deck: "A", band: "low", db: -3 })], back).phase).toMatchObject({ kind: "hook", step: 1 });
    expect(run(definition, [seen({ kind: "eq", deck: "A", band: "low", db: -0.5 })], back).phase).toMatchObject({ kind: "practice" });
  });

  it("counts a LOW back on a phrase start as a good rep", () => {
    const practising = run(definition, [ready, skip]);
    expect(run(definition, [seen({ kind: "eq-return", deck: "A", onPhrase: false })], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [seen({ kind: "eq-return", deck: "A", onPhrase: true })], practising).phase).toMatchObject({ ready: true });
  });
});
