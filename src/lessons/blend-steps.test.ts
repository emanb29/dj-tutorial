import { describe, expect, it } from "vitest";
import { BLEND_STEPS, blendPose, followBlend, START_BLEND, type BlendFollow, type BlendStepResult } from "./blend-steps.ts";

/** Feeds channel-fader positions (A, B), one move at a time, and collects the step results. */
function play(moves: readonly (readonly [number, number])[], from: BlendFollow = START_BLEND): { state: BlendFollow; results: BlendStepResult[] } {
  return moves.reduce<{ state: BlendFollow; results: BlendStepResult[] }>(
    ({ state, results }, [a, b]) => {
      const next = followBlend(state, blendPose(a, b));
      return { state: next.state, results: next.result === null ? results : [...results, next.result] };
    },
    { state: from, results: [] },
  );
}

/** A drag on one fader from `from` to `to`, in tenths, with the other fader held. */
const drag = (deck: "A" | "B", from: number, to: number, other: number): [number, number][] =>
  Array.from({ length: 11 }, (_, index) => {
    const value = from + ((to - from) * index) / 10;
    return deck === "A" ? [value, other] : [other, value];
  });

describe("the stepped blend (one pointer: B ¾, A ¾, B up, A down)", () => {
  it("counts each of the four steps, in order, as a good step", () => {
    const { results, state } = play([...drag("B", 0, 0.75, 1), ...drag("A", 1, 0.75, 0.75), ...drag("B", 0.75, 1, 0.75), ...drag("A", 0.75, 0, 1)]);
    expect(results).toEqual(BLEND_STEPS.map((_, step) => ({ step, good: true, mistake: null })));
    expect(state.next).toBe(BLEND_STEPS.length);
  });

  it("flags B pushed all the way up while A is still full: +3 dB, once per drag", () => {
    const { results } = play(drag("B", 0, 1, 1));
    expect(results).toEqual([
      { step: 0, good: true, mistake: null },
      { step: 1, good: false, mistake: expect.stringContaining("+3 dB") as string },
    ]);
  });

  it("flags A taken down before B is up: the level dips", () => {
    const { results } = play([...drag("B", 0, 0.75, 1), ...drag("A", 1, 0, 0.75)]);
    expect(results.at(-1)).toMatchObject({ good: false, mistake: expect.stringContaining("dip") as string });
  });

  it("starts over when the faders are back where a blend starts (a practice loop)", () => {
    const done = play([...drag("B", 0, 0.75, 1), ...drag("A", 1, 0.75, 0.75)]).state;
    expect(play([[1, 0], ...drag("B", 0, 0.75, 1)], done).results).toEqual([{ step: 0, good: true, mistake: null }]);
  });
});
