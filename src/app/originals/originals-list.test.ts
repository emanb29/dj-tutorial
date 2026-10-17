import { describe, expect, it } from "vitest";
import type { OriginalSummary } from "@shared/originals.ts";
import {
  fetchOriginals,
  filterByGenre,
  formatGenre,
  formatKey,
  formatTime,
  genresOf,
  mergeOriginals,
  stepFrom,
  type OriginalRow,
} from "./originals-list.ts";

const original = (id: string, genre = "house", extra: Partial<OriginalSummary> = {}): OriginalSummary => ({
  id,
  title: `Track ${id}`,
  genre,
  bpm: 124,
  durationSec: 300,
  bars: 160,
  ...extra,
});

const ids = (rows: readonly OriginalRow[]) => rows.map((row) => row.original.id);

describe("mergeOriginals", () => {
  it("shows the first load newest first, with nothing marked new", () => {
    const rows = mergeOriginals(null, [original("001"), original("002"), original("003")]);

    expect(ids(rows)).toEqual(["003", "002", "001"]);
    expect(rows.every((row) => !row.isNew)).toBe(true);
  });

  it("marks tracks that arrive in a later poll as new, at the top", () => {
    const first = mergeOriginals(null, [original("001"), original("002")]);
    const second = mergeOriginals(first, [original("001"), original("002"), original("003")]);

    expect(ids(second)).toEqual(["003", "002", "001"]);
    expect(second.map((row) => row.isNew)).toEqual([true, false, false]);
  });

  it("keeps a track's new mark through later polls", () => {
    const first = mergeOriginals(null, [original("001")]);
    const second = mergeOriginals(first, [original("001"), original("002")]);
    const third = mergeOriginals(second, [original("001"), original("002"), original("003")]);

    expect(third.map((row) => row.isNew)).toEqual([true, true, false]);
  });

  it("drops a track the index no longer lists, and takes updated fields", () => {
    const first = mergeOriginals(null, [original("001"), original("002")]);
    const second = mergeOriginals(first, [original("002", "house", { title: "Renamed" })]);

    expect(ids(second)).toEqual(["002"]);
    expect(second[0]?.original.title).toBe("Renamed");
  });
});

describe("genres and filtering", () => {
  const rows = mergeOriginals(null, [original("001", "house"), original("002", "techno"), original("003", "house"), original("004", "dnb")]);

  it("lists each genre once, newest first", () => {
    expect(genresOf(rows)).toEqual(["dnb", "house", "techno"]);
  });

  it("filters by genre, or shows everything with no genre", () => {
    expect(ids(filterByGenre(rows, "house"))).toEqual(["003", "001"]);
    expect(filterByGenre(rows, null)).toBe(rows);
  });
});

describe("stepFrom", () => {
  const rows = mergeOriginals(null, [original("001"), original("002"), original("003")]);

  it("moves down the list for next and up for previous", () => {
    expect(stepFrom(rows, "003", 1)).toBe("002");
    expect(stepFrom(rows, "002", -1)).toBe("003");
  });

  it("stops at either end", () => {
    expect(stepFrom(rows, "001", 1)).toBeNull();
    expect(stepFrom(rows, "003", -1)).toBeNull();
  });

  it("starts at the top with no current track, or one filtered out", () => {
    expect(stepFrom(rows, null, 1)).toBe("003");
    expect(stepFrom(rows, "999", -1)).toBe("003");
    expect(stepFrom([], null, 1)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats times as m:ss, or h:mm:ss past an hour", () => {
    expect(formatTime(307.2)).toBe("5:07");
    expect(formatTime(59.99)).toBe("0:59");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(-3)).toBe("0:00");
  });

  it("formats the key with its Camelot code", () => {
    expect(formatKey({ key: "A minor", camelot: "8A" })).toBe("A minor · 8A");
    expect(formatKey({ camelot: "8A" })).toBe("8A");
    expect(formatKey({})).toBeNull();
  });

  it("formats the genre with its subgenre", () => {
    expect(formatGenre({ genre: "house", subgenre: "deep house" })).toBe("house · deep house");
    expect(formatGenre({ genre: "house" })).toBe("house");
    expect(formatGenre({ genre: "techno", subgenre: "techno" })).toBe("techno");
  });
});

describe("fetchOriginals", () => {
  const answer = (status: number, body: string): typeof fetch => () => Promise.resolve(new Response(body, { status }));

  it("returns the list", async () => {
    const result = await fetchOriginals(answer(200, JSON.stringify({ success: true, data: [original("001", "house", { topic: "moths" })] })));

    expect(result).toEqual({ ok: true, originals: [original("001", "house", { topic: "moths" })] });
  });

  it("says the API isn't answering when the request fails or the proxy answers 502", async () => {
    const refused: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    for (const result of [await fetchOriginals(refused), await fetchOriginals(answer(502, ""))]) {
      expect(result).toMatchObject({ ok: false, problem: { kind: "api-down", message: "The API isn't answering." } });
      expect(result.ok ? "" : result.problem.fix).toContain("npm run dev");
    }
  });

  it("says how to turn Originals on when the API doesn't serve them", async () => {
    const result = await fetchOriginals(answer(404, JSON.stringify({ success: false })));

    expect(result).toMatchObject({ ok: false, problem: { kind: "not-served" } });
    expect(result.ok ? "" : result.problem.fix).toContain("ORIGINALS_DIR");
  });

  it("reports a body it can't read", async () => {
    const result = await fetchOriginals(answer(200, JSON.stringify({ success: true, data: [{ id: "001" }] })));

    expect(result).toMatchObject({ ok: false, problem: { kind: "bad-response" } });
  });

  it("reports a cancelled request as aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await fetchOriginals(() => Promise.reject(new DOMException("aborted", "AbortError")), abort.signal);

    expect(result).toMatchObject({ ok: false, problem: { kind: "aborted" } });
  });
});
