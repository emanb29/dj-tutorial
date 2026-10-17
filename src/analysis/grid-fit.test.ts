import { describe, expect, it } from "vitest";
import { fitGrid, type FittedGrid } from "./grid-fit.ts";

function fitted(beats: readonly number[], downbeats: readonly number[] = []): FittedGrid {
  const fit = fitGrid(beats, downbeats);
  if (!fit.ok) throw new Error(`fit failed: ${JSON.stringify(fit.failure)}`);
  return fit.grid;
}

describe("least-squares grid fit", () => {
  const period = 60 / 124;
  const beatAt = (n: number) => 0.137 + n * period;
  const truth = Array.from({ length: 700 }, (_, n) => beatAt(n));

  it("recovers tempo and phase from beats quantised to 20 ms frames", () => {
    const fit = fitted(truth.map((t) => Math.round(t * 50) / 50));
    expect(fit.bpm).toBeCloseTo(124, 3);
    expect(Math.abs(fit.firstBeatSec - 0.137)).toBeLessThan(0.002);
  });

  it("ignores missing beats, extra beats and outliers", () => {
    const messy = truth
      .filter((_, n) => n % 37 !== 5)
      .concat([10.05, 50.2, 123.4])
      .sort((a, b) => a - b);
    const fit = fitted(messy);
    expect(fit.bpm).toBeCloseTo(124, 3);
    expect(fit.detected - fit.inliers).toBeGreaterThanOrEqual(3);
  });

  it("votes the downbeat phase from the downbeats, tolerating a few wrong ones", () => {
    const downbeats = truth.filter((_, n) => n % 4 === 2).concat([beatAt(5), beatAt(9)]);
    const fit = fitted(truth, downbeats);
    expect(fit.downbeatPhase).toBe(2);
    expect(fit.downbeatAgreement).toBeGreaterThan(0.9);
  });

  it("keeps the on-beat phase when a minority of stretches lock to the off-beat", () => {
    // Beats 100-249 (about a fifth of the track) sit half a beat late, as Beat This! does on open hats.
    const locked = truth.map((t, n) => (n >= 100 && n < 250 ? t + period / 2 : t));
    const fit = fitted(locked);
    expect(fit.bpm).toBeCloseTo(124, 3);
    expect(Math.abs(fit.firstBeatSec - 0.137)).toBeLessThan(0.002);
    expect(fit.offBeats).toBe(150);
  });

  it("folds half-tempo stretches into the full-tempo grid", () => {
    const beat140 = 60 / 140;
    const beats = Array.from({ length: 800 }, (_, n) => 0.25 + n * beat140).filter((_, n) => n < 300 || n % 2 === 0);
    expect(fitted(beats).bpm).toBeCloseTo(140, 3);
  });

  it("reports too few beats as a value, not a throw", () => {
    expect(fitGrid([1, 2, 3])).toEqual({ ok: false, failure: { kind: "too-few-beats", detected: 3, minimum: 8 } });
  });
});
