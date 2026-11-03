import { describe, expect, it } from "vitest";
import { keysCompatible } from "@lessons";
import { camelotFromTonality } from "@tracks";
import {
  bpmWithin,
  CAMELOT_KEYS,
  compatibleKeys,
  facetValues,
  FADER_RANGES_PERCENT,
  filterRows,
  keyText,
  lengthText,
  musicalKey,
  narrowed,
  NO_FILTER,
  pickFacet,
  SORT_COLUMNS,
  sortRows,
  type LibraryFilter,
  type LibraryRow,
} from "./browse.ts";

/** Invented tracks, nothing real. */
function row(key: string, extra: Partial<LibraryRow> = {}): LibraryRow {
  return { key, title: key, artist: null, album: null, genre: null, bpm: null, camelot: null, lengthSec: null, rating: null, playCount: null, gridReady: false, ...extra };
}

const LIBRARY: readonly LibraryRow[] = [
  row("a", { title: "Copper Tide", artist: "Mira Vale", genre: "Deep House", bpm: 122, camelot: "8A", lengthSec: 360, rating: 4, playCount: 12, gridReady: true }),
  row("b", { title: "Glass Orchard", artist: "Mira Vale", genre: "deep house", bpm: 124.5, camelot: "9A", lengthSec: 300, rating: 2, playCount: 3, gridReady: true }),
  row("c", { title: "Low Lanterns", artist: "Otto Fenn", genre: "Techno", bpm: 132, camelot: "8B", lengthSec: 420, gridReady: false }),
  row("d", { title: "Paper Comets", artist: "Juno Reyes-Park", genre: "Disco", bpm: 118, camelot: "3A", lengthSec: 240 }),
  row("e", { title: "unknown file" }),
];

const titles = (rows: readonly LibraryRow[]) => rows.map((each) => each.title);
const only = (filter: Partial<LibraryFilter>) => titles(filterRows(LIBRARY, { ...NO_FILTER, ...filter }));

describe("filters", () => {
  it("keeps everything with no filter, and an empty library stays empty", () => {
    expect(filterRows(LIBRARY, NO_FILTER)).toHaveLength(LIBRARY.length);
    expect(filterRows([], { ...NO_FILTER, search: "tide", gridReadyOnly: true })).toEqual([]);
    expect(sortRows([], { column: "bpm", descending: true })).toEqual([]);
    expect(facetValues([], NO_FILTER, "artist")).toEqual({ values: [], unknown: 0 });
  });

  it("searches title, artist and genre, every word, ignoring case", () => {
    expect(only({ search: "mira" })).toEqual(["Copper Tide", "Glass Orchard"]);
    expect(only({ search: "DEEP glass" })).toEqual(["Glass Orchard"]);
    expect(only({ search: "techno" })).toEqual(["Low Lanterns"]);
    expect(only({ search: "   " })).toHaveLength(LIBRARY.length);
    expect(only({ search: "nothing like this" })).toEqual([]);
  });

  it("filters a BPM range, open at either end, leaving out unknown BPMs", () => {
    expect(only({ bpm: { kind: "range", min: 120, max: 125 } })).toEqual(["Copper Tide", "Glass Orchard"]);
    expect(only({ bpm: { kind: "range", min: 130, max: null } })).toEqual(["Low Lanterns"]);
    expect(only({ bpm: { kind: "range", min: null, max: 118 } })).toEqual(["Paper Comets"]);
    expect(only({ bpm: { kind: "range", min: null, max: null } })).not.toContain("unknown file");
  });

  it("filters ± N % of a BPM, edges included", () => {
    expect(only({ bpm: { kind: "near", bpm: 122, percent: 3 } })).toEqual(["Copper Tide", "Glass Orchard"]);
    expect(only({ bpm: { kind: "near", bpm: 122, percent: 0 } })).toEqual(["Copper Tide"]);
    expect(only({ bpm: { kind: "near", bpm: 120, percent: 10 } })).toEqual(["Copper Tide", "Glass Orchard", "Low Lanterns", "Paper Comets"]);
  });

  it("filters by key, alone or with the compatible keys", () => {
    expect(only({ key: { camelot: "8A", compatible: false } })).toEqual(["Copper Tide"]);
    expect(only({ key: { camelot: "8A", compatible: true } })).toEqual(["Copper Tide", "Glass Orchard", "Low Lanterns"]);
  });

  it("filters genre and artist ignoring case, and length, and grid ready", () => {
    expect(only({ genre: "DEEP HOUSE" })).toEqual(["Copper Tide", "Glass Orchard"]);
    expect(only({ artist: "otto fenn" })).toEqual(["Low Lanterns"]);
    expect(only({ length: { minSec: 300, maxSec: 360 } })).toEqual(["Copper Tide", "Glass Orchard"]);
    expect(only({ length: { minSec: null, maxSec: 250 } })).toEqual(["Paper Comets"]);
    expect(only({ gridReadyOnly: true })).toEqual(["Copper Tide", "Glass Orchard"]);
  });

  it("combines every filter", () => {
    const filter: Partial<LibraryFilter> = { search: "o", bpm: { kind: "near", bpm: 123, percent: 6 }, key: { camelot: "9A", compatible: true }, genre: "deep house", gridReadyOnly: true };
    expect(only(filter)).toEqual(["Copper Tide", "Glass Orchard"]);
    expect(only({ ...filter, artist: "Otto Fenn" })).toEqual([]);
  });

  it("says whether anything but the search narrows the list", () => {
    expect(narrowed({ ...NO_FILTER, search: "x" })).toBe(false);
    expect(narrowed({ ...NO_FILTER, gridReadyOnly: true })).toBe(true);
    expect(narrowed({ ...NO_FILTER, length: { minSec: 60, maxSec: null } })).toBe(true);
  });
});

