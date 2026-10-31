import { describe, expect, it } from "vitest";
import { camelotFromTonality, knownGridFromRekordbox, rekordboxBeatTimes, rekordboxGrid } from "./grid.ts";
import type { RekordboxTempo } from "./xml.ts";

const tempo = (inizioSec: number, bpm: number, battito = 1, metro = "4/4"): RekordboxTempo => ({ inizioSec, bpm, battito, metro });

describe("rekordboxGrid", () => {
  it("turns one TEMPO into the app's grid: first beat near 0, and which of them is bar 1", () => {
    // 120 BPM: a beat every 0.5 s. 1.1 s is beat 3, so 0.6 s is beat 2 and 0.1 s beat 1: the first
    // beat at or after -50 ms is 0.1 s, and it starts bar 1.
    expect(rekordboxGrid([tempo(1.1, 120, 3)])).toEqual({ kind: "constant", bpm: 120, firstBeatSec: expect.closeTo(0.1, 9) as number, downbeatPhase: 0 });
    // Beat 1 at 0.6: the first beat (0.1) is beat 4, so bar 1 is the grid's second beat.
    expect(rekordboxGrid([tempo(0.6, 120, 1)])).toMatchObject({ firstBeatSec: expect.closeTo(0.1, 9) as number, downbeatPhase: 1 });
  });

  it("allows a first beat just before 0, as the analysis does", () => {
    expect(rekordboxGrid([tempo(0.47, 120, 2)])).toMatchObject({ firstBeatSec: expect.closeTo(-0.03, 9) as number, downbeatPhase: 0 });
  });

  it("treats TEMPOs that carry on the same grid as one tempo", () => {
    const beat = 60 / 124;
    expect(rekordboxGrid([tempo(0.2, 124, 1), tempo(0.2 + 32 * beat, 124, 1), tempo(0.2 + 34 * beat, 124, 3)])).toMatchObject({ kind: "constant", bpm: 124 });
  });

  it("calls a grid whose tempo changes variable, with its average", () => {
    expect(rekordboxGrid([tempo(0, 120), tempo(8, 122)])).toEqual({ kind: "variable", segments: 2, bpmRange: [120, 122] });
    // The same BPM, but the beat jumps: not one grid either.
    expect(rekordboxGrid([tempo(0, 120), tempo(8.1, 120)])).toMatchObject({ kind: "variable" });
  });

  it("has no grid without TEMPOs, and none the app can use outside 4/4", () => {
    expect(rekordboxGrid([])).toEqual({ kind: "none" });
    expect(rekordboxGrid([tempo(0, 120, 1, "3/4")])).toEqual({ kind: "not-four-four", metro: "3/4" });
  });
});

describe("rekordboxBeatTimes", () => {
  it("lays every beat of a variable grid, each part at its own tempo", () => {
    const beats = rekordboxBeatTimes([tempo(0.5, 120), tempo(2.5, 60)], 5);

    expect(beats.map((beat) => Number(beat.toFixed(6)))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3.5, 4.5]);
  });
});

describe("knownGridFromRekordbox", () => {
  it("is the KnownBeatGrid a deck uses, every beat to the end, no generator sections", () => {
    const known = knownGridFromRekordbox({ kind: "constant", bpm: 120, firstBeatSec: 0.1, downbeatPhase: 1 }, 2.2);

    expect(known).toEqual({ origin: "rekordbox", bpm: 120, durationSec: 2.2, firstBeatSec: 0.1, downbeatPhase: 1, beatGrid: [0.1, 0.6, 1.1, 1.6, 2.1], phrases: [] });
  });
});

describe("camelotFromTonality", () => {
  it("reads rekordbox's key in either notation", () => {
    expect(camelotFromTonality("Am")).toBe("8A");
    expect(camelotFromTonality("8A")).toBe("8A");
    expect(camelotFromTonality("F#m")).toBe("11A");
    expect(camelotFromTonality("Gbm")).toBe("11A");
    expect(camelotFromTonality("Db")).toBe("3B");
    expect(camelotFromTonality("C#")).toBe("3B");
    expect(camelotFromTonality("B")).toBe("1B");
    expect(camelotFromTonality("")).toBeNull();
    expect(camelotFromTonality("H")).toBeNull();
  });
});
