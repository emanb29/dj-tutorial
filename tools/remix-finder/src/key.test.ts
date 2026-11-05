import { describe, expect, it } from "vitest";
import { camelotCode, estimateKey, harmony, parseCamelot } from "./key.ts";

const RATE = 22_050;

/** Notes (MIDI numbers) sounding together for `seconds`, with a few harmonics, like a pad. */
function chord(notes: readonly number[], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (const note of notes) {
    const hz = 440 * 2 ** ((note - 69) / 12);
    for (const [harmonic, gain] of [[1, 1], [2, 0.4], [3, 0.2]] as const) {
      for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + gain * Math.sin((2 * Math.PI * hz * harmonic * i) / RATE);
    }
  }
  return out;
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("camelot", () => {
  it.each([
    [{ tonic: 0, mode: "major" as const }, "8B"],
    [{ tonic: 9, mode: "minor" as const }, "8A"],
    [{ tonic: 7, mode: "major" as const }, "9B"],
    [{ tonic: 4, mode: "major" as const }, "12B"],
    [{ tonic: 4, mode: "minor" as const }, "9A"],
    [{ tonic: 5, mode: "minor" as const }, "4A"],
  ])("%o → %s", (key, code) => {
    expect(camelotCode(key)).toBe(code);
  });

  it("reads codes and rejects others", () => {
    expect(parseCamelot("12b")).toEqual({ number: 12, letter: "B" });
    expect(parseCamelot("13A")).toBeNull();
  });

  it.each([
    ["8A", "8A", "same"],
    ["8A", "8B", "relative"],
    ["8A", "9A", "neighbour"],
    ["12A", "1A", "neighbour"],
    ["8A", "9B", "clash"],
    ["8A", "3A", "clash"],
  ])("%s with %s is %s", (a, b, expected) => {
    expect(harmony(a, b)).toBe(expected);
  });
});

describe("estimateKey", () => {
  it("finds C major from I–IV–V–I", () => {
    const audio = concat(chord([48, 60, 64, 67], 2), chord([53, 65, 69, 72], 2), chord([55, 67, 71, 74], 2), chord([48, 60, 64, 67], 2));
    expect(estimateKey(audio, RATE)).toMatchObject({ tonic: 0, mode: "major", camelot: "8B" });
  });

  it("finds A minor from i–iv–v–i", () => {
    const audio = concat(chord([45, 57, 60, 64], 2), chord([50, 62, 65, 69], 2), chord([52, 64, 67, 71], 2), chord([45, 57, 60, 64], 2));
    expect(estimateKey(audio, RATE)).toMatchObject({ tonic: 9, mode: "minor", camelot: "8A" });
  });

  it("is null for silence", () => {
    expect(estimateKey(new Float32Array(RATE * 4), RATE)).toBeNull();
  });
});
