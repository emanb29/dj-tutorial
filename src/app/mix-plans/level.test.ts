import { describe, expect, it } from "vitest";
import { SET_UP_PEAK_DB, setUpTrimDbForPeaks } from "@lessons/track.ts";
import { planTrackGainDb } from "./level.ts";

describe("planTrackGainDb", () => {
  it("brings a loud master's peak down to the Lessons' set-up level", () => {
    expect(planTrackGainDb(-0.3)).toBeCloseTo(SET_UP_PEAK_DB + 0.3, 9);
  });

  it("never boosts a quiet track, and treats an unmeasured one as the Lessons do", () => {
    expect(planTrackGainDb(-14)).toBe(0);
    expect(planTrackGainDb(Number.NEGATIVE_INFINITY)).toBe(0);
    // The same arithmetic a Lesson's set-up uses (setUpTrimDb), for one track with no measured peak.
    expect(planTrackGainDb(null)).toBe(setUpTrimDbForPeaks([undefined]));
    expect(planTrackGainDb(null)).toBe(-3);
  });
});
