import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbAnalysisCache } from "./indexeddb-cache.ts";
import { sampleAnalysis } from "./sample-analysis.ts";

const DATABASE = "learn-to-dj-analysis-test";
let cache = new IndexedDbAnalysisCache(DATABASE);

afterEach(async () => {
  await cache.close();
  await new Promise((resolve) => {
    indexedDB.deleteDatabase(DATABASE).onsuccess = resolve;
  });
  cache = new IndexedDbAnalysisCache(DATABASE);
});

describe("IndexedDB analysis cache", () => {
  it("keeps an analysis, waveform arrays included, across connections", async () => {
    await cache.put("hash-1", sampleAnalysis());
    await cache.close();
    const reopened = new IndexedDbAnalysisCache(DATABASE);
    const stored = await reopened.get("hash-1");
    await reopened.close();
    expect(stored).toEqual(sampleAnalysis());
    expect(stored?.waveformOverview.low).toBeInstanceOf(Float32Array);
  });

  it("returns null for unknown hashes, deleted entries and other pipeline versions", async () => {
    expect(await cache.get("missing")).toBeNull();
    await cache.put("old", { ...sampleAnalysis(), analysisVersion: -1 });
    expect(await cache.get("old")).toBeNull();
    await cache.put("gone", sampleAnalysis());
    await cache.delete("gone");
    expect(await cache.get("gone")).toBeNull();
  });
});
