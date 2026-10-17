// The runtime for Lessons 8–11: hook triggers and practice reps for the tempo fader, SYNC, the
// crossfader and EQ.
import { describe, expect, it } from "vitest";
import { lessonDefinition } from "./catalogue.ts";
import { initialLessonState, lessonReducer, type LessonEvent, type LessonState } from "./runtime.ts";
import type { LessonDefinition, Observation } from "./types.ts";

function run(definition: LessonDefinition, events: readonly LessonEvent[], from?: LessonState): LessonState {
  const start = from ?? initialLessonState(definition.id as Parameters<typeof initialLessonState>[0]);
  return events.reduce(lessonReducer(definition), start);
}

const seen = (observation: Observation): LessonEvent => ({ type: "observed", observation });
const ready: LessonEvent = { type: "track-ready" };
const skip: LessonEvent = { type: "skip-hook" };

describe("tempo-fader", () => {
  const definition = lessonDefinition("tempo-fader");

  it("steps through TEMPO B, MASTER TEMPO B and the range, by touching each", () => {
    const state = run(definition, [
      ready,
      seen({ kind: "touch", control: "A.tempo" }),
      seen({ kind: "touch", control: "B.tempo" }),
      seen({ kind: "touch", control: "B.master-tempo" }),
      seen({ kind: "touch", control: "B.tempo-range" }),
    ]);
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

  it("counts a blend start within a beat of A's phrase start as a good rep, however far off a cut would be", () => {
    const practising = run(definition, [ready, skip]);
    expect(run(definition, [seen({ kind: "cut", offsetMs: 300, onPhrase: false, withinBeat: true })], practising).phase).toMatchObject({ ready: true });
    expect(run(definition, [seen({ kind: "cut", offsetMs: 700, onPhrase: false, withinBeat: false })], practising).phase).toMatchObject({ ready: false });
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
