import { describe, expect, it } from "vitest";
import { type Keyframe, type Lane, RECIPE_IDS } from "@shared/mix-plan.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import { heard, isPhraseStart, laneTimeline, orderedKeyframes, trackVolume, valueAt, valueBefore } from "./lanes.ts";

const kf = (beat: number, value: number, curve: Keyframe["curve"] = "linear"): Keyframe => ({ beat, value, curve });

describe("phrase starts", () => {
  it("come every 8 bars from bar 1, from wherever the Transition starts", () => {
    const fromBar17 = { outgoingAt: { bar: 17, beat: 1 } } as const;
    expect(isPhraseStart(fromBar17, 0)).toBe(true);
    expect(isPhraseStart(fromBar17, 32)).toBe(true);
    expect(isPhraseStart(fromBar17, 16)).toBe(false);
    expect(isPhraseStart(fromBar17, 32.5)).toBe(false);
    const fromBar16 = { outgoingAt: { bar: 16, beat: 1 } } as const;
    expect(isPhraseStart(fromBar16, 0)).toBe(false);
    expect(isPhraseStart(fromBar16, 4)).toBe(true);
  });
});

describe("a lane's value", () => {
  const keyframes = [kf(0, 0), kf(8, 1), kf(16, 0.5, "jump"), kf(24, 0, "ease")];

  it("holds before the first keyframe and after the last", () => {
    expect(valueAt(keyframes, -4)).toBe(0);
    expect(valueAt(keyframes, 40)).toBe(0);
    expect(valueAt([], 4)).toBeNull();
  });

  it("ramps linearly, eases, and jumps on the keyframe's beat", () => {
    expect(valueAt(keyframes, 4)).toBe(0.5);
    expect(valueAt(keyframes, 12)).toBe(1);
    expect(valueAt(keyframes, 16)).toBe(0.5);
    expect(valueBefore(keyframes, 16)).toBe(1);
    expect(valueAt(keyframes, 20)).toBe(0.25);
    expect(valueAt(keyframes, 18)).toBeCloseTo(0.5 - 0.5 * (0.25 * 0.25 * (3 - 0.5)));
  });

  it("just before a ramp's end is the ramp's own value", () => {
    expect(valueBefore(keyframes, 8)).toBe(1);
    expect(valueBefore(keyframes, 0)).toBe(0);
  });

  it("orders keyframes by beat, keeping each one's index", () => {
    expect(orderedKeyframes({ track: "outgoing", param: "volume", keyframes: [kf(8, 1), kf(0, 0)] }).map(({ index }) => index)).toEqual([1, 0]);
  });
});

describe("where a lane starts", () => {
  it("at its resting value, with every keyframe a move from it", () => {
    expect(laneTimeline({ track: "outgoing", param: "volume", keyframes: [kf(0, 0, "jump")] })).toMatchObject({ startValue: 1, absorbed: [], moves: [{ index: 0 }] });
    expect(laneTimeline({ track: "incoming", param: "volume", keyframes: [kf(8, 1, "jump")] })).toMatchObject({ startValue: 0, absorbed: [] });
  });

  it("an incoming control at its keyframes on the 1 or before, since nobody hears it before then", () => {
    expect(laneTimeline({ track: "incoming", param: "eq-low", keyframes: [kf(0, -1, "jump"), kf(32, 0, "jump")] })).toMatchObject({ startValue: -1, absorbed: [0], moves: [{ index: 1 }] });
  });

  it("tempo at its first keyframe, wherever it is; and an echo or loop always off", () => {
    expect(laneTimeline({ track: "outgoing", param: "tempo", keyframes: [kf(8, 126), kf(16, 128)] })).toMatchObject({ startValue: 126, absorbed: [0], moves: [{ index: 1 }] });
    expect(laneTimeline({ track: "outgoing", param: "tempo", keyframes: [] })).toBeNull();
    expect(laneTimeline({ track: "incoming", param: "loop", keyframes: [kf(0, 1, "jump")], loopBeats: 4 })).toMatchObject({ startValue: 0, absorbed: [] });
  });
});

describe("a track's level", () => {
  const transition = { lanes: [{ track: "incoming", param: "volume", keyframes: [kf(8, 1, "jump")] }] } satisfies { lanes: Lane[] };

  it("comes from its volume lane, and is at rest without one: the outgoing track full, the incoming one silent", () => {
    expect(trackVolume(transition, "incoming", 4)).toBe(0);
    expect(trackVolume(transition, "outgoing", 4)).toBe(1);
    expect(trackVolume({ lanes: [] }, "incoming", 4)).toBe(0);
  });

  it("is heard at a jump in, but not before it", () => {
    expect(heard(transition, "incoming", 8)).toBe(true);
    expect(heard(transition, "incoming", 4)).toBe(false);
  });
});

// The shared recipes, read through the lane maths the Execution plan uses.
describe("every recipe", () => {
  const place = { outgoingAt: { bar: 17, beat: 1 }, incomingAt: { bar: 1, beat: 1 }, tempos: { outgoing: 124, incoming: 128 } } as const;

  it.each(RECIPE_IDS)("%s hands over: the outgoing track ends silent, the incoming one full", (id) => {
    const transition = transitionFromRecipe(id, place);
    expect(trackVolume(transition, "outgoing", transition.lengthBeats)).toBe(0);
    expect(trackVolume(transition, "incoming", transition.lengthBeats)).toBe(1);
  });

  it("a bass swap never plays both basslines", () => {
    const transition = transitionFromRecipe("bass-swap", place);
    const low = (track: Lane["track"], beat: number) => {
      const lane = transition.lanes.find((candidate) => candidate.track === track && candidate.param === "eq-low");
      const timeline = lane === undefined ? null : laneTimeline(lane);
      return timeline === null ? 0 : (valueAt(timeline.keyframes, beat) ?? 0);
    };
    for (let beat = 0; beat <= transition.lengthBeats; beat += 0.25) {
      const bass = (track: Lane["track"]) => trackVolume(transition, track, beat) > 0 && low(track, beat) > -1;
      expect(bass("outgoing") && bass("incoming"), `beat ${String(beat)}`).toBe(false);
    }
  });
});
