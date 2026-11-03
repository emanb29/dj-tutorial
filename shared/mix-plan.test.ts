import { describe, expect, it } from "vitest";
import {
  addBeats,
  bar1Sec,
  beatIndexOf,
  beatsInTrack,
  gridHashOf,
  gridPosAt,
  lastPhraseStartFitting,
  MixPlanSchema,
  phraseOf,
  phraseStart,
  restingValue,
  secondsAtBeat,
} from "./mix-plan.ts";
import { testGrid, testPlan } from "./mix-plan-test-support.ts";

describe("grid positions", () => {
  it("counts beats from bar 1, beat 1", () => {
    expect(beatIndexOf({ bar: 1, beat: 1 })).toBe(0);
    expect(beatIndexOf({ bar: 1, beat: 4 })).toBe(3);
    expect(beatIndexOf({ bar: 2, beat: 1 })).toBe(4);
    expect(beatIndexOf({ bar: 17, beat: 3 })).toBe(66);
  });

  it("turns a beat count back into bar and beat, the beat at or before it", () => {
    expect(gridPosAt(0)).toEqual({ bar: 1, beat: 1 });
    expect(gridPosAt(66)).toEqual({ bar: 17, beat: 3 });
    expect(gridPosAt(66.5)).toEqual({ bar: 17, beat: 3 });
    expect(gridPosAt(-3)).toEqual({ bar: 1, beat: 1 });
    for (const beats of [0, 1, 7, 31, 32, 255]) expect(beatIndexOf(gridPosAt(beats))).toBe(beats);
  });

  it("moves a position by beats", () => {
    expect(addBeats({ bar: 1, beat: 3 }, 2)).toEqual({ bar: 2, beat: 1 });
    expect(addBeats({ bar: 9, beat: 1 }, 64)).toEqual({ bar: 25, beat: 1 });
  });

  it("names phrases of 8 bars, 1-based", () => {
    expect(phraseOf({ bar: 1, beat: 1 })).toEqual({ phrase: 1, barInPhrase: 1 });
    expect(phraseOf({ bar: 8, beat: 4 })).toEqual({ phrase: 1, barInPhrase: 8 });
    expect(phraseOf({ bar: 17, beat: 1 })).toEqual({ phrase: 3, barInPhrase: 1 });
    expect(phraseStart(3)).toEqual({ bar: 17, beat: 1 });
  });

  it("places beats in track time from bar 1, which the downbeat phase moves", () => {
    const grid = testGrid({ bpm: 120, firstBeatSec: 0.25, downbeatPhase: 2, durationSec: 60 });
    expect(bar1Sec(grid)).toBeCloseTo(1.25);
    expect(secondsAtBeat(grid, 4)).toBeCloseTo(3.25);
    expect(beatsInTrack(grid)).toBeCloseTo(117.5);
    // No downbeats found: bar 1 is the first beat.
    expect(bar1Sec(testGrid({ firstBeatSec: 0.25, downbeatPhase: null }))).toBeCloseTo(0.25);
  });

  it("finds the last phrase a span still fits in", () => {
    // 120 BPM, bar 1 at 0.1 s, 300 s: 599.8 beats, so 16-bar spans fit from phrase 17 (bar 129) at the latest.
    expect(lastPhraseStartFitting(testGrid(), 64)).toEqual({ bar: 129, beat: 1 });
    expect(lastPhraseStartFitting(testGrid({ durationSec: 20 }), 64)).toBeNull();
  });
});

describe("gridHashOf", () => {
  it("is stable for the same grid and changes when the grid moves", () => {
    const grid = testGrid();
    expect(gridHashOf(grid)).toBe(gridHashOf({ ...grid }));
    expect(gridHashOf(grid)).toMatch(/^grid1-[0-9a-f]{8}$/);
    expect(gridHashOf({ ...grid, bpm: 120.01 })).not.toBe(gridHashOf(grid));
    expect(gridHashOf({ ...grid, firstBeatSec: 0.11 })).not.toBe(gridHashOf(grid));
    expect(gridHashOf({ ...grid, downbeatPhase: 1 })).not.toBe(gridHashOf(grid));
    // The length is not part of the grid: the same grid, read from a file one sample longer, keeps its name.
    expect(gridHashOf({ ...grid, durationSec: 300.001 })).toBe(gridHashOf(grid));
  });
});

describe("restingValue", () => {
  it("has the outgoing track at full and the incoming one silent before any keyframe", () => {
    expect(restingValue("outgoing", "volume")).toBe(1);
    expect(restingValue("incoming", "volume")).toBe(0);
    expect(restingValue("outgoing", "eq-low")).toBe(0);
    expect(restingValue("incoming", "echo-send")).toBe(0);
  });
});

describe("MixPlanSchema", () => {
  it("accepts a plan and refuses unknown fields, so a plan never carries a path", () => {
    const { plan } = testPlan(2);
    expect(MixPlanSchema.safeParse(plan).success).toBe(true);
    const withPath = { ...plan, tracks: plan.tracks.map((track) => ({ ...track, path: "Music/a.mp3" })) };
    expect(MixPlanSchema.safeParse(withPath).success).toBe(false);
  });
});
