import { describe, expect, it } from "vitest";
import { boundedCorrectionMs, correctedInputTime, MAX_INPUT_CORRECTION_MS, measureTimingOffset, TIMING_CHECK_MIN_KEPT } from "./input-latency.ts";

/** 16 taps around `centre` ms with a small, symmetric jitter. */
const steady = (centre: number): number[] => [-12, -8, -6, -4, -3, -2, -1, 0, 0, 1, 2, 3, 4, 6, 8, 12].map((jitter) => centre + jitter);

describe("measureTimingOffset", () => {
  it("takes the median of steady taps", () => {
    expect(measureTimingOffset(steady(60))).toMatchObject({ kind: "measured", offsetMs: 60, kept: 16, rejected: 0 });
    expect(measureTimingOffset(steady(-25))).toMatchObject({ kind: "measured", offsetMs: -25 });
  });

  it("rejects stray taps (a miss, a double tap) instead of letting them pull the offset", () => {
    const taps = [...steady(40).slice(0, 14), 240, -200];
    const measured = measureTimingOffset(taps);
    expect(measured).toMatchObject({ kind: "measured", rejected: 2, kept: 14 });
    if (measured.kind !== "measured") throw new Error("expected a measurement");
    expect(measured.offsetMs).toBeGreaterThan(36);
    expect(measured.offsetMs).toBeLessThan(44);
  });

  it("keeps taps within 35 ms of the median even when the rest are very steady", () => {
    const taps = [...Array.from({ length: 14 }, () => 50), 80, 20];
    expect(measureTimingOffset(taps)).toMatchObject({ kind: "measured", offsetMs: 50, kept: 16, rejected: 0 });
  });

  it("asks for more taps when too few are left", () => {
    expect(measureTimingOffset(steady(10).slice(0, TIMING_CHECK_MIN_KEPT - 1))).toEqual({ kind: "too-few", kept: TIMING_CHECK_MIN_KEPT - 1, needed: TIMING_CHECK_MIN_KEPT });
    // 7 of 16 taps far off the beat: after rejection 9 remain, one short of the minimum.
    const scattered = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 300, -300, 280, -280, 260, -260, 240];
    expect(measureTimingOffset(scattered)).toEqual({ kind: "too-few", kept: 9, needed: TIMING_CHECK_MIN_KEPT });
  });

  it("refuses taps too unsteady to read a latency from", () => {
    const wild = Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 1 : -1) * (40 + index * 12));
    expect(measureTimingOffset(wild).kind).toBe("too-unsteady");
  });
});

describe("boundedCorrectionMs and correctedInputTime", () => {
  it("holds the correction to ±150 ms", () => {
    expect(boundedCorrectionMs(60)).toBe(60);
    expect(boundedCorrectionMs(400)).toBe(MAX_INPUT_CORRECTION_MS);
    expect(boundedCorrectionMs(-400)).toBe(-MAX_INPUT_CORRECTION_MS);
    expect(boundedCorrectionMs(Number.NaN)).toBe(0);
  });

  it("moves a late Learner's input earlier by their latency, never by more than the bound", () => {
    expect(correctedInputTime(1060, 60)).toBe(1000);
    expect(correctedInputTime(1000, -30)).toBe(1030);
    expect(correctedInputTime(1000, 1000)).toBe(850);
  });
});
