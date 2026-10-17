import { describe, expect, it } from "vitest";
import { phraseHints } from "./phrases.ts";
import { waveformOverview } from "./waveform.ts";

const RATE = 8000;

/** Seeded noise whose level jumps from `quiet` to `loud` at `jumpSec`. */
function levelStep(seconds: number, jumpSec: number, quiet: number, loud: number) {
  let seed = 1;
  return Float32Array.from({ length: seconds * RATE }, (_, i) => {
    seed = (seed * 16807) % 2147483647;
    const noise = (seed / 2147483647) * 2 - 1;
    return noise * (i / RATE < jumpSec ? quiet : loud);
  });
}

describe("phrase hints", () => {
  // 120 BPM: a beat every 0.5 s, a bar every 2 s. Bar 1 starts on beat 1 (0.5 s), so bar 17 starts at 32.5 s.
  const grid = { bpm: 120, firstBeatSec: 0, downbeatPhase: 1 };
  const signal = levelStep(80, 32.5, 0.05, 0.4);
  const hints = phraseHints(grid, waveformOverview(signal, RATE), 80);

  it("marks every 8-bar boundary that has 8 whole bars on both sides", () => {
    expect(hints.map((h) => h.bar)).toEqual([9, 17, 25]);
    expect(hints.map((h) => h.timeSec)).toEqual([16.5, 32.5, 48.5]);
  });

  it("calls the jump in level an energy rise of about 18 dB and the rest steady", () => {
    const [before, jump, after] = hints;
    expect(jump?.kind).toBe("energy-up");
    expect(jump?.energyChangeDb).toBeCloseTo(20 * Math.log10(0.4 / 0.05), 0);
    expect(before?.kind).toBe("steady");
    expect(after?.kind).toBe("steady");
  });

  it("counts bars from the first grid beat when the downbeat is unknown", () => {
    const unknownBar = phraseHints({ ...grid, downbeatPhase: null }, waveformOverview(signal, RATE), 80);
    expect(unknownBar[0]?.timeSec).toBe(16);
  });
});
