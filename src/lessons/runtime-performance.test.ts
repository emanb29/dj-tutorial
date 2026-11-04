// The runtime for Lessons 14–16: hook triggers and practice reps for hot cues, loops and the echo out.
import { describe, expect, it } from "vitest";
import { lessonDefinition } from "./catalogue.ts";
import { initialLessonState, lessonReducer, triggerStep, type LessonEvent, type LessonState } from "./runtime.ts";
import type { LessonDefinition, Observation } from "./types.ts";

function run(definition: LessonDefinition, events: readonly LessonEvent[], from?: LessonState): LessonState {
  const start = from ?? initialLessonState(definition.id as Parameters<typeof initialLessonState>[0]);
  return events.reduce(lessonReducer(definition), start);
}

const seen = (observation: Observation): LessonEvent => ({ type: "observed", observation });
const ready: LessonEvent = { type: "track-ready" };
const skip: LessonEvent = { type: "skip-hook" };

describe("hot-cues", () => {
  const definition = lessonDefinition("hot-cues");

  it("sets a pad, then presses it again", () => {
    const set = run(definition, [ready, seen({ kind: "hot-cue-set", deck: "A", slot: 2 })]);
    expect(set.phase).toMatchObject({ kind: "hook", step: 1 });
    const jumped = run(definition, [seen({ kind: "hot-cue", deck: "A", slot: 2, offsetMs: 300, onPhrase: false })], set);
    expect(jumped.phase).toMatchObject({ kind: "practice", named: "Back to the spot, at once, playing. Shift + pad clears it." });
  });

  it("is ready after two jumps on a phrase's 1 out of three", () => {
    const practising = run(definition, [ready, skip]);
    const jump = (onPhrase: boolean) => seen({ kind: "hot-cue", deck: "A", slot: 1, offsetMs: onPhrase ? 10 : 400, onPhrase });
    expect(run(definition, [jump(true), jump(false)], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [jump(true), jump(false), jump(true)], practising).phase).toMatchObject({ ready: true });
  });
});

describe("loop-transition", () => {
  const definition = lessonDefinition("loop-transition");

  it("walks 4 BEAT, EXIT, LOOP IN and LOOP OUT", () => {
    const state = run(definition, [
      ready,
      seen({ kind: "loop", deck: "A", bars: 1, onDownbeat: true }),
      seen({ kind: "loop-exit", deck: "A", onDownbeat: true }),
      seen({ kind: "loop-in", deck: "A" }),
      seen({ kind: "loop", deck: "A", bars: 4, onDownbeat: true }),
    ]);
    expect(state.phase).toMatchObject({ kind: "practice" });
  });

  it("counts a loop of 4 or 8 bars from a downbeat as a good rep, not a 1-bar or an off-beat one", () => {
    const practising = run(definition, [ready, skip]);
    const loop = (bars: number, onDownbeat = true) => seen({ kind: "loop", deck: "A", bars, onDownbeat });
    expect(run(definition, [loop(1)], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [loop(4, false)], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [loop(4.04)], practising).phase).toMatchObject({ ready: true });
    expect(run(definition, [loop(8)], practising).phase).toMatchObject({ ready: true });
  });
});

describe("echo-out", () => {
  const definition = lessonDefinition("echo-out");

  it("walks FX on, DEPTH, BEAT and the fader down", () => {
    const state = run(definition, [
      ready,
      seen({ kind: "beat-fx", on: false }),
      seen({ kind: "beat-fx", on: true }),
      seen({ kind: "touch", control: "beat-fx-depth" }),
      seen({ kind: "touch", control: "beat-fx-beat" }),
      seen({ kind: "fader", deck: "A", value: 0 }),
    ]);
    expect(state.phase).toMatchObject({ kind: "practice", named: "The echoes ring on after the fader: an echo out." });
  });

  it("counts a cut on a downbeat with ECHO on as a good rep", () => {
    const practising = run(definition, [ready, skip]);
    expect(run(definition, [seen({ kind: "echo-cut", onDownbeat: true, echoOn: false })], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [seen({ kind: "echo-cut", onDownbeat: true, echoOn: true })], practising).phase).toMatchObject({ ready: true });
  });
});

describe("triggerStep for a Check's step cues", () => {
  it("matches B's Play, a loop going on and a pad press", () => {
    expect(triggerStep({ kind: "play", deck: "B" }, { kind: "play", deck: "B", playing: true })).toBe(1);
    expect(triggerStep({ kind: "loop-on" }, { kind: "loop-in", deck: "A" })).toBe(0);
    expect(triggerStep({ kind: "hot-cue-trigger" }, { kind: "hot-cue", deck: "A", slot: 3, offsetMs: null, onPhrase: false })).toBe(1);
  });
});
