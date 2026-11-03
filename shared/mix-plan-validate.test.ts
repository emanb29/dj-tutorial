import { describe, expect, it } from "vitest";
import { gridHashOf, type MixPlan, type Transition } from "./mix-plan.ts";
import { transitionFromRecipe } from "./mix-plan-recipes.ts";
import { mixPlanProblems } from "./mix-plan-validate.ts";
import { testGrid, testPlan } from "./mix-plan-test-support.ts";

const kinds = (plan: MixPlan, grids: ReadonlyMap<string, ReturnType<typeof testGrid>>) => mixPlanProblems(plan, grids).map((problem) => problem.kind);

const withTransition = (plan: MixPlan, index: number, change: (transition: Transition) => Transition): MixPlan => ({
  ...plan,
  transitions: plan.transitions.map((transition, each) => (each === index ? change(transition) : transition)),
});

describe("mixPlanProblems", () => {
  it("finds nothing wrong with a plan made from the library", () => {
    const { plan, grids } = testPlan(3);
    expect(mixPlanProblems(plan, grids)).toEqual([]);
  });

  it("stays quick and clean on a 25-track set (an hour and more)", () => {
    const { plan, grids } = testPlan(25, { recipe: "bass-swap" });
    const started = performance.now();
    expect(mixPlanProblems(plan, grids)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(50);
    expect(plan.transitions).toHaveLength(24);
  });

  it("collects every problem at once, each with its fix", () => {
    const { plan, grids } = testPlan(3);
    const broken: MixPlan = {
      ...plan,
      name: " ",
      tracks: plan.tracks.map((track, index) => (index === 2 ? { ...track, gainDb: 20 } : track)),
      transitions: [
        // Runs 8.2 beats past the end of track 1 (599.8 beats long).
        { ...transitionFromRecipe("crossfade-16", { outgoingAt: { bar: 137, beat: 1 }, incomingAt: { bar: 1, beat: 1 } }) },
        // Starts at bar 9 of track 2, before Transition 1 has brought it in (it ends at bar 17).
        {
          ...transitionFromRecipe("crossfade-16", { outgoingAt: { bar: 9, beat: 1 }, incomingAt: { bar: 1, beat: 1 } }),
          lanes: [
            { track: "outgoing", param: "eq-low", keyframes: [{ beat: 70, value: -2, curve: "jump" }] },
            {
              track: "outgoing",
              param: "eq-low",
              keyframes: [
                { beat: 10, value: 0, curve: "jump" },
                { beat: 4, value: 0, curve: "linear" },
              ],
            },
            { track: "outgoing", param: "echo-send", keyframes: [], echoBeats: 3 },
            { track: "incoming", param: "loop", keyframes: [{ beat: 0, value: 0.5, curve: "jump" }] },
          ],
        },
      ],
    };

    const problems = mixPlanProblems(broken, grids);

    expect(problems.map((problem) => [problem.kind, problem.track ?? null, problem.transition ?? null])).toEqual([
      ["no-name", null, null],
      ["value-out-of-range", 2, null],
      ["past-track-end", null, 0],
      ["overlap", null, 1],
      ["keyframe-outside", null, 1],
      ["value-out-of-range", null, 1],
      ["duplicate-lane", null, 1],
      ["keyframes-out-of-order", null, 1],
      ["lane-length", null, 1],
      ["lane-length", null, 1],
      ["value-out-of-range", null, 1],
    ]);
    expect(problems.find((problem) => problem.kind === "past-track-end")).toMatchObject({
      message: "Transition 1 runs 8.2 beats past the end of track 1.",
      fix: "Start it earlier, or shorten it.",
    });
    expect(problems.find((problem) => problem.kind === "overlap")).toMatchObject({
      message: "Transition 2 starts 32 beats before Transition 1 has finished.",
      fix: "Move Transition 2 later, or shorten Transition 1.",
    });
    for (const problem of problems) {
      expect(problem.message).not.toBe("");
      expect(problem.fix).not.toBe("");
    }
  });

  it("needs at least 2 tracks and one Transition per pair", () => {
    const { plan, grids } = testPlan(2);
    expect(kinds({ ...plan, tracks: plan.tracks.slice(0, 1), transitions: [] }, grids)).toEqual(["too-few-tracks"]);
    expect(kinds({ ...plan, tracks: [], transitions: [] }, grids)).toEqual(["too-few-tracks"]);
    expect(kinds({ ...plan, transitions: [] }, grids)).toEqual(["transition-count"]);
  });

  it("says which Transitions to check when a track was re-analysed", () => {
    const { plan, grids } = testPlan(4);
    const hash = plan.tracks[2]?.contentHash ?? "";
    const moved = new Map(grids).set(hash, testGrid({ firstBeatSec: 0.12 }));

    const problems = mixPlanProblems(plan, moved);

    expect(problems).toEqual([
      {
        kind: "grid-changed",
        track: 2,
        message: "Track 3 was re-analysed: its beat grid is not the one the plan was made on.",
        fix: "Check Transitions 2 and 3.",
      },
    ]);
    expect(plan.tracks[2]?.gridHash).toBe(gridHashOf(testGrid()));
  });

  it("checks the incoming track's end too", () => {
    const { plan, grids } = testPlan(2);
    const late = withTransition(plan, 0, (transition) => ({ ...transition, incomingAt: { bar: 140, beat: 1 } }));
    expect(mixPlanProblems(late, grids)).toEqual([
      expect.objectContaining({ kind: "past-track-end", transition: 0, message: "Transition 1 runs 20.2 beats past the end of track 2." }),
    ]);
  });

  it("refuses a Transition before the first track starts, and lengths of 0 or over 64 bars", () => {
    const { plan, grids } = testPlan(2);
    const later = { ...plan, tracks: plan.tracks.map((track, index) => (index === 0 ? { ...track, startAt: { bar: 130, beat: 1 as const } } : track)) };
    expect(kinds(later, grids)).toEqual(["starts-before-track"]);
    expect(kinds(withTransition(plan, 0, (transition) => ({ ...transition, lengthBeats: 0 })), grids)).toEqual(["bad-length"]);
    expect(kinds(withTransition(plan, 0, (transition) => ({ ...transition, lengthBeats: 300 })), grids)).toEqual(["bad-length"]);
  });

  it("skips the checks against a track's end while its file is not found", () => {
    const { plan } = testPlan(2);
    const late = withTransition(plan, 0, (transition) => ({ ...transition, outgoingAt: { bar: 400, beat: 1 } }));
    expect(mixPlanProblems(late, new Map())).toEqual([]);
  });

  it("accepts a valid loop and echo", () => {
    const { plan, grids } = testPlan(2);
    const held = withTransition(plan, 0, (transition) => ({
      ...transition,
      lanes: [
        ...transition.lanes,
        { track: "outgoing", param: "loop", loopBeats: 4, keyframes: [{ beat: 0, value: 1, curve: "jump" }, { beat: 16, value: 0, curve: "jump" }] },
        { track: "outgoing", param: "echo-send", echoBeats: 0.75, keyframes: [{ beat: 60, value: 0.5, curve: "linear" }] },
        { track: "incoming", param: "tempo", keyframes: [{ beat: 64, value: 124, curve: "ease" }] },
      ],
    }));
    expect(mixPlanProblems(held, grids)).toEqual([]);
  });
});
