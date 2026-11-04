import { describe, expect, it } from "vitest";
import { jumpTarget, PREVIEW_JUMP_BARS, PREVIEW_JUMP_SEC, previewStart } from "./preview-start.ts";

// 120 BPM: a bar is 2 s, 16 bars 32 s. Bar 1 at 0.5 s.
const GRID = { bpm: 120, barOneSec: 0.5 };

describe("where a preview starts", () => {
  it("at a rekordbox cue named for the drop or the chorus, hot or memory, the first one", () => {
    const cues = [
      { kind: "hot" as const, name: "Intro", startSec: 0.5 },
      { kind: "memory" as const, name: "Chorus 2", startSec: 150 },
      { kind: "memory" as const, name: "DROP", startSec: 64.5 },
    ];
    expect(previewStart({ durationSec: 300, cues, grid: GRID })).toEqual({ sec: 64.5, why: "cue" });
    expect(previewStart({ durationSec: 300, cues: [{ kind: "hot", name: "the hook", startSec: 90 }] })).toEqual({ sec: 90, why: "cue" });
  });

  it("not at a cue whose name says nothing about the drop (a DJ's intro cue, a loop), nor one past the end", () => {
    expect(previewStart({ durationSec: 300, cues: [{ kind: "hot", name: "", startSec: 0.5 }] }).why).toBe("third");
    expect(previewStart({ durationSec: 300, cues: [{ kind: "hot", name: "Dropout", startSec: 12 }] }).why).toBe("third");
    expect(previewStart({ durationSec: 300, cues: [{ kind: "memory", name: "Drop", startSec: 400 }] }).why).toBe("third");
  });

  it("at the generator's first drop or chorus section (an Original), when no cue names one", () => {
    const sections = [
      { startSec: 0.5, section: "intro" },
      { startSec: 32.5, section: "build" },
      { startSec: 64.5, section: "drop" },
      { startSec: 160.5, section: "drop" },
    ];
    expect(previewStart({ durationSec: 240, sections, grid: GRID })).toEqual({ sec: 64.5, why: "section" });
  });

  it("at the analysis's first big rise in energy, past the intro, when nothing is named", () => {
    const energyRises = [
      { timeSec: 8.5, energyChangeDb: 9 },
      { timeSec: 48.5, energyChangeDb: 2 },
      { timeSec: 80.5, energyChangeDb: 7.5 },
      { timeSec: 144.5, energyChangeDb: 12 },
    ];
    expect(previewStart({ durationSec: 300, energyRises, grid: GRID })).toEqual({ sec: 80.5, why: "energy" });
  });

  it("else a third of the way in, on the 8-bar line at or before it when the grid is known", () => {
    // A third of 300 s is 100 s; 8 bars are 16 s from 0.5 s: 96.5 s.
    expect(previewStart({ durationSec: 300, grid: GRID })).toEqual({ sec: 96.5, why: "third" });
    expect(previewStart({ durationSec: 300 })).toEqual({ sec: 100, why: "third" });
  });

  it("from the top when the length is unknown, or the track too short to skip into", () => {
    expect(previewStart({})).toEqual({ sec: 0, why: "top" });
    expect(previewStart({ durationSec: 20 })).toEqual({ sec: 0, why: "top" });
  });
});

describe("jumping in a preview", () => {
  it("goes 16 bars either way with a grid, 30 s without", () => {
    expect(PREVIEW_JUMP_BARS).toBe(16);
    expect(PREVIEW_JUMP_SEC).toBe(30);
    expect(jumpTarget({ positionSec: 100, by: 1, durationSec: 300, grid: GRID })).toBe(132);
    expect(jumpTarget({ positionSec: 100, by: -2, durationSec: 300, grid: GRID })).toBe(36);
    expect(jumpTarget({ positionSec: 100, by: 1, durationSec: 300 })).toBe(130);
  });

  it("stops at the start, and just short of the end", () => {
    expect(jumpTarget({ positionSec: 10, by: -1, durationSec: 300 })).toBe(0);
    expect(jumpTarget({ positionSec: 290, by: 1, durationSec: 300 })).toBe(299);
    expect(jumpTarget({ positionSec: 290, by: 1, durationSec: null })).toBe(320);
  });
});
