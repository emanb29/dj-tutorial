import { describe, expect, it } from "vitest";
import { CONTENT_HASH_PREFIX_BYTES, hashDecodedAudio, hashTrackBytes, MemoryAnalysisCache } from "./cache.ts";
import { sampleAnalysis } from "./sample-analysis.ts";

describe("content hash", () => {
  const bytes = Uint8Array.from({ length: CONTENT_HASH_PREFIX_BYTES + 1000 }, (_, i) => (i * 31) % 256);

  it("is the same for the same file and duration, and a 64-character hex SHA-256", async () => {
    const a = await hashTrackBytes(bytes, 360.5);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashTrackBytes(bytes.slice(), 360.5)).toBe(a);
  });

  it("only reads the first N bytes, and tells tracks apart by duration", async () => {
    const tailChanged = bytes.slice();
    tailChanged[CONTENT_HASH_PREFIX_BYTES + 10] = 7;
    expect(await hashTrackBytes(tailChanged, 360.5)).toBe(await hashTrackBytes(bytes, 360.5));
    const headChanged = bytes.slice();
    headChanged[10] = 7;
    expect(await hashTrackBytes(headChanged, 360.5)).not.toBe(await hashTrackBytes(bytes, 360.5));
    expect(await hashTrackBytes(bytes, 361)).not.toBe(await hashTrackBytes(bytes, 360.5));
  });

  it("hashes decoded audio by its samples and rate", async () => {
    const channel = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i));
    const a = await hashDecodedAudio({ channels: [channel], sampleRate: 44_100 });
    expect(await hashDecodedAudio({ channels: [channel.slice()], sampleRate: 44_100 })).toBe(a);
    expect(await hashDecodedAudio({ channels: [channel], sampleRate: 48_000 })).not.toBe(a);
  });
});

describe("in-memory analysis cache", () => {
  it("returns what was put, and nothing for an unknown hash", async () => {
    const cache = new MemoryAnalysisCache();
    const analysis = sampleAnalysis();
    await cache.put("abc", analysis);
    expect(await cache.get("abc")).toEqual(analysis);
    expect(await cache.get("other")).toBeNull();
    await cache.delete("abc");
    expect(await cache.get("abc")).toBeNull();
  });

  it("ignores analyses from another pipeline version", async () => {
    const cache = new MemoryAnalysisCache();
    await cache.put("abc", { ...sampleAnalysis(), analysisVersion: -1 });
    expect(await cache.get("abc")).toBeNull();
  });
});
