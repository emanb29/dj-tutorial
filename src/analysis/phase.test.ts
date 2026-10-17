import { describe, expect, it } from "vitest";
import { refinePhase } from "./phase.ts";
import { kickTrack } from "./test-signals.ts";

describe("phase refinement", () => {
  it.each([25, -18, 0])("moves a grid that is %d ms off back onto the kicks", (offsetMs) => {
    const audio = kickTrack(124, 0.137, 40);
    const refined = refinePhase(audio, 44_100, { bpm: 124, firstBeatSec: 0.137 + offsetMs / 1000 });
    // The rise of this sine kick peaks about 3.5 ms after its first sample (its energy builds up
    // over the first half cycle), so the refined grid lands that much late.
    expect(Math.abs(refined.shiftSec * 1000 + offsetMs)).toBeLessThanOrEqual(4);
    expect(refined.contrast).toBeGreaterThan(1.5);
  });
});
