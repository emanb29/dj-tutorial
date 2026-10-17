import { describe, expect, it } from "vitest";
import { SYNTHETIC_HOUSE, syntheticLessonTrack } from "./synthetic-track.ts";
import { barStart, peakDbfsOf, sliceTrack, trimKnobFor } from "./track.ts";

describe("sliceTrack", () => {
  const parent = syntheticLessonTrack(SYNTHETIC_HOUSE);
  const beat = 60 / parent.grid.bpm;

  it("keeps every downbeat where it was in the parent, measured from the slice's start", () => {
    const fromSec = barStart(parent.grid, 9) - 1.37 * beat;
    const slice = sliceTrack(parent, { fromSec, lengthSec: 12 }, 0);
    expect(slice.trackId).toBe(`${parent.trackId}#cue-1`);
    expect(slice.durationSec).toBe(12);
    // Bar 9's downbeat is 1.37 beats into the slice, and is bar 1 on the slice's grid.
    expect(barStart(slice.grid, 1)).toBeCloseTo(1.37 * beat, 9);
    expect(slice.grid.firstBeat).toBeGreaterThanOrEqual(0);
    expect(slice.grid.firstBeat).toBeLessThan(beat);
  });

  it("numbers slices so each is its own track", () => {
    expect(sliceTrack(parent, { fromSec: 3, lengthSec: 5 }, 2).trackId).toBe(`${parent.trackId}#cue-3`);
  });
});

describe("trimKnobFor and peakDbfsOf", () => {
  it("inverts the trim curve: +9 dB is fully right, −12 dB half left, and stays audible", () => {
    expect(trimKnobFor(9)).toBe(1);
    expect(trimKnobFor(20)).toBe(1);
    expect(trimKnobFor(-12)).toBe(-0.5);
    expect(trimKnobFor(-40)).toBe(-0.95);
  });

  it("finds the loudest sample of any channel", () => {
    expect(peakDbfsOf([Float32Array.from([0.1, -0.5]), Float32Array.from([0.25])])).toBeCloseTo(-6.02, 2);
    expect(peakDbfsOf([new Float32Array(4)])).toBe(Number.NEGATIVE_INFINITY);
  });
});
