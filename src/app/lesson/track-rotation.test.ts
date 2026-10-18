import { describe, expect, it, vi } from "vitest";
import type { Track } from "@tracks";
import {
  deckAOrder,
  historyId,
  lessonMayUse,
  localTrackHistory,
  NO_HISTORY,
  partnerCandidates,
  RECENT_AVOIDED,
  RECENT_KEPT,
  rotationOrder,
  seededRandom,
  TRACK_HISTORY_KEY,
  withHeard,
  type TrackHistory,
} from "./track-rotation.ts";

function original(id: string, genre: string, bpm: number, subgenre?: string): Track {
  return {
    id,
    source: "original",
    title: `Track ${id}`,
    artist: "learn-to-dj original",
    bpmHint: bpm,
    genre,
    ...(subgenre === undefined ? {} : { subgenre }),
    attribution: { text: id, url: null },
    shareable: true,
    analysisCacheKey: null,
    retention: "persistable",
  };
}

const houses = Array.from({ length: 30 }, (_, index) => original(String(index + 1).padStart(3, "0"), "house", 120 + (index % 7), "deep house"));
const ids = (tracks: readonly Track[]) => tracks.map(historyId);

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

describe("lessonMayUse", () => {
  it("takes steady house for every Lesson, but not electro swing or a tempo outside 120–126", () => {
    expect(lessonMayUse(original("a", "house", 123, "nu-disco"), "deck-basics")).toBe(true);
    expect(lessonMayUse(original("b", "House", 120, "indie dance"), "phrases")).toBe(true);
    expect(lessonMayUse(original("c", "house", 124, "electro swing"), "deck-basics")).toBe(false);
    expect(lessonMayUse(original("d", "house", 128, "deep house"), "deck-basics")).toBe(false);
  });

  it("adds techno in the By-ear group only", () => {
    const techno = original("t", "techno", 128, "melodic techno");
    expect(lessonMayUse(techno, "tempo-by-ear")).toBe(true);
    expect(lessonMayUse(techno, "blend-by-ear")).toBe(true);
    expect(lessonMayUse(techno, "nudge-phase")).toBe(true);
    expect(lessonMayUse(techno, "sync-blend")).toBe(false);
    expect(lessonMayUse(techno, "phrases")).toBe(false);
  });

  it("never takes garage, bass music or drum & bass", () => {
    for (const lesson of ["deck-basics", "blend-by-ear"] as const) {
      expect(lessonMayUse(original("g", "ukg", 132, "UK garage (2-step)"), lesson)).toBe(false);
      expect(lessonMayUse(original("s", "bass", 145, "melodic dubstep"), lesson)).toBe(false);
      expect(lessonMayUse(original("x", "dnb", 174, "liquid drum & bass"), lesson)).toBe(false);
      expect(lessonMayUse(original("y", "bass", 128, "complextro / bass house hybrid"), lesson)).toBe(false);
    }
  });
});

describe("rotationOrder", () => {
  it("is deterministic for a seed and varies across seeds", () => {
    const first = (seed: number) => ids(rotationOrder(houses, historyId, NO_HISTORY, seededRandom(seed)))[0];
    expect(first(1)).toBe(first(1));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(first)).size).toBeGreaterThan(3);
  });

  it("never puts this Lesson's last track first while another fits", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const history: TrackHistory = { recent: [], lastByLesson: { "deck-basics": "original:001" } };
      const order = deckAOrder(houses, "deck-basics", history, seededRandom(seed));
      expect(ids(order)[0]).not.toBe("original:001");
      expect(ids(order).at(-1)).toBe("original:001");
    }
  });

  it("avoids the last 10 heard, across Lessons, while anything else fits", () => {
    const recent = ids(houses.slice(0, RECENT_AVOIDED));
    for (let seed = 0; seed < 200; seed += 1) {
      const order = deckAOrder(houses, "phrases", { recent, lastByLesson: {} }, seededRandom(seed));
      expect(recent).not.toContain(ids(order)[0]);
      // All 20 fresh ones come before any of the recent 10.
      expect(ids(order.slice(0, houses.length - RECENT_AVOIDED)).filter((id) => recent.includes(id))).toEqual([]);
    }
  });

  it("only goes back to recent tracks when nothing fresh fits, least recently heard first", () => {
    const pool = houses.slice(0, 3);
    const recent = ["original:001", "original:002", "original:003"];
    expect(ids(rotationOrder(pool, historyId, { recent, lastByLesson: {} }, seededRandom(1)))).toEqual(["original:003", "original:002", "original:001"]);
  });

  it("plays the same track again only when it is the only one", () => {
    const only = houses.slice(0, 1);
    expect(ids(deckAOrder(only, "deck-basics", { recent: ["original:001"], lastByLesson: { "deck-basics": "original:001" } }, seededRandom(1)))).toEqual(["original:001"]);
  });

  it("filters to the Lesson's pool first", () => {
    const mixed = [...houses.slice(0, 3), original("t1", "techno", 128), original("g1", "ukg", 132)];
    expect(ids(deckAOrder(mixed, "phrases", NO_HISTORY, seededRandom(1))).toSorted()).toEqual(["original:001", "original:002", "original:003"]);
  });
});

