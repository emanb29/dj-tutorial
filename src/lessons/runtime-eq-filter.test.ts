// The runtime for Lessons 12–13: hook triggers and practice reps for the bass swap and the filter.
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

describe("bass-swap", () => {
  const definition = lessonDefinition("bass-swap");

  it("steps through LOW B cut, Play B and a swap", () => {
    const cut = run(definition, [ready, seen({ kind: "eq", deck: "A", band: "low", db: -120 }), seen({ kind: "eq", deck: "B", band: "low", db: -12 })]);
    expect(cut.phase).toMatchObject({ kind: "hook", step: 0 });
    const playing = run(definition, [seen({ kind: "eq", deck: "B", band: "low", db: -120 }), seen({ kind: "play", deck: "B", playing: true })], cut);
    expect(playing.phase).toMatchObject({ kind: "hook", step: 2 });
    // A swap off the phrase still shows what a swap is.
    expect(run(definition, [seen({ kind: "swap", onPhrase: false })], playing).phase).toMatchObject({
      kind: "practice",
      named: "That's a bass swap: one bassline hands over to the other.",
    });
  });

  it("is ready after a swap on the phrase start, not after one off it", () => {
    const practising = run(definition, [ready, skip]);
    expect(run(definition, [seen({ kind: "swap", onPhrase: false })], practising).phase).toMatchObject({ ready: false });
    expect(run(definition, [seen({ kind: "swap", onPhrase: false }), seen({ kind: "swap", onPhrase: true })], practising).phase).toMatchObject({ ready: true });
  });
});

describe("filter-transition", () => {
  const definition = lessonDefinition("filter-transition");
  const filter = (value: number, deck: "A" | "B" = "A") => seen({ kind: "filter", deck, value });

  it("steps through CFX A right, left, then back to the middle; CFX B does not count", () => {
    const right = run(definition, [ready, filter(0.9, "B"), filter(0.3), filter(0.6)]);
    expect(right.phase).toMatchObject({ kind: "hook", step: 1 });
    const left = run(definition, [filter(0), filter(-0.55)], right);
    expect(left.phase).toMatchObject({ kind: "hook", step: 2 });
    expect(run(definition, [filter(-0.1)], left).phase).toMatchObject({ kind: "hook", step: 2 });
    expect(run(definition, [filter(0.04)], left).phase).toMatchObject({ kind: "practice", named: "Middle: no filter. B has a CFX too." });
  });

  it("counts A out after a 70% high-pass on for 8–16 bars as a good rep", () => {
    const practising = run(definition, [ready, skip]);
    const out = (depth: number, bars: number | null) => run(definition, [seen({ kind: "filter-out", depth, bars })], practising).phase;
    expect(out(0.8, 8)).toMatchObject({ ready: true });
    expect(out(0.7, 7.8)).toMatchObject({ ready: true });
    expect(out(0.7, 16.2)).toMatchObject({ ready: true });
    expect(out(0.69, 8)).toMatchObject({ ready: false });
    expect(out(0.9, 7.5)).toMatchObject({ ready: false });
    expect(out(0.9, 17)).toMatchObject({ ready: false });
    expect(out(0, null)).toMatchObject({ ready: false });
  });
});
