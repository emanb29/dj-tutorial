import { describe, expect, it } from "vitest";
import { SYNTHETIC_HOUSE, synthesizeHouse, syntheticLessonTrack } from "./synthetic-track.ts";
import { barStart } from "./track.ts";

const RATE = 8000;
const samples = synthesizeHouse(SYNTHETIC_HOUSE, RATE);

/** RMS of the 60 ms after `sec`, minus the 60 ms before it: positive when something hits there. */
function onsetRise(sec: number): number {
  const window = Math.round(0.06 * RATE);
  const at = Math.round(sec * RATE);
  const rms = (from: number) => Math.sqrt(samples.slice(from, from + window).reduce((sum, x) => sum + x * x, 0) / window);
  return rms(at) - rms(at - window);
}

describe("the synthetic house track", () => {
  const track = syntheticLessonTrack(SYNTHETIC_HOUSE);

  it("is a 124 BPM, 80-bar track with an exact grid from 0 s", () => {
    expect(track.grid).toEqual({ bpm: 124, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 0 });
    expect(track.durationSec).toBeCloseTo((80 * 4 * 60) / 124 + 1.5, 5);
    expect(samples.length).toBe(Math.round(track.durationSec * RATE));
  });

  it("names its sections by 8-bar phrase: intro, groove, breakdown, build, drop, outro", () => {
    expect(track.sections).toEqual([
      { name: "intro", phrase: 1 },
      { name: "groove", phrase: 3 },
      { name: "breakdown", phrase: 5 },
      { name: "build", phrase: 6 },
      { name: "drop", phrase: 7 },
      { name: "outro", phrase: 9 },
    ]);
    expect(track.phraseStarts).toHaveLength(10);
  });

  it("has a kick on the beat in the groove and none in the breakdown", () => {
    const grooveBeat = barStart(track.grid, 20);
    const breakdownBeat = barStart(track.grid, 36);
    expect(onsetRise(grooveBeat)).toBeGreaterThan(0.05);
    expect(onsetRise(breakdownBeat)).toBeLessThan(0.02);
  });

  it("peaks at -6 dBFS, well clear of clipping", () => {
    const peak = samples.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
    expect(20 * Math.log10(peak)).toBeCloseTo(-6, 1);
  });
});
