import { afterEach, describe, expect, it, vi } from "vitest";
import { FRESH_STATE, readBrowseState, storageKey, writeBrowseState, type BrowseState } from "./remembered.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

const SAVED: BrowseState = {
  filter: {
    search: "lantern",
    bpm: { kind: "near", bpm: 124, percent: 6 },
    key: { camelot: "8A", compatible: true },
    genre: "Techno",
    artist: null,
    length: { minSec: 180, maxSec: null },
    gridReadyOnly: true,
  },
  sort: { column: "key", descending: true },
  browseBy: "genre",
};

describe("remembered browse state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps each picker's filter and sort apart", () => {
    const storage = memoryStorage();
    writeBrowseState("mix-plans", SAVED, storage);

    expect(readBrowseState("mix-plans", storage)).toEqual(SAVED);
    expect(readBrowseState("freestyle", storage)).toEqual(FRESH_STATE);
  });

  it("starts fresh from nothing, from text that is not JSON, and from a shape that no longer fits", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = memoryStorage();
    expect(readBrowseState("mix-plans", storage)).toEqual(FRESH_STATE);

    storage.items.set(storageKey("mix-plans"), "{not json");
    expect(readBrowseState("mix-plans", storage)).toEqual(FRESH_STATE);

    storage.items.set(storageKey("mix-plans"), JSON.stringify({ ...SAVED, sort: { column: "colour", descending: false } }));
    expect(readBrowseState("mix-plans", storage)).toEqual(FRESH_STATE);
  });

  it("works without storage, and when storage throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    expect(readBrowseState("mix-plans", null)).toEqual(FRESH_STATE);
    expect(readBrowseState("mix-plans", throwing)).toEqual(FRESH_STATE);
    expect(() => {
      writeBrowseState("mix-plans", SAVED, throwing);
    }).not.toThrow();
  });
});
