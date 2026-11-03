import { describe, expect, it } from "vitest";
import { testGrid, testHash, testPicked, testPlan } from "@shared/mix-plan-test-support.ts";
import { RECIPES } from "@shared/mix-plan-recipes.ts";
import { mixPlanProblems } from "@shared/mix-plan-validate.ts";
import { BEATS_PER_PHRASE, type MixPlan, type Transition } from "@shared/mix-plan.ts";
import { deckOf } from "../mix-plans/deck-layout.ts";
import { editPlan, insertionIndex, type EditorAction } from "./editor-state.ts";
import { deriveExecution } from "./execution-plan.ts";

const NOW = "2026-11-03T13:00:00.000Z";

function edited(plan: MixPlan, grids: ReadonlyMap<string, ReturnType<typeof testGrid>>, ...actions: EditorAction[]): MixPlan {
  return actions.reduce((current, action) => editPlan(current, action, grids, NOW), plan);
}

const first = (plan: MixPlan): Transition => {
  const transition = plan.transitions[0];
  if (transition === undefined) throw new Error("The test plan has no Transition.");
  return transition;
};

describe("editPlan: recipes, start and length", () => {
  it("picking a recipe keeps where the Transition starts, takes the recipe's lanes and length, and stamps updatedAt", () => {
    const { plan, grids } = testPlan(3);
    const before = first(plan);
    const after = edited(plan, grids, { kind: "recipe", transition: 0, recipe: "bass-swap" });
    expect(first(after).recipe).toBe("bass-swap");
    expect(first(after).outgoingAt).toEqual(before.outgoingAt);
    expect(first(after).lengthBeats).toBe(RECIPES["bass-swap"].lengthBeats);
    expect(first(after).lanes).toHaveLength(4);
    expect(after.updatedAt).toBe(NOW);
    // The other Transition is the same object: a memo keyed on it is not recomputed.
    expect(after.transitions[1]).toBe(plan.transitions[1]);
  });

  it("a tempo ride takes both tracks' BPMs from their grids", () => {
    const { plan, grids } = testPlan(2, { grid: (index) => testGrid({ bpm: index === 0 ? 122 : 128 }) });
    const ride = first(edited(plan, grids, { kind: "recipe", transition: 0, recipe: "tempo-ride" }));
    const tempo = ride.lanes.find((lane) => lane.param === "tempo");
    expect(tempo?.keyframes.map((keyframe) => keyframe.value)).toEqual([122, 122, 128]);
  });

  it("start and incoming phrases move to phrase starts, never before Phrase 1", () => {
    const { plan, grids } = testPlan(2);
    const after = first(edited(plan, grids, { kind: "start-phrase", transition: 0, phrase: 3 }, { kind: "incoming-phrase", transition: 0, phrase: 0 }));
    expect(after.outgoingAt).toEqual({ bar: 17, beat: 1 });
    expect(after.incomingAt).toEqual({ bar: 1, beat: 1 });
  });

  it("a recipe's length change redraws its lanes at the new length; a custom one is stretched", () => {
    const { plan, grids } = testPlan(2);
    const longer = first(edited(plan, grids, { kind: "length", transition: 0, lengthBeats: 128 }));
    expect(longer.recipe).toBe("crossfade-16");
    expect(longer.lanes).toEqual(RECIPES["crossfade-16"].lanes(128, undefined));

    const custom = edited(plan, grids, { kind: "move-keyframe", transition: 0, lane: 0, keyframe: 1, beat: 16, value: 1 });
    const stretched = first(edited(custom, grids, { kind: "length", transition: 0, lengthBeats: 128 }));
    expect(stretched.recipe).toBe("custom");
    expect(stretched.lanes[0]?.keyframes.map((keyframe) => keyframe.beat)).toEqual([0, 32]);
  });

  it("the length stays between one bar and the longest Transition", () => {
    const { plan, grids } = testPlan(2);
    expect(first(edited(plan, grids, { kind: "length", transition: 0, lengthBeats: 1 })).lengthBeats).toBe(4);
    expect(first(edited(plan, grids, { kind: "length", transition: 0, lengthBeats: 10_000 })).lengthBeats).toBe(256);
  });
});

