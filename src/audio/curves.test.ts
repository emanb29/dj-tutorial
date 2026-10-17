import { describe, expect, it } from "vitest";
import {
  channelFaderGain,
  crossfaderGain,
  decibelsToGain,
  eqKnobToDecibels,
  filterKnobSettings,
  gainToDecibels,
  headphoneLevelToDecibels,
  masterKnobToDecibels,
  trimKnobToDecibels,
} from "./curves.ts";

describe("decibel conversion", () => {
  it("maps -6.02 dB to half amplitude and back", () => {
    expect(decibelsToGain(-6.0206)).toBeCloseTo(0.5, 4);
    expect(gainToDecibels(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it("maps silence to -Infinity and -Infinity to silence", () => {
    expect(gainToDecibels(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(decibelsToGain(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("EQ knob", () => {
  it("is 0 dB at centre, +6 dB fully right and a kill fully left", () => {
    expect(eqKnobToDecibels(0)).toBe(0);
    expect(eqKnobToDecibels(1)).toBe(6);
    expect(eqKnobToDecibels(-1)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("reaches -26 dB just before the kill", () => {
    expect(eqKnobToDecibels(-0.5)).toBeCloseTo(-13, 6);
    expect(eqKnobToDecibels(-0.999)).toBeCloseTo(-25.974, 3);
  });
});

describe("trim and master knobs", () => {
  it("trim spans silence to +9 dB with 0 dB at centre", () => {
    expect(trimKnobToDecibels(0)).toBe(0);
    expect(trimKnobToDecibels(1)).toBe(9);
    expect(trimKnobToDecibels(-0.5)).toBe(-12);
    expect(trimKnobToDecibels(-1)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("headphone level is silent at 0, −12 dB at a quarter, unity at the centre and +6 dB at the top", () => {
    expect(headphoneLevelToDecibels(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(headphoneLevelToDecibels(0.25)).toBeCloseTo(-12.04, 2);
    expect(headphoneLevelToDecibels(0.5)).toBe(0);
    expect(headphoneLevelToDecibels(1)).toBe(6);
  });

  it("master spans silence to +6 dB with 0 dB at centre", () => {
    expect(masterKnobToDecibels(0)).toBe(0);
    expect(masterKnobToDecibels(1)).toBe(6);
    expect(masterKnobToDecibels(-1)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("channel fader (the shared curve from shared/attempt.ts)", () => {
  it("is unity at the top and at the -120 dB gain floor at the bottom", () => {
    expect(channelFaderGain(1)).toBe(1);
    expect(gainToDecibels(channelFaderGain(0))).toBeCloseTo(-120, 6);
  });

  it("follows a squared curve: halfway is -12 dB, a quarter is -24 dB", () => {
    expect(gainToDecibels(channelFaderGain(0.5))).toBeCloseTo(-12.04, 2);
    expect(gainToDecibels(channelFaderGain(0.25))).toBeCloseTo(-24.08, 2);
  });
});

describe("crossfader (the shared curve from shared/attempt.ts)", () => {
  it("is constant power: both decks at −3 dB at the centre", () => {
    expect(gainToDecibels(crossfaderGain("A", 0.5))).toBeCloseTo(-3.01, 2);
    expect(gainToDecibels(crossfaderGain("B", 0.5))).toBeCloseTo(-3.01, 2);
  });

  it("keeps the summed power steady all the way across (cos/sin law)", () => {
    for (const position of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]) {
      expect(crossfaderGain("A", position) ** 2 + crossfaderGain("B", position) ** 2).toBeCloseTo(1, 6);
    }
    expect(crossfaderGain("A", 0.25)).toBeCloseTo(Math.cos(Math.PI / 8), 12);
    expect(crossfaderGain("B", 0.25)).toBeCloseTo(Math.sin(Math.PI / 8), 12);
  });

  it("cuts hard at the ends: fully one side is unity there and the other deck at the gain floor", () => {
    expect(crossfaderGain("A", 0)).toBe(1);
    expect(gainToDecibels(crossfaderGain("B", 0))).toBeCloseTo(-120, 6);
    expect(crossfaderGain("B", 1)).toBe(1);
    expect(gainToDecibels(crossfaderGain("A", 1))).toBeCloseTo(-120, 6);
  });
});

describe("filter knob", () => {
  it("is off in the centre dead zone", () => {
    expect(filterKnobSettings(0)).toEqual({ kind: "off" });
    expect(filterKnobSettings(0.01)).toEqual({ kind: "off" });
    expect(filterKnobSettings(-0.01)).toEqual({ kind: "off" });
  });

  it("is a low-pass to the left, closing to 100 Hz", () => {
    const fullLeft = filterKnobSettings(-1);
    expect(fullLeft).toMatchObject({ kind: "lowpass" });
    expect(fullLeft.kind === "lowpass" && fullLeft.cutoffHz).toBeCloseTo(100, 6);
  });

  it("is a high-pass to the right, opening to 10 kHz", () => {
    const fullRight = filterKnobSettings(1);
    expect(fullRight).toMatchObject({ kind: "highpass" });
    expect(fullRight.kind === "highpass" && fullRight.cutoffHz).toBeCloseTo(10_000, 6);
  });

  it("sweeps exponentially: halfway left is the geometric mean of 20 kHz and 100 Hz", () => {
    const halfLeft = filterKnobSettings(-0.5);
    expect(halfLeft.kind === "lowpass" && halfLeft.cutoffHz).toBeCloseTo(Math.sqrt(20_000 * 100), 3);
  });
});
