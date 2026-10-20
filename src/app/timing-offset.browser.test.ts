import { afterEach, describe, expect, it } from "vitest";
import { offsetFromNearestClick } from "./controller-page/TimingCheck.tsx";
import { forgetTimingCache, resetTiming, saveTiming, timingCorrectionMs, timingFor } from "./timing-offset.ts";

const KEY = "learn-to-dj.timing-offset";

afterEach(() => {
  window.localStorage.removeItem(KEY);
  forgetTimingCache();
});

describe("the stored Timing check", () => {
  it("is kept per output mode, and is 0 where there is none", () => {
    saveTiming("controller", 42, 15, new Date("2026-10-17T12:00:00Z"));
    expect(timingCorrectionMs("controller")).toBe(42);
    expect(timingCorrectionMs("split-cue")).toBe(0);
    forgetTimingCache();
    expect(timingFor("controller")).toEqual({ offsetMs: 42, measuredAt: "2026-10-17T12:00:00.000Z", taps: 15 });
  });

  it("holds a stored value to ±150 ms, and ignores what it cannot read", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ "split-cue": { offsetMs: 900, measuredAt: "x", taps: 16 }, controller: { offsetMs: "late" } }));
    expect(timingCorrectionMs("split-cue")).toBe(150);
    expect(timingCorrectionMs("controller")).toBe(0);
    window.localStorage.setItem(KEY, "{not json");
    forgetTimingCache();
    expect(timingCorrectionMs("split-cue")).toBe(0);
  });

  it("resets one mode and keeps the others", () => {
    saveTiming("controller", 30, 16);
    saveTiming("two-devices", -20, 16);
    resetTiming("controller");
    expect(timingFor("controller")).toBeNull();
    expect(timingCorrectionMs("two-devices")).toBe(-20);
  });

  it("keeps speakers-and-FLX4-headphones apart from the other modes, and reads it back from storage", () => {
    saveTiming("controller", 30, 16);
    saveTiming("computer-and-controller-phones", 55, 16);
    forgetTimingCache();
    expect(timingCorrectionMs("computer-and-controller-phones")).toBe(55);
    expect(timingCorrectionMs("controller")).toBe(30);
    expect(timingCorrectionMs("two-devices")).toBe(0);
  });

  it("keeps PC MASTER OUT (dual master) apart from the other modes, and reads it back from storage", () => {
    saveTiming("computer-and-controller-phones", 55, 16);
    saveTiming("dual-master", -35, 16);
    forgetTimingCache();
    expect(timingCorrectionMs("dual-master")).toBe(-35);
    expect(timingCorrectionMs("computer-and-controller-phones")).toBe(55);
  });
});

describe("the Timing check's taps", () => {
  it("reads a tap's offset from the nearest click after the count-in (100 BPM, first click at 0.5 s)", () => {
    // Click 4 (the first counted) is at 0.5 + 4 × 0.6 = 2.9 s.
    expect(offsetFromNearestClick(2.95)).toBeCloseTo(50, 6);
    expect(offsetFromNearestClick(3.48)).toBeCloseTo(-20, 6);
    // Count-in clicks do not count.
    expect(offsetFromNearestClick(1.1)).toBeNull();
  });
});