describe("editPlan: keyframes and lanes", () => {
  it("moving a keyframe makes the Transition custom, keeps it between its neighbours and the value in range", () => {
    const { plan, grids } = testPlan(2);
    // crossfade-16: lane 0 is the incoming volume, keyframes at 0 and 32.
    const after = first(edited(plan, grids, { kind: "move-keyframe", transition: 0, lane: 0, keyframe: 1, beat: -10, value: 7 }));
    expect(after.recipe).toBe("custom");
    expect(after.lanes[0]?.keyframes[1]).toEqual({ beat: 0, value: 1, curve: "linear" });
    const late = first(edited(plan, grids, { kind: "move-keyframe", transition: 0, lane: 0, keyframe: 1, beat: 500, value: -1 }));
    expect(late.lanes[0]?.keyframes[1]).toEqual({ beat: 64, value: 0, curve: "linear" });
  });

  it("adds a keyframe in beat order at the lane's value there, and removes it again", () => {
    const { plan, grids } = testPlan(2);
    const added = edited(plan, grids, { kind: "add-keyframe", transition: 0, lane: 0, beat: 16 });
    expect(first(added).lanes[0]?.keyframes).toEqual([
      { beat: 0, value: 0, curve: "jump" },
      { beat: 16, value: 0.5, curve: "linear" },
      { beat: 32, value: 1, curve: "linear" },
    ]);
    const removed = edited(added, grids, { kind: "remove-keyframe", transition: 0, lane: 0, keyframe: 1 });
    expect(first(removed).lanes[0]?.keyframes.map((keyframe) => keyframe.beat)).toEqual([0, 32]);
  });

  it("changes a keyframe's curve", () => {
    const { plan, grids } = testPlan(2);
    const after = first(edited(plan, grids, { kind: "curve", transition: 0, lane: 0, keyframe: 1, curve: "ease" }));
    expect(after.lanes[0]?.keyframes[1]?.curve).toBe("ease");
  });

  it("adds a lane once per track and parameter, resting at both ends; a tempo lane at the matched BPM", () => {
    const { plan, grids } = testPlan(2, { grid: () => testGrid({ bpm: 124 }) });
    const once = edited(plan, grids, { kind: "add-lane", transition: 0, track: "outgoing", param: "eq-high" }, { kind: "add-lane", transition: 0, track: "outgoing", param: "eq-high" });
    const highs = first(once).lanes.filter((lane) => lane.param === "eq-high");
    expect(highs).toEqual([{ track: "outgoing", param: "eq-high", keyframes: [{ beat: 0, value: 0, curve: "jump" }, { beat: 64, value: 0, curve: "linear" }] }]);
    const tempo = first(edited(plan, grids, { kind: "add-lane", transition: 0, track: "incoming", param: "tempo" })).lanes.at(-1);
    expect(tempo?.keyframes.map((keyframe) => keyframe.value)).toEqual([124, 124]);
    const echo = first(edited(plan, grids, { kind: "add-lane", transition: 0, track: "outgoing", param: "echo-send" })).lanes.at(-1);
    expect(echo?.echoBeats).toBe(1);
    const loop = first(edited(plan, grids, { kind: "add-lane", transition: 0, track: "outgoing", param: "loop" })).lanes.at(-1);
    expect(loop?.loopBeats).toBe(4);
  });

  it("removes a lane", () => {
    const { plan, grids } = testPlan(2);
    expect(first(edited(plan, grids, { kind: "remove-lane", transition: 0, lane: 0 })).lanes).toHaveLength(1);
  });

  it("insertionIndex finds where a new keyframe goes", () => {
    const { plan } = testPlan(2);
    const lane = first(plan).lanes[0];
    if (lane === undefined) throw new Error("no lane");
    expect(insertionIndex(lane, -1)).toBe(0);
    expect(insertionIndex(lane, 16)).toBe(1);
    expect(insertionIndex(lane, 99)).toBe(2);
  });
});

