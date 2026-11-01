import { describe, expect, it } from "vitest";
import { energySections } from "./energy-sections.ts";

describe("energySections", () => {
  const sampleRate = 1000;
  // Eight 10 s phrases: loud except phrases 4 and 5, a breakdown at a tenth of the level (−20 dB).
  const levels = [1, 1, 1, 0.1, 0.1, 1, 1, 1];
  const phraseStarts = levels.map((_, index) => index * 10);
  const channel = Float32Array.from({ length: levels.length * 10 * sampleRate }, (_, sample) => {
    const level = levels[Math.floor(sample / (10 * sampleRate))] ?? 0;
    return level * Math.sin(sample / 3);
  });

  it("names the quiet phrases a breakdown and the rest groove, one section per change", () => {
    expect(energySections([channel], sampleRate, phraseStarts)).toEqual([
      { name: "groove", phrase: 1 },
      { name: "breakdown", phrase: 4 },
      { name: "groove", phrase: 6 },
    ]);
  });

  it("calls a track of one level all groove", () => {
    const steady = Float32Array.from({ length: 30 * sampleRate }, (_, sample) => Math.sin(sample / 3));
    expect(energySections([steady], sampleRate, [0, 10, 20])).toEqual([{ name: "groove", phrase: 1 }]);
  });

  it("names nothing without phrases", () => {
    expect(energySections([channel], sampleRate, [])).toEqual([]);
  });
});
