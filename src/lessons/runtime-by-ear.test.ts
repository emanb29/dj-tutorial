// The runtime for Lessons 17–19: hook triggers and practice reps from the by-ear drills.
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

describe("nudge-phase", () => {
  const definition = lessonDefinition("nudge-phase");

  it("moves on with a nudge (a jog search does not count), then with B held in phase", () => {
    const searched = run(definition, [ready, seen({ kind: "touch", control: "B.jog" })]);
    expect(searched.phase).toMatchObject({ kind: "hook", step: 0 });
    const nudged = run(definition, [seen({ kind: "touch", control: "B.jog-bend" })], searched);
    expect(nudged.phase).toMatchObject({ kind: "hook", step: 1 });
    expect(run(definition, [seen({ kind: "phase-rep", held: false })], nudged).phase).toMatchObject({ kind: "hook", step: 1 });
    expect(run(definition, [seen({ kind: "phase-rep", held: true })], nudged).phase).toMatchObject({ kind: "practice", named: "In phase: one kick, not two." });
  });

  it("is ready after two held rounds out of three", () => {
    const practising = run(definition, [ready, skip]);
    const rep = (held: boolean) => seen({ kind: "phase-rep", held });
    expect(run(definition, [rep(true), rep(false)], practising).phase).toMatchObject({ ready: false, reps: [true, false] });
    expect(run(definition, [rep(true), rep(false), rep(true)], practising).phase).toMatchObject({ ready: true });
  });
});

describe("tempo-by-ear", () => {
  const definition = lessonDefinition("tempo-by-ear");

  it("moves on with a guess, right or wrong, then a Ready", () => {
    const guessed = run(definition, [ready, seen({ kind: "tempo-guess", right: false })]);
    expect(guessed.phase).toMatchObject({ kind: "hook", step: 1 });
    expect(run(definition, [seen({ kind: "tempo-match", offBpm: 0.5, good: false })], guessed).phase).toMatchObject({ kind: "practice" });
  });

  it("counts each guess and each Ready as a rep: ready after 3 good of the last 4", () => {
    const practising = run(definition, [ready, skip]);
    const reps = [
      seen({ kind: "tempo-guess", right: true }),
      seen({ kind: "tempo-match", offBpm: 0.3, good: false }),
      seen({ kind: "tempo-guess", right: true }),
      seen({ kind: "tempo-match", offBpm: 0.05, good: true }),
    ];
    expect(run(definition, reps, practising).phase).toMatchObject({ ready: true, reps: [true, false, true, true] });
    expect(run(definition, reps.slice(0, 3), practising).phase).toMatchObject({ ready: false });
  });
});

describe("blend-by-ear", () => {
  const definition = lessonDefinition("blend-by-ear");

  it("moves on with TEMPO B, then a nudge on B", () => {
    const trimmed = run(definition, [ready, seen({ kind: "touch", control: "B.tempo" })]);
    expect(trimmed.phase).toMatchObject({ kind: "hook", step: 1 });
    expect(run(definition, [seen({ kind: "touch", control: "B.jog-bend" })], trimmed).phase).toMatchObject({ kind: "practice" });
  });
});
