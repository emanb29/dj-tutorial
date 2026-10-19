// The runtime for Lessons 4–7: hook triggers and practice reps on two decks, the mixer and cue points.
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

describe("observations that change nothing", () => {
  it("leave the state as it was, so the player does not re-render for them", () => {
    const definition = lessonDefinition("deck-basics");
    const hooked = run(definition, [ready]);
    expect(run(definition, [seen({ kind: "level", deck: "A", peakDb: -3 })], hooked)).toBe(hooked);
  });
});

describe("gain-staging", () => {
  const definition = lessonDefinition("gain-staging");

  it("moves on when deck A's level lands in the zone, not just when TRIM is touched", () => {
    const hot = run(definition, [ready, seen({ kind: "touch", control: "A.trim" }), seen({ kind: "level", deck: "A", peakDb: 1.5 })]);
    expect(hot.phase).toMatchObject({ kind: "hook", step: 0 });
    // B's level does not count for deck A's step.
    expect(run(definition, [seen({ kind: "level", deck: "B", peakDb: -3 })], hot).phase).toMatchObject({ kind: "hook", step: 0 });
    expect(run(definition, [seen({ kind: "level", deck: "A", peakDb: -3 })], hot).phase).toMatchObject({ kind: "hook", step: 1, named: "That's TRIM: the level into the channel." });
  });

  it("then waits for PLAY on deck B, not deck A", () => {
    const step1 = run(definition, [ready, seen({ kind: "level", deck: "A", peakDb: -3 })]);
    expect(run(definition, [seen({ kind: "play", deck: "A", playing: true })], step1).phase).toMatchObject({ step: 1 });
    expect(run(definition, [seen({ kind: "play", deck: "B", playing: true })], step1).phase).toMatchObject({ step: 2 });
  });

  it("counts a Ready press as a good rep only with every level in the zone", () => {
    const practising = run(definition, [ready, { type: "skip-hook" }]);
    const state = run(definition, [seen({ kind: "ready", inZone: false }), seen({ kind: "ready", inZone: true }), seen({ kind: "ready", inZone: true })], practising);
    expect(state.phase).toMatchObject({ kind: "practice", reps: [true, true], ready: true });
  });
});

describe("headphone-cue", () => {
  const definition = lessonDefinition("headphone-cue");

  it("steps through CUE on B, MIXING, then four taps on B's beat", () => {
    const afterCue = run(definition, [ready, seen({ kind: "headphone-cue", deck: "A", on: true }), seen({ kind: "headphone-cue", deck: "B", on: true })]);
    expect(afterCue.phase).toMatchObject({ kind: "hook", step: 1 });
    const afterMixing = run(definition, [seen({ kind: "touch", control: "headphone-level" }), seen({ kind: "touch", control: "cue-mix" })], afterCue);
    expect(afterMixing.phase).toMatchObject({ kind: "hook", step: 2 });
    const tap: Observation = { kind: "tap", offsetMs: 4, onBeat: true, onDownbeat: false, onPhraseStart: false };
    expect(run(definition, [seen(tap), seen(tap), seen(tap), seen(tap)], afterMixing).phase).toMatchObject({ kind: "practice" });
  });
});

describe("cue-point", () => {
  const definition = lessonDefinition("cue-point");

  it("steps through a jog search, a cue point set, then a preview", () => {
    const state = run(definition, [
      ready,
      seen({ kind: "touch", control: "A.jog" }),
      seen({ kind: "cue-set", deck: "A", offsetMs: 80, beatOfBar: 2, onDownbeat: false }),
      seen({ kind: "cue-preview", deck: "A" }),
    ]);
    expect(state.phase).toMatchObject({ kind: "practice", named: "Held CUE plays from the point; let go, it snaps back." });
  });

  const cue = (offsetMs: number, beatOfBar = 1): Observation => ({ kind: "cue-set", deck: "A", offsetMs, beatOfBar, onDownbeat: beatOfBar === 1 });

  it("practice starts on the ±40 ms rung", () => {
    const practising = run(definition, [ready, { type: "skip-hook" }]);
    expect(practising.phase).toMatchObject({ kind: "practice", cueLadder: { rung: 0, hits: 0 }, ready: false });
  });

  it("narrows ±40, ±30, ±20 on two hits in a row each, then is ready", () => {
    const practising = run(definition, [ready, { type: "skip-hook" }]);
    const atThirty = run(definition, [seen(cue(35)), seen(cue(-38))], practising);
    expect(atThirty.phase).toMatchObject({ cueLadder: { rung: 1, hits: 0 }, ready: false });
    const atTwenty = run(definition, [seen(cue(25)), seen(cue(-28))], atThirty);
    expect(atTwenty.phase).toMatchObject({ cueLadder: { rung: 2 }, ready: false });
    const done = run(definition, [seen(cue(12)), seen(cue(-20))], atTwenty);
    expect(done.phase).toMatchObject({ kind: "practice", ready: true, cueLadder: { complete: true } });
  });

  it("two good cue points move one rung down, not into the Check", () => {
    const practising = run(definition, [ready, { type: "skip-hook" }]);
    const state = run(definition, [seen(cue(3)), seen(cue(4))], practising);
    expect(state.phase).toMatchObject({ ready: false, cueLadder: { rung: 1 } });
  });

  it("a cue on beat 3 is a miss however close, and other Lessons have no ladder", () => {
    const practising = run(definition, [ready, { type: "skip-hook" }]);
    expect(run(definition, [seen(cue(2, 3))], practising).phase).toMatchObject({ reps: [false], cueLadder: { misses: 1 } });
    const fade = run(lessonDefinition("deck-basics"), [ready, { type: "skip-hook" }]);
    expect(fade.phase).toMatchObject({ kind: "practice", cueLadder: null });
  });
});

describe("cut-on-phrase", () => {
  const definition = lessonDefinition("cut-on-phrase");

  it("steps through CUE on B, fader B up, then a cut", () => {
    const state = run(definition, [
      ready,
      seen({ kind: "headphone-cue", deck: "B", on: true }),
      seen({ kind: "fader", deck: "A", value: 1 }),
      seen({ kind: "fader", deck: "B", value: 1 }),
      seen({ kind: "cut", offsetMs: 400, onPhrase: false, withinBeat: true }),
    ]);
    expect(state.phase).toMatchObject({ kind: "practice", named: "That's a cut: B in, A out, on the phrase." });
  });

  it("is ready after one cut on the phrase", () => {
    const practising = run(definition, [ready, { type: "skip-hook" }]);
    expect(run(definition, [seen({ kind: "cut", offsetMs: 400, onPhrase: false, withinBeat: true })], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [seen({ kind: "cut", offsetMs: 30, onPhrase: true, withinBeat: true })], practising).phase).toMatchObject({ ready: true });
  });
});