describe("editPlan: tracks", () => {
  it("inserting a track after another keeps the Transition into it and adds one out of it, and the plan stays valid", () => {
    const { plan, grids } = testPlan(3);
    const [picked] = testPicked(1, () => testGrid({ durationSec: 240 }));
    if (picked === undefined) throw new Error("no track");
    const newcomer = { ...picked, track: { ...picked.track, contentHash: testHash(99), title: "Newcomer" } };
    const after = edited(plan, grids, { kind: "insert-track", after: 0, picked: newcomer });
    expect(after.tracks.map((track) => track.title)).toEqual(["Track 1", "Newcomer", "Track 2", "Track 3"]);
    expect(after.transitions).toHaveLength(3);
    // Into the newcomer, from its bar 1.
    expect(after.transitions[0]).toEqual({ ...plan.transitions[0], incomingAt: { bar: 1, beat: 1 } });
    // Out of the newcomer: on the last phrase of it that fits, into what track 2 was cued at.
    expect(after.transitions[1]?.outgoingAt).toEqual({ bar: 97, beat: 1 });
    expect(after.transitions[2]).toBe(plan.transitions[1]);
    const allGrids = new Map([...grids, [testHash(99), newcomer.grid]]);
    expect(mixPlanProblems(after, allGrids)).toEqual([]);
  });

  it("inserting after the last track adds a Transition onto the end", () => {
    const { plan, grids } = testPlan(2);
    const [picked] = testPicked(1);
    if (picked === undefined) throw new Error("no track");
    const after = edited(plan, grids, { kind: "insert-track", after: 1, picked: { ...picked, track: { ...picked.track, contentHash: testHash(42) } } });
    expect(after.tracks).toHaveLength(3);
    expect(after.transitions).toHaveLength(2);
    expect(after.transitions[1]?.outgoingAt.bar).toBeGreaterThan(1);
  });

  it("removing a middle track joins its neighbours with the Transition into it", () => {
    const { plan, grids } = testPlan(3);
    const after = edited(plan, grids, { kind: "remove-track", track: 1 });
    expect(after.tracks.map((track) => track.title)).toEqual(["Track 1", "Track 3"]);
    expect(after.transitions).toEqual([{ ...plan.transitions[0], incomingAt: plan.transitions[1]?.incomingAt }]);
    expect(edited(plan, grids, { kind: "remove-track", track: 0 }).transitions).toEqual([plan.transitions[1]]);
    expect(edited(plan, grids, { kind: "remove-track", track: 2 }).transitions).toEqual([plan.transitions[0]]);
  });

  it("renames, trimmed", () => {
    const { plan, grids } = testPlan(2);
    expect(edited(plan, grids, { kind: "rename", name: "  Friday set  " }).name).toBe("Friday set");
  });

  it("stays quick on a set of 25 tracks", () => {
    const { plan, grids } = testPlan(25);
    const started = performance.now();
    let current = plan;
    for (let index = 0; index < 24; index += 1) current = editPlan(current, { kind: "start-phrase", transition: index, phrase: 2 }, grids, NOW);
    expect(performance.now() - started).toBeLessThan(200);
    expect(current.transitions.every((transition) => transition.outgoingAt.bar === BEATS_PER_PHRASE / 4 + 1)).toBe(true);
  });

  it("derives every Execution plan and rating of a 25-track set quickly (the set view's chips)", () => {
    const { plan } = testPlan(25, { recipe: "bass-swap" });
    const started = performance.now();
    const ratings = plan.transitions.map((transition, index) => deriveExecution(transition, { outgoing: deckOf(index), incoming: deckOf(index + 1) }, new Set()).complexity.rating);
    expect(performance.now() - started).toBeLessThan(250);
    expect(ratings).toHaveLength(24);
  });
});
