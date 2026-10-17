import { describe, expect, it } from "vitest";
import { estimateGrid } from "./dj-core.ts";

function clicks(bpm: number, firstBeatSec: number, seconds: number) {
  const rate = 44_100;
  const signal = new Float32Array(seconds * rate);
  for (let t = firstBeatSec; t < seconds; t += 60 / bpm) {
    const start = Math.floor(t * rate);
    for (let i = 0; i < 200 && start + i < signal.length; i++) signal[start + i] = (1 - i / 200) * (i % 2 === 0 ? 0.9 : -0.9);
  }
  return signal;
}

describe("dj-core port", () => {
  it.each([
    [124, 0.1],
    [100, 0.37],
    [140, 0],
    [174, 0.2],
  ])("click track at %d BPM, first beat %d s", (bpm, firstBeatSec) => {
    const result = estimateGrid(clicks(bpm, firstBeatSec, 30), 44_100);
    if (!result.ok) throw new Error(result.failure.kind);
    const { grid } = result;
    const bpmError = Math.abs(grid.bpm - bpm) < 5 ? grid.bpm - bpm : 2 * grid.bpm - bpm;
    expect(Math.abs(bpmError)).toBeLessThan(0.05);
    const beat = (grid.firstBeatSec - firstBeatSec) / (60 / grid.bpm);
    expect(Math.abs((beat - Math.round(beat)) * (60_000 / grid.bpm))).toBeLessThan(20);
  });

  it("finds no beat in silence and refuses short audio", () => {
    expect(estimateGrid(new Float32Array(44_100 * 20), 44_100)).toEqual({
      ok: false,
      failure: { kind: "no-steady-beat" },
    });
    expect(estimateGrid(new Float32Array(1000), 44_100)).toMatchObject({ ok: false, failure: { kind: "too-short" } });
  });
});
