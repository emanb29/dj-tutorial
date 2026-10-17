import { describe, expect, it } from "vitest";
import { score } from "./evaluate.ts";

describe("scoring a grid against a known one", () => {
  const truth = { bpm: 140, firstBeatSec: 0.25, downbeatPhase: 2, durationSec: 60 };

  it("scores an exact grid as zero error with the right downbeat", () => {
    const result = score(truth, { bpm: 140, firstBeatSec: 0.25, downbeatPhase: 2 });
    expect(result.gridErrorMaxMs).toBeLessThan(1e-6);
    expect(result.downbeatCorrect).toBe(true);
    expect(result.tempoRatio).toBe(1);
  });

  it("flags a half-tempo grid and a wrong bar line", () => {
    const result = score(truth, { bpm: 70, firstBeatSec: 0.25, downbeatPhase: 0 });
    expect(result.tempoRatio).toBe(0.5);
    expect(result.downbeatCorrect).toBe(false);
  });
});
