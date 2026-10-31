import { describe, expect, it } from "vitest";
import { barStart, cuedAt, heardTimeOf, lessonTrackFromAnalysis, lessonTrackFromKnownGrid, phraseOf } from "./track.ts";

describe("barStart", () => {
  it("puts bar 1 on the grid's first downbeat and counts 4 beats a bar", () => {
    // 120 BPM: a beat is 0.5 s. The first beat is at 0.25 s and beat 1 is the downbeat.
    const grid = { bpm: 120, firstBeat: 0.25, downbeatIndex: 1, rmsResidualMs: 2 };
    expect(barStart(grid, 1)).toBeCloseTo(0.75);
    expect(barStart(grid, 9)).toBeCloseTo(16.75);
  });
});

describe("lessonTrackFromKnownGrid (an Original)", () => {
  const track = lessonTrackFromKnownGrid(
    { id: "orig-1", title: "Night Bus", attribution: { text: "an original", url: null } },
    {
      origin: "generator-meta",
      bpm: 120,
      durationSec: 130,
      firstBeatSec: 1,
      downbeatPhase: 0,
      beatGrid: [],
      phrases: [
        { startSec: 1, bar: 1, lengthBars: 16, section: "intro" },
        { startSec: 33, bar: 17, lengthBars: 8, section: "breakdown" },
        { startSec: 49, bar: 25, lengthBars: 16, section: "drop" },
      ],
    },
  );

  it("has an exact grid", () => {
    expect(track.grid).toEqual({ bpm: 120, firstBeat: 1, downbeatIndex: 0, rmsResidualMs: 0 });
    expect(track.source).toBe("original");
  });

  it("marks a phrase start every 8 bars from bar 1 until the track ends", () => {
    // 16 s per phrase from 1 s: 1, 17, … 113 (129 would leave no full bar before 130 s).
    expect(track.phraseStarts).toEqual([1, 17, 33, 49, 65, 81, 97, 113]);
  });

  it("names each section by the 8-bar phrase it starts on", () => {
    expect(track.sections).toEqual([
      { name: "intro", phrase: 1 },
      { name: "breakdown", phrase: 3 },
      { name: "drop", phrase: 4 },
    ]);
  });
});

describe("lessonTrackFromKnownGrid (a grid set in rekordbox)", () => {
  // Bar 1 is the grid's second beat (downbeatPhase 1): phrases count from there, 8 bars each.
  const track = lessonTrackFromKnownGrid(
    { id: "local-file:a", title: "Brothers", attribution: { text: "your file", url: null } },
    { origin: "rekordbox", bpm: 120, durationSec: 40, firstBeatSec: 0.1, downbeatPhase: 1, beatGrid: [], phrases: [] },
  );

  it("grades on rekordbox's grid, phrases aligned to its bar 1, and is the Learner's own track, not an Original", () => {
    expect(track.grid).toEqual({ bpm: 120, firstBeat: 0.1, downbeatIndex: 1, rmsResidualMs: 0 });
    expect(track.phraseStarts).toEqual([0.6, 16.6, 32.6]);
    expect(track.sections).toEqual([]);
    expect(track.source).toBe("starter-pack");
  });
});

describe("lessonTrackFromAnalysis (a starter-pack track)", () => {
  const base = {
    bpm: 125,
    firstBeatSec: 0.1,
    durationSec: 60,
    downbeatPhase: 2,
    residualRmsMs: 4,
  };

  it("takes the fitted grid and has no named sections", () => {
    const track = lessonTrackFromAnalysis({ id: "sp/1.mp3", title: "Brothers", attribution: { text: "x", url: "u" } }, base);
    expect(track).not.toBeNull();
    expect(track?.grid).toEqual({ bpm: 125, firstBeat: 0.1, downbeatIndex: 2, rmsResidualMs: 4 });
    expect(track?.sections).toEqual([]);
    expect(track?.source).toBe("starter-pack");
  });

  it("refuses an analysis without bar 1 or a residual, which cannot be graded", () => {
    const meta = { id: "sp/1.mp3", title: "Brothers", attribution: { text: "x", url: "u" } };
    expect(lessonTrackFromAnalysis(meta, { ...base, downbeatPhase: null })).toBeNull();
    expect(lessonTrackFromAnalysis(meta, { ...base, residualRmsMs: null })).toBeNull();
  });
});

describe("phraseOf", () => {
  it("finds the 1-based phrase of a section by name", () => {
    const sections = [
      { name: "intro", phrase: 1 },
      { name: "breakdown", phrase: 5 },
      { name: "drop", phrase: 7 },
      { name: "breakdown", phrase: 9 },
    ];
    expect(phraseOf(sections, "breakdown")).toBe(5);
    expect(phraseOf(sections, "breakdown", 6)).toBe(9);
    expect(phraseOf(sections, "outro")).toBeNull();
  });
});

describe("heardTimeOf", () => {
  it("maps a track position to the heard time the deck plays it", () => {
    const playhead = {
      segments: [
        { fromCtx: 10, pos: 0, rate: 0 },
        { fromCtx: 12, pos: 0, rate: 1 },
        { fromCtx: 20, pos: 8, rate: 0 },
      ],
    };
    expect(heardTimeOf(playhead, 3)).toBeCloseTo(15);
    expect(heardTimeOf(playhead, 9)).toBeNull();
  });

  it("finds the first time at or after `notBefore`, when the deck played the position more than once", () => {
    const playhead = {
      segments: [
        { fromCtx: 0, pos: 0, rate: 1 },
        { fromCtx: 10, pos: 0, rate: 1 },
      ],
    };
    expect(heardTimeOf(playhead, 3)).toBeCloseTo(3);
    expect(heardTimeOf(playhead, 3, 10)).toBeCloseTo(13);
    expect(heardTimeOf(playhead, 3, 14)).toBeNull();
  });
});

describe("cuedAt", () => {
  it("finds when the deck was cued exactly to a position", () => {
    const playhead = {
      segments: [
        { fromCtx: 0, pos: 5, rate: 1 },
        { fromCtx: 4, pos: 2, rate: 1 },
        { fromCtx: 9, pos: 5, rate: 1 },
      ],
    };
    expect(cuedAt(playhead, 5)).toBe(0);
    expect(cuedAt(playhead, 5, 1)).toBe(9);
    expect(cuedAt(playhead, 6)).toBeNull();
  });
});
