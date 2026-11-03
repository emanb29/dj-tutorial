import { describe, expect, it } from "vitest";
import { ALL_CONTROL_IDS, type ControlId } from "@app/controller/control-ids.ts";
import { COMPLEXITY_WEIGHTS, ratingFor } from "./complexity.ts";
import { deriveExecution } from "./execution-plan.ts";
import type { Keyframe, Lane, Transition } from "@shared/mix-plan.ts";

const DECKS = { outgoing: "A", incoming: "B" } as const;
const EVERYTHING: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS);
const kf = (beat: number, value: number, curve: Keyframe["curve"] = "linear"): Keyframe => ({ beat, value, curve });
const transition = (lengthBeats: number, lanes: Lane[]): Transition => ({ recipe: "custom", outgoingAt: { bar: 17, beat: 1 }, incomingAt: { bar: 1, beat: 1 }, lengthBeats, lanes });

describe("the weights table", () => {
  it("is versioned, and weights every factor", () => {
    expect(COMPLEXITY_WEIGHTS.version).toBe(1);
    expect(Object.keys(COMPLEXITY_WEIGHTS.points).sort()).toEqual(
      ["dense-bar", "fine-timing", "hand-jump", "long-ramp", "not-unlocked", "one-hand-two-moves", "tempo-ride", "three-hands"].sort(),
    );
  });

  it("maps a score onto 1–5 by its floors", () => {
    expect([0, 1, 3, 4, 6, 7, 10, 11, 40].map(ratingFor)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe("factors the recipes don't reach", () => {
  it("a ramp over 8 bars that must end on a phrase is a long precise ramp", () => {
    const plan = deriveExecution(transition(64, [{ track: "incoming", param: "volume", keyframes: [kf(0, 0), kf(64, 1)] }]), DECKS, EVERYTHING);
    expect(plan.complexity.reasons).toEqual([{ factor: "long-ramp", beat: 0, lanes: [0], points: 1 }]);
    const offPhrase = deriveExecution(transition(64, [{ track: "incoming", param: "volume", keyframes: [kf(0, 0), kf(60, 1)] }]), DECKS, EVERYTHING);
    expect(offPhrase.complexity.reasons).toEqual([]);
  });

  it("a tempo move while only one track is heard is no tempo ride", () => {
    const plan = deriveExecution(
      transition(32, [
        { track: "incoming", param: "volume", keyframes: [kf(0, 0)] },
        { track: "outgoing", param: "tempo", keyframes: [kf(0, 124), kf(32, 126)] },
      ]),
      DECKS,
      EVERYTHING,
    );
    expect(plan.complexity.reasons.map(({ factor }) => factor)).not.toContain("tempo-ride");
  });
});

it("is never a gate: a Transition no one could play still derives every move and rates 5", () => {
  const everything = transition(16, [
    { track: "outgoing", param: "eq-low", keyframes: [kf(0, 0), kf(4, -1, "jump"), kf(4.5, 0, "jump"), kf(5, -1, "jump")] },
    { track: "outgoing", param: "eq-high", keyframes: [kf(0, 0), kf(4, -1, "jump")] },
    { track: "incoming", param: "eq-low", keyframes: [kf(0, -1), kf(4, 0, "jump")] },
    { track: "incoming", param: "tempo", keyframes: [kf(0, 124), kf(16, 128)] },
    { track: "outgoing", param: "echo-send", keyframes: [kf(0, 0), kf(4, 1, "jump")], echoBeats: 0.5 },
  ]);
  const plan = deriveExecution(everything, DECKS, new Set());
  expect(plan.complexity.rating).toBe(5);
  expect(plan.steps.filter(({ startBeat }) => startBeat === 4)).toHaveLength(4);
});
