// The large-library rule (ISS-194): a 10,000-track music folder, half of it known to rekordbox, is
// listed, filtered, sorted and browsed by facet from metadata alone. No file is opened and nothing is
// decoded once the folder has been scanned. Invented names; nothing here is real music.
import { describe, expect, it } from "vitest";
import { facetValues, filterRows, NO_FILTER, sortRows, SORT_COLUMNS } from "./browse.ts";
import { folderRows } from "./folder-rows.ts";
import { LARGE_LIBRARY_SIZE, largeLibrary } from "./test-support.ts";

describe("a 10,000-track library", () => {
  it("lists, filters, sorts and browses by facet with zero decodes and zero file reads", async () => {
    const { music, folder, decoded, openedByScan } = await largeLibrary();
    expect(music.snapshot()).toMatchObject({ found: LARGE_LIBRARY_SIZE, rekordbox: { matched: LARGE_LIBRARY_SIZE / 2 } });

    const rows = folderRows(music);
    expect(rows).toHaveLength(LARGE_LIBRARY_SIZE);
    expect(rows.filter((row) => row.gridReady)).toHaveLength(LARGE_LIBRARY_SIZE / 2);
    // rekordbox wrote this one's key as "A" (musical); the row has it as Camelot.
    expect(rows.find((row) => row.title === "Track 42")).toMatchObject({ artist: "Artist 42", album: "Album 42", genre: "Disco", bpm: 130, camelot: "11B", lengthSec: 222, rating: null, playCount: 12, gridReady: true });
    // A file rekordbox does not know shows what its name says, and nothing else.
    expect(rows.find((row) => row.title === "Track 00043")).toMatchObject({ artist: "Artist 43", album: null, genre: null, bpm: null, camelot: null, gridReady: false });

    const near = filterRows(rows, { ...NO_FILTER, bpm: { kind: "near", bpm: 124, percent: 2 }, key: { camelot: "8A", compatible: true }, gridReadyOnly: true });
    expect(near.length).toBeGreaterThan(0);
    expect(near.every((row) => row.bpm !== null && row.bpm >= 121.52 && row.bpm <= 126.48 && ["8A", "7A", "9A", "8B"].includes(row.camelot ?? ""))).toBe(true);
    expect(filterRows(rows, { ...NO_FILTER, search: "artist 7 techno" }).length).toBeGreaterThan(0);
    for (const column of SORT_COLUMNS) expect(sortRows(rows, { column, descending: true })).toHaveLength(LARGE_LIBRARY_SIZE);
    // Unknown BPMs last: the bare half of the folder.
    const byBpm = sortRows(rows, { column: "bpm", descending: false });
    expect(byBpm[LARGE_LIBRARY_SIZE / 2 - 1]?.bpm).not.toBeNull();
    expect(byBpm[LARGE_LIBRARY_SIZE / 2]?.bpm).toBeNull();
    expect(facetValues(rows, NO_FILTER, "artist").values).toHaveLength(50);
    expect(facetValues(rows, NO_FILTER, "genre")).toMatchObject({ unknown: LARGE_LIBRARY_SIZE / 2 });
    expect(facetValues(rows, NO_FILTER, "key").values).toHaveLength(24);

    expect(folder.opened).toBe(openedByScan);
    expect(decoded).toEqual([]);
  });
});
