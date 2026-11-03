import { describe, expect, it } from "vitest";
import { orderedKeyframes, type LaneParam, type LaneTrack, valueAt } from "./lanes.ts";
import { RECIPE_IDS, recipeLanes, type RecipeLanes } from "./recipes.ts";

const TEMPOS = { outgoing: 124, incoming: 128 };
const RANGES: Readonly<Record<LaneParam, readonly [number, number]>> = {
  volume: [0, 1],
  "eq-low": [-1, 1],
  "eq-mid": [-1, 1],
  "eq-high": [-1, 1],
  filter: [-1, 1],
  tempo: [60, 200],
  "echo-send": [0, 1],
  loop: [0, 32],
};

function level(recipe: RecipeLanes, track: LaneTrack, param: LaneParam, beat: number, neutral: number): number {
  const lane = recipe.lanes.find((candidate) => candidate.track === track && candidate.param === param);
  return lane === undefined ? neutral : (valueAt(orderedKeyframes(lane).map(({ keyframe }) => keyframe), beat) ?? neutral);
}

describe("every recipe", () => {
  it.each(RECIPE_IDS)("%s hands over: the outgoing track ends silent, the incoming one full, with keyframes in order, in range and inside its length", (id) => {
    const recipe = recipeLanes(id, TEMPOS);
    expect(recipe.recipe).toBe(id);
    expect(level(recipe, "outgoing", "volume", recipe.lengthBeats, 1)).toBe(0);
    expect(level(recipe, "incoming", "volume", recipe.lengthBeats, 1)).toBe(1);
    for (const lane of recipe.lanes) {
      const beats = lane.keyframes.map(({ beat }) => beat);
      expect(beats).toEqual([...beats].sort((a, b) => a - b));
      const [low, high] = RANGES[lane.param];
      for (const { beat, value } of lane.keyframes) {
        expect(beat).toBeGreaterThanOrEqual(0);
        expect(beat).toBeLessThanOrEqual(recipe.lengthBeats);
        expect(value).toBeGreaterThanOrEqual(low);
        expect(value).toBeLessThanOrEqual(high);
      }
    }
  });
});

it("a bass swap never plays both basslines", () => {
  const recipe = recipeLanes("bass-swap", TEMPOS);
  for (let beat = -4; beat <= recipe.lengthBeats + 4; beat += 0.25) {
    const bass = (track: LaneTrack) => level(recipe, track, "volume", beat, 1) > 0 && level(recipe, track, "eq-low", beat, 0) > -1;
    expect(bass("outgoing") && bass("incoming"), `beat ${String(beat)}`).toBe(false);
  }
});

it("a tempo ride starts the incoming track at the outgoing one's tempo and ends at its own", () => {
  const recipe = recipeLanes("tempo-ride", TEMPOS);
  expect(level(recipe, "incoming", "tempo", 0, 0)).toBe(124);
  expect(level(recipe, "incoming", "tempo", recipe.lengthBeats, 0)).toBe(128);
});