describe("partnerCandidates", () => {
  const main = original("a", "house", 122);
  const pool = [main, original("b", "house", 124), original("c", "house", 122), original("d", "house", 126), original("e", "house", 120), original("t", "techno", 125)];

  it("keeps the same genre, a tempo 0.5–3% apart, and never deck A itself", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const order = partnerCandidates(main, 122, pool, "sync-blend", NO_HISTORY, seededRandom(seed));
      expect(ids(order).toSorted()).toEqual(["original:b", "original:e"]);
    }
  });

  it("rotates the partner too, away from what was heard", () => {
    const partners = new Set(Array.from({ length: 30 }, (_, seed) => ids(partnerCandidates(main, 122, pool, "sync-blend", NO_HISTORY, seededRandom(seed)))[0]));
    expect(partners).toEqual(new Set(["original:b", "original:e"]));
    const order = partnerCandidates(main, 122, pool, "sync-blend", { recent: ["original:b"], lastByLesson: {} }, seededRandom(3));
    expect(ids(order)).toEqual(["original:e", "original:b"]);
  });

  it("pairs techno with techno in the By-ear group", () => {
    const first = original("t1", "techno", 128);
    const techno = [first, original("t2", "techno", 130), original("h", "house", 126)];
    expect(ids(partnerCandidates(first, 128, techno, "tempo-by-ear", NO_HISTORY, seededRandom(1)))).toEqual(["original:t2"]);
  });
});

describe("the history", () => {
  it("keeps the newest first, without repeats, bounded to 20 ids", () => {
    const heard = houses.reduce<TrackHistory>((history, track) => withHeard(history, "deck-basics", [historyId(track)]), NO_HISTORY);
    expect(heard.recent).toHaveLength(RECENT_KEPT);
    expect(heard.recent[0]).toBe("original:030");
    expect(withHeard(heard, "phrases", ["original:025"]).recent.filter((id) => id === "original:025")).toHaveLength(1);
    expect(heard.lastByLesson["deck-basics"]).toBe("original:030");
  });

  it("records a pair's deck A as the Lesson's last, and both as heard", () => {
    const heard = withHeard(NO_HISTORY, "sync-blend", ["original:001", "original:002"]);
    expect(heard).toEqual({ recent: ["original:001", "original:002"], lastByLesson: { "sync-blend": "original:001" } });
  });

  it("round-trips through localStorage and stays bounded there", () => {
    const storage = new MemoryStorage();
    const store = localTrackHistory(() => storage);
    for (const track of houses) store.heard("deck-basics", [historyId(track)]);
    const stored = JSON.parse(storage.getItem(TRACK_HISTORY_KEY) ?? "{}") as TrackHistory;
    expect(stored.recent).toHaveLength(RECENT_KEPT);
    expect(store.read()).toEqual(stored);
  });

  it("falls back to no history when storage throws, is missing or holds junk", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing = localTrackHistory(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(throwing.read()).toEqual(NO_HISTORY);
    expect(() => {
      throwing.heard("deck-basics", ["original:001"]);
    }).not.toThrow();
    expect(localTrackHistory(() => null).read()).toEqual(NO_HISTORY);
    const junk = new MemoryStorage();
    junk.setItem(TRACK_HISTORY_KEY, "{not json");
    expect(localTrackHistory(() => junk).read()).toEqual(NO_HISTORY);
    junk.setItem(TRACK_HISTORY_KEY, JSON.stringify({ recent: "nope" }));
    expect(localTrackHistory(() => junk).read()).toEqual(NO_HISTORY);
    warn.mockRestore();
  });

  it("still picks at random without history", () => {
    const firsts = new Set(Array.from({ length: 20 }, (_, seed) => ids(deckAOrder(houses, "deck-basics", localTrackHistory(() => null).read(), seededRandom(seed)))[0]));
    expect(firsts.size).toBeGreaterThan(5);
  });
});
