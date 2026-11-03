import { describe, expect, it } from "vitest";
import { RECIPE_IDS, type Lane } from "./mix-plan.ts";
import { newMixPlan, RECIPES, transitionFromRecipe } from "./mix-plan-recipes.ts";
import { mixPlanProblems } from "./mix-plan-validate.ts";
import { testPicked, testPlan } from "./mix-plan-test-support.ts";

const place = { outgoingAt: { bar: 129, beat: 1 }, incomingAt: { bar: 1, beat: 1 } } as const;
const lanesOf = (recipe: (typeof RECIPE_IDS)[number]) => transitionFromRecipe(recipe, place).lanes;
const fade = (track: Lane["track"], from: number, to: number, startBeat: number, endBeat: number): Lane => ({
  track,
  param: "volume",
  keyframes: [
    { beat: startBeat, value: from, curve: "jump" },
    { beat: endBeat, value: to, curve: "linear" },
  ],
});

// Golden lane sets: changing a recipe changes every plan made from it from then on, so it is deliberate.
describe("Transition recipes", () => {
  it("crossfades bring the incoming track up over the first half and take the outgoing one down over the second", () => {
    expect(transitionFromRecipe("crossfade-8", place)).toEqual({
      recipe: "crossfade-8",
      ...place,
      lengthBeats: 32,
      lanes: [fade("incoming", 0, 1, 0, 16), fade("outgoing", 1, 0, 16, 32)],
    });
    expect(lanesOf("crossfade-16")).toEqual([fade("incoming", 0, 1, 0, 32), fade("outgoing", 1, 0, 32, 64)]);
    expect(lanesOf("crossfade-32")).toEqual([fade("incoming", 0, 1, 0, 64), fade("outgoing", 1, 0, 64, 128)]);
  });

  it("bass swap: the incoming bass is cut until the halfway swap, 16 bars", () => {
    expect(RECIPES["bass-swap"].lengthBeats).toBe(64);
    expect(lanesOf("bass-swap")).toEqual([
      fade("incoming", 0, 1, 0, 32),
      {
        track: "incoming",
        param: "eq-low",
        keyframes: [
          { beat: 0, value: -1, curve: "jump" },
          { beat: 32, value: 0, curve: "jump" },
        ],
      },
      { track: "outgoing", param: "eq-low", keyframes: [{ beat: 32, value: -1, curve: "jump" }] },
      fade("outgoing", 1, 0, 32, 64),
    ]);
  });

  it("cut on the 1: both volumes jump at beat 0", () => {
    expect(RECIPES["cut-on-the-1"].lengthBeats).toBe(4);
    expect(lanesOf("cut-on-the-1")).toEqual([
      { track: "outgoing", param: "volume", keyframes: [{ beat: 0, value: 0, curve: "jump" }] },
      { track: "incoming", param: "volume", keyframes: [{ beat: 0, value: 1, curve: "jump" }] },
    ]);
  });

  it("filter sweep: the outgoing high-pass rises over 8 bars while the incoming track comes up without its bass", () => {
    expect(lanesOf("filter-sweep")).toEqual([
      {
        track: "outgoing",
        param: "filter",
        keyframes: [
          { beat: 0, value: 0, curve: "jump" },
          { beat: 32, value: 1, curve: "linear" },
        ],
      },
      { track: "outgoing", param: "volume", keyframes: [{ beat: 32, value: 0, curve: "jump" }] },
      fade("incoming", 0, 1, 0, 32),
      {
        track: "incoming",
        param: "eq-low",
        keyframes: [
          { beat: 0, value: -1, curve: "jump" },
          { beat: 32, value: 0, curve: "jump" },
        ],
      },
    ]);
  });

  it("echo out: a 1-beat echo, the outgoing level cut a bar later, the incoming track in after 2 bars", () => {
    expect(lanesOf("echo-out")).toEqual([
      {
        track: "outgoing",
        param: "echo-send",
        echoBeats: 1,
        keyframes: [
          { beat: 0, value: 1, curve: "jump" },
          { beat: 8, value: 0, curve: "jump" },
        ],
      },
      { track: "outgoing", param: "volume", keyframes: [{ beat: 4, value: 0, curve: "jump" }] },
      { track: "incoming", param: "volume", keyframes: [{ beat: 8, value: 1, curve: "jump" }] },
    ]);
  });

  it("loop to extend: a 1-bar loop on the outgoing track while the faders trade, let go at the end, 8 bars", () => {
    expect(RECIPES["loop-to-extend"].lengthBeats).toBe(32);
    expect(lanesOf("loop-to-extend")).toEqual([
      {
        track: "outgoing",
        param: "loop",
        loopBeats: 4,
        keyframes: [
          { beat: 0, value: 1, curve: "jump" },
          { beat: 32, value: 0, curve: "jump" },
        ],
      },
      fade("incoming", 0, 1, 0, 16),
      fade("outgoing", 1, 0, 16, 32),
    ]);
  });

  it("tempo ride: a 16-bar crossfade at the outgoing tempo, then the incoming track rides back to its own over a phrase", () => {
    expect(RECIPES["tempo-ride"].lengthBeats).toBe(96);
    expect(transitionFromRecipe("tempo-ride", { ...place, tempos: { outgoing: 124, incoming: 128 } }).lanes).toEqual([
      {
        track: "incoming",
        param: "tempo",
        keyframes: [
          { beat: 0, value: 124, curve: "jump" },
          { beat: 64, value: 124, curve: "jump" },
          { beat: 96, value: 128, curve: "linear" },
        ],
      },
      fade("incoming", 0, 1, 0, 32),
      fade("outgoing", 1, 0, 32, 64),
    ]);
    expect(() => transitionFromRecipe("tempo-ride", place)).toThrow(/BPMs/);
  });

  it("scales lanes to a length other than the usual one", () => {
    expect(transitionFromRecipe("bass-swap", { ...place, lengthBeats: 32 }).lanes[3]).toEqual(fade("outgoing", 1, 0, 16, 32));
  });

  it.each(RECIPE_IDS)("%s makes a plan with no problems", (recipe) => {
    const { plan, grids } = testPlan(3, { recipe });
    expect(mixPlanProblems(plan, grids)).toEqual([]);
  });
});

describe("newMixPlan", () => {
  it("lays each Transition on the outgoing track's last phrase that fits, the incoming track from bar 1", () => {
    const { plan } = testPlan(3);
    expect(plan.version).toBe(1);
    expect(plan.tracks.map((track) => track.startAt)).toEqual([{ bar: 1, beat: 1 }, { bar: 1, beat: 1 }, { bar: 1, beat: 1 }]);
    expect(plan.transitions.map((transition) => [transition.recipe, transition.outgoingAt, transition.incomingAt, transition.lengthBeats])).toEqual([
      ["crossfade-16", { bar: 129, beat: 1 }, { bar: 1, beat: 1 }, 64],
      ["crossfade-16", { bar: 129, beat: 1 }, { bar: 1, beat: 1 }, 64],
    ]);
  });

  it("keeps what identifies each track, never a path", () => {
    const [picked] = testPicked(1);
    const plan = newMixPlan({ id: "p", name: "One", now: "2026-11-03T12:00:00.000Z", picked: testPicked(2) });
    expect(plan.tracks[0]).toEqual({ ...picked?.track, source: "local", gridHash: expect.stringMatching(/^grid1-/) as unknown, startAt: { bar: 1, beat: 1 }, gainDb: 0 });
  });
});