describe("BPM ± %", () => {
  it("reaches exactly as far as the tempo fader at each of its ranges", () => {
    for (const percent of FADER_RANGES_PERCENT) {
      const reach = (128 * percent) / 100;
      expect(bpmWithin(128 + reach, 128, percent)).toBe(true);
      expect(bpmWithin(128 - reach, 128, percent)).toBe(true);
      expect(bpmWithin(128 + reach + 0.01, 128, percent)).toBe(false);
      expect(bpmWithin(128 - reach - 0.01, 128, percent)).toBe(false);
    }
  });

  it("keeps a BPM at the edge despite floating point (120 ± 2 % reaches 122.4)", () => {
    expect(bpmWithin(122.4, 120, 2)).toBe(true);
    expect(bpmWithin(117.6, 120, 2)).toBe(true);
  });

  it("treats a negative percent as 0", () => {
    expect(bpmWithin(120, 120, -5)).toBe(true);
    expect(bpmWithin(120.1, 120, -5)).toBe(false);
  });
});

describe("keys", () => {
  it("names every Camelot key in musical notation, and the two notations agree", () => {
    expect(CAMELOT_KEYS).toHaveLength(24);
    for (const camelot of CAMELOT_KEYS) {
      const musical = musicalKey(camelot);
      expect(musical).not.toBeNull();
      expect(camelotFromTonality(musical ?? "")).toBe(camelot);
    }
    expect(keyText("8A")).toBe("8A · Am");
    expect(keyText(null)).toBe("key ?");
    expect(musicalKey("13A")).toBeNull();
  });

  it("lists the same key, ±1 round the wheel and the relative major or minor as compatible", () => {
    expect(compatibleKeys("8A")).toEqual(["8A", "7A", "9A", "8B"]);
    expect(compatibleKeys("12B")).toEqual(["12B", "11B", "1B", "12A"]);
    expect(compatibleKeys("1A")).toEqual(["1A", "12A", "2A", "1B"]);
    expect(compatibleKeys("Am")).toEqual([]);
  });

  it("agrees with the set builder's keysCompatible for every pair of keys", () => {
    for (const first of CAMELOT_KEYS) {
      for (const second of CAMELOT_KEYS) expect(compatibleKeys(first).includes(second)).toBe(keysCompatible(first, second));
    }
  });

  it("finds a key whichever notation the library wrote it in", () => {
    // Rows hold Camelot; the folder rows turn rekordbox's "Am", "F#m" or "08a" into it (folder-rows.ts).
    expect(["Am", "8A", "08a", "A minor"].map(camelotFromTonality)).toEqual(["8A", "8A", "8A", "8A"]);
    expect(["F#m", "Gbm", "11A"].map(camelotFromTonality)).toEqual(["11A", "11A", "11A"]);
    expect(camelotFromTonality("not a key")).toBeNull();
  });
});

