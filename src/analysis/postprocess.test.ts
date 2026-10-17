import { describe, expect, it } from "vitest";
import { aggregate, BORDER, CHUNK, minimalPostprocess, splitPiece } from "./postprocess.ts";

describe("minimal postprocessing", () => {
  it("picks local maxima above zero, merges adjacent peaks and snaps downbeats", () => {
    const beat = new Float32Array(200).fill(-5);
    const downbeat = new Float32Array(200).fill(-5);
    beat[25] = 3;
    beat[50] = 2;
    beat[51] = 2; // plateau: two equal maxima one frame apart -> 50.5
    beat[100] = -1; // below threshold
    downbeat[26] = 1;
    const result = minimalPostprocess(beat, downbeat, 50);
    expect(result.beats).toEqual([0.5, 1.01]);
    expect(result.downbeats).toEqual([0.5]);
  });

  it("chunks with the reference layout and aggregates keep-first", () => {
    const frames = 4000;
    const spect = new Float32Array(frames * 128).map((_, i) => Math.floor(i / 128));
    const chunks = splitPiece(spect, frames);
    expect(chunks.map((c) => c.start)).toEqual([-BORDER, -BORDER + CHUNK - 2 * BORDER, frames - (CHUNK - BORDER)]);
    // Each chunk's prediction is its frame index, so aggregation must return the identity.
    const predictions = chunks.map((c) => Float32Array.from({ length: CHUNK }, (_, i) => c.start + i));
    const merged = aggregate(
      predictions,
      chunks.map((c) => c.start),
      frames,
    );
    expect(Array.from(merged)).toEqual(Array.from({ length: frames }, (_, i) => i));
  });
});
