import { describe, expect, it } from "vitest";
import { TAP_IDLE_RESET_MS, TAP_MIN_TAPS, TapTempo } from "./tap-tempo.ts";

const taps = (tempo: TapTempo, times: readonly number[]) => times.map((time) => tempo.tap(time)).at(-1) ?? null;

describe("TapTempo (Beat FX TAP)", () => {
  it("needs at least 4 taps before it gives a BPM", () => {
    const tempo = new TapTempo();
    expect(TAP_MIN_TAPS).toBe(4);
    expect(taps(tempo, [0, 500, 1000])).toBeNull();
    expect(tempo.tap(1500)).toBeCloseTo(120, 9);
  });

  it("uses the median interval, so one stray tap does not move it", () => {
    const tempo = new TapTempo();
    // 125 BPM is 480 ms; one late tap (+90 ms) and the next one early again.
    expect(taps(tempo, [0, 480, 960, 1530, 1920, 2400])).toBeCloseTo(125, 9);
  });

  it("starts over after 2 s without a tap", () => {
    const tempo = new TapTempo();
    taps(tempo, [0, 500, 1000, 1500]);
    const late = 1500 + TAP_IDLE_RESET_MS + 1;
    expect(taps(tempo, [late, late + 400, late + 800])).toBeNull();
    expect(tempo.tap(late + 1200)).toBeCloseTo(150, 9);
  });

  it("follows the latest taps: only the last 8 intervals count", () => {
    const tempo = new TapTempo();
    const slow = Array.from({ length: 10 }, (_, index) => index * 600);
    const fast = Array.from({ length: 9 }, (_, index) => 5400 + (index + 1) * 400);
    expect(taps(tempo, [...slow, ...fast])).toBeCloseTo(150, 9);
  });

  it("ignores a tap that is not later than the last one", () => {
    const tempo = new TapTempo();
    expect(taps(tempo, [0, 500, 500, 1000, 1500])).toBeCloseTo(120, 9);
  });
});
