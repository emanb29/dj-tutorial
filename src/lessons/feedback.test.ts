import { describe, expect, it } from "vitest";
import { classifyTap } from "./feedback.ts";

// 120 BPM from 0 s: a beat is 0.5 s, a bar 2 s, a phrase 16 s.
const grid = { bpm: 120, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 0 };
const phraseStarts = [0, 16, 32];

describe("classifyTap", () => {
  it("places a slightly late tap on the beat", () => {
    expect(classifyTap(grid, phraseStarts, 2.02)).toEqual({ kind: "tap", offsetMs: 20, onBeat: true, onDownbeat: true, onPhraseStart: false });
  });

  it("calls an early tap early, and off the beat beyond ±40 ms", () => {
    const tap = classifyTap(grid, phraseStarts, 2.95);
    expect(tap.offsetMs).toBeCloseTo(-50);
    expect(tap).toMatchObject({ onBeat: false, onDownbeat: false });
  });

  it("knows beat 3 of a bar is not the 1", () => {
    expect(classifyTap(grid, phraseStarts, 3.0)).toMatchObject({ onBeat: true, onDownbeat: false });
  });

  it("counts a tap within a beat of a phrase start as on the phrase", () => {
    expect(classifyTap(grid, phraseStarts, 15.6)).toMatchObject({ onPhraseStart: true });
    expect(classifyTap(grid, phraseStarts, 17)).toMatchObject({ onPhraseStart: false });
  });
});