describe("sorting", () => {
  it("sorts by every column, unknown values last whichever way", () => {
    for (const column of SORT_COLUMNS) {
      for (const descending of [false, true]) {
        const sorted = sortRows(LIBRARY, { column, descending });
        expect(sorted).toHaveLength(LIBRARY.length);
        if (column !== "title" && column !== "gridReady") expect(sorted.at(-1)?.title).toBe("unknown file");
      }
    }
  });

  it("sorts BPM up and down", () => {
    expect(titles(sortRows(LIBRARY, { column: "bpm", descending: false }))).toEqual(["Paper Comets", "Copper Tide", "Glass Orchard", "Low Lanterns", "unknown file"]);
    expect(titles(sortRows(LIBRARY, { column: "bpm", descending: true }))).toEqual(["Low Lanterns", "Glass Orchard", "Copper Tide", "Paper Comets", "unknown file"]);
  });

  it("sorts keys round the Camelot wheel, A before B", () => {
    expect(titles(sortRows(LIBRARY, { column: "key", descending: false }))).toEqual(["Paper Comets", "Copper Tide", "Low Lanterns", "Glass Orchard", "unknown file"]);
    const wheel = sortRows(
      ["12B", "1A", "10A", "2B", "1B"].map((camelot) => row(camelot, { camelot })),
      { column: "key", descending: false },
    );
    expect(wheel.map((each) => each.camelot)).toEqual(["1A", "1B", "2B", "10A", "12B"]);
  });

  it("sorts text ignoring case and numbers in it, ties by title", () => {
    const rows = [row("x", { title: "Track 10", artist: "b" }), row("y", { title: "track 9", artist: "B" }), row("z", { title: "Alpha", artist: "a" })];
    expect(titles(sortRows(rows, { column: "title", descending: false }))).toEqual(["Alpha", "track 9", "Track 10"]);
    expect(titles(sortRows(rows, { column: "artist", descending: true }))).toEqual(["track 9", "Track 10", "Alpha"]);
  });

  it("does not change the rows it was given", () => {
    const before = titles(LIBRARY);
    sortRows(LIBRARY, { column: "bpm", descending: true });
    expect(titles(LIBRARY)).toEqual(before);
  });
});

describe("browse by", () => {
  it("counts artists, most tracks first, and the tracks that have none", () => {
    expect(facetValues(LIBRARY, NO_FILTER, "artist")).toEqual({
      values: [
        { value: "Mira Vale", label: "Mira Vale", count: 2 },
        { value: "Juno Reyes-Park", label: "Juno Reyes-Park", count: 1 },
        { value: "Otto Fenn", label: "Otto Fenn", count: 1 },
      ],
      unknown: 1,
    });
  });

  it("groups genres ignoring case, under the spelling most tracks use", () => {
    const rows = [...LIBRARY, row("f", { genre: "Deep House" })];
    expect(facetValues(rows, NO_FILTER, "genre").values[0]).toEqual({ value: "Deep House", label: "Deep House", count: 3 });
  });

  it("lists keys round the wheel with both notations", () => {
    expect(facetValues(LIBRARY, NO_FILTER, "key").values.map((each) => each.label)).toEqual(["3A · B♭m", "8A · Am", "8B · C", "9A · Em"]);
  });

  it("counts within the rest of the filter, but not the facet's own value", () => {
    const filter = { ...NO_FILTER, artist: "Otto Fenn", gridReadyOnly: true };
    expect(facetValues(LIBRARY, filter, "artist").values.map((each) => [each.value, each.count])).toEqual([["Mira Vale", 2]]);
    expect(facetValues(LIBRARY, filter, "genre").values).toEqual([]);
  });

  it("picks a facet value into the filter, keeping the compatible-keys choice", () => {
    expect(pickFacet(NO_FILTER, "genre", "Techno").genre).toBe("Techno");
    expect(pickFacet({ ...NO_FILTER, key: { camelot: "1A", compatible: true } }, "key", "8A").key).toEqual({ camelot: "8A", compatible: true });
  });
});

describe("display", () => {
  it("writes lengths as minutes and seconds", () => {
    expect(lengthText(0)).toBe("0:00");
    expect(lengthText(305.4)).toBe("5:05");
    expect(lengthText(null)).toBe("?");
  });
});
