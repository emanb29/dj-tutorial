import { describe, expect, it } from "vitest";
import type { LibraryRow } from "./browse.ts";
import { COLUMN_GAP_PX, columnTemplate, layoutFor, ROW_INSET_PX, shownColumns, wideMinWidth } from "./layout.ts";

function row(key: string, extra: Partial<LibraryRow> = {}): LibraryRow {
  return { key, title: key, artist: null, album: null, genre: null, bpm: null, camelot: null, lengthSec: null, rating: null, playCount: null, gridReady: false, ...extra };
}

describe("the columns a library shows", () => {
  it("always shows title, artist, BPM, key and length, which say when they are unknown", () => {
    expect(shownColumns([row("a")])).toEqual(["title", "artist", "bpm", "key", "length"]);
    expect(shownColumns([])).toEqual(["title", "artist", "bpm", "key", "length"]);
  });

  it("shows album, genre, rating, plays and grid only when some track has one", () => {
    expect(shownColumns([row("a", { album: "Low Sun" }), row("b", { rating: 3 })])).toEqual(["title", "artist", "album", "bpm", "key", "length", "rating"]);
    expect(shownColumns([row("a", { genre: "House", playCount: 4, gridReady: true }), row("b")])).toEqual(["title", "artist", "genre", "bpm", "key", "length", "playCount", "gridReady"]);
  });

  it("keeps the order of the sort columns", () => {
    expect(shownColumns([row("a", { album: "x", genre: "y", rating: 1, playCount: 1, gridReady: true })])).toEqual(["title", "artist", "album", "genre", "bpm", "key", "length", "rating", "playCount", "gridReady"]);
  });
});

describe("one row of columns or two lines", () => {
  const few = ["title", "artist", "bpm", "key", "length"] as const;

  it("needs room for every column's least width, the gaps, the row's inset and the row's buttons", () => {
    const bare = wideMinWidth(few, 0);
    expect(wideMinWidth(few, 60)).toBe(bare + 60 + COLUMN_GAP_PX);
    expect(bare).toBeGreaterThan(ROW_INSET_PX + 4 * COLUMN_GAP_PX);
    expect(wideMinWidth([...few, "album", "rating"], 0)).toBeGreaterThan(bare);
  });

  it("goes to one row of columns once they fit, and back to two lines below that", () => {
    const needed = wideMinWidth(few, 60);
    expect(layoutFor(needed, few, 60)).toBe("wide");
    expect(layoutFor(needed - 1, few, 60)).toBe("narrow");
    expect(layoutFor(0, few, 60)).toBe("narrow");
  });

  it("gives the header and the rows one template: text columns share what is left, the rest are fixed", () => {
    const template = columnTemplate(few, 60);
    expect(template.split(" ").filter((part) => part.startsWith("minmax(")).length).toBe(2);
    expect(template.endsWith(" 60px")).toBe(true);
    expect(columnTemplate(few, 0).endsWith("px")).toBe(true);
    expect(columnTemplate(few, 0).split(" ").length).toBe(few.length);
  });
});
