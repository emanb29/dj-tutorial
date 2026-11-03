import { describe, expect, it } from "vitest";
import { gridBeat, heard, isPhraseStart, type Keyframe, orderedKeyframes, trackVolume, valueAt, valueBefore } from "./lanes.ts";

const kf = (beat: number, value: number, curve: Keyframe["curve"] = "linear"): Keyframe => ({ beat, value, curve });

describe("grid positions", () => {
  it("count beats from bar 1 beat 1", () => {
    expect(gridBeat({ bar: 1, beat: 1 })).toBe(0);
    expect(gridBeat({ bar: 17, beat: 1 })).toBe(64);
    expect(gridBeat({ bar: 2, beat: 3 })).toBe(6);
  });

  it("find phrase starts every 8 bars from bar 1, from wherever the Transition starts", () => {
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
  const lane = [kf(0, 0), kf(8, 1), kf(16, 0.5, "jump"), kf(24, 0, "ease")];

  it("holds before the first keyframe and after the last", () => {
    expect(valueAt(lane, -4)).toBe(0);
    expect(valueAt(lane, 40)).toBe(0);
    expect(valueAt([], 4)).toBeNull();
  });

  it("ramps linearly, eases, and jumps on the keyframe's beat", () => {
    expect(valueAt(lane, 4)).toBe(0.5);
    expect(valueAt(lane, 12)).toBe(1);
    expect(valueAt(lane, 16)).toBe(0.5);
    expect(valueBefore(lane, 16)).toBe(1);
    expect(valueAt(lane, 20)).toBe(0.25);
    expect(valueAt(lane, 18)).toBeCloseTo(0.5 - 0.5 * (0.25 * 0.25 * (3 - 0.5)));
  });

  it("just before a ramp's end is the ramp's own value", () => {
    expect(valueBefore(lane, 8)).toBe(1);
    expect(valueBefore(lane, 0)).toBe(0);
  });

  it("orders keyframes by beat, keeping each one's index", () => {
    const unordered = { track: "outgoing", param: "volume", keyframes: [kf(8, 1), kf(0, 0)] } as const;
    expect(orderedKeyframes(unordered).map(({ index }) => index)).toEqual([1, 0]);
  });
});

describe("a track's level", () => {
  const transition = { lanes: [{ track: "incoming", param: "volume", keyframes: [kf(0, 0), kf(8, 1, "jump")] }] } as const;

  it("comes from its volume lane, and is full without one", () => {
    expect(trackVolume(transition, "incoming", 4)).toBe(0);
    expect(trackVolume(transition, "outgoing", 4)).toBe(1);
  });

  it("is heard at a jump in, but not before it", () => {
    expect(heard(transition, "incoming", 8)).toBe(true);
    expect(heard(transition, "incoming", 4)).toBe(false);
  });
});
