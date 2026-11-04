// The library browser's layout: which columns a library shows, and whether they fit on one row.
//
// - A column no track fills (no ratings, no albums…) is left out, header and cells.
// - One row of columns needs every shown column's least width; below that the browser shows two lines
//   a track (title, then artist · BPM · key · length). The choice is made from the browser's own width
//   (measured, LibraryBrowser.tsx), never the window's, so a browser in a narrow card on a wide screen
//   still fits its card. The header and the rows read one template from here, so they always agree.
import { SORT_COLUMNS, type LibraryRow, type SortColumn } from "./browse.ts";

/** Each column's least width in one-row layout, px at the browser's 14 px text; `share` > 0 grows. */
const COLUMN_WIDTHS: Readonly<Record<SortColumn, { readonly px: number; readonly share: number }>> = {
  title: { px: 140, share: 2.2 },
  artist: { px: 110, share: 1.5 },
  album: { px: 90, share: 1.2 },
  genre: { px: 80, share: 1 },
  // "123.5 BPM", "12A · D♭m", "10:05", "★★★★★", "1,234 plays", "▦ grid": fixed, so they line up.
  bpm: { px: 84, share: 0 },
  key: { px: 80, share: 0 },
  length: { px: 44, share: 0 },
  rating: { px: 76, share: 0 },
  playCount: { px: 84, share: 0 },
  gridReady: { px: 56, share: 0 },
};

/** Between two columns, px (library-browser.css reads it as --lb-gap). */
export const COLUMN_GAP_PX = 8;
/** A row's padding on each side, px (--lb-inset). */
export const ROW_PADDING_PX = 12;
/** What a row loses to its padding and the list's 1 px border, both sides. */
export const ROW_INSET_PX = 2 * ROW_PADDING_PX + 2;

/** Columns that always show: they say when they do not know ("BPM ?", "key ?"). */
const ALWAYS: ReadonlySet<SortColumn> = new Set(["title", "artist", "bpm", "key", "length"]);

const filled: Readonly<Record<SortColumn, (row: LibraryRow) => boolean>> = {
  title: () => true,
  artist: () => true,
  album: (row) => row.album !== null,
  genre: (row) => row.genre !== null,
  bpm: () => true,
  key: () => true,
  length: () => true,
  rating: (row) => row.rating !== null,
  playCount: (row) => row.playCount !== null,
  gridReady: (row) => row.gridReady,
};

/** The columns to show for these rows, in the sort columns' order. */
export function shownColumns(rows: readonly LibraryRow[]): readonly SortColumn[] {
  return SORT_COLUMNS.filter((column) => ALWAYS.has(column) || rows.some(filled[column]));
}

/** The one-row grid template, the header's and the rows': text columns share what is left over. */
export function columnTemplate(columns: readonly SortColumn[], actionsPx: number): string {
  const tracks = columns.map((column) => {
    const { px, share } = COLUMN_WIDTHS[column];
    return share > 0 ? `minmax(${String(px)}px,${String(share)}fr)` : `${String(px)}px`;
  });
  return [...tracks, ...(actionsPx > 0 ? [`${String(Math.ceil(actionsPx))}px`] : [])].join(" ");
}

/** The least width, px, that fits these columns and the row's buttons on one row. */
export function wideMinWidth(columns: readonly SortColumn[], actionsPx: number): number {
  const cells = columns.reduce((sum, column) => sum + COLUMN_WIDTHS[column].px, 0);
  const count = columns.length + (actionsPx > 0 ? 1 : 0);
  return ROW_INSET_PX + cells + Math.ceil(actionsPx) + COLUMN_GAP_PX * Math.max(0, count - 1);
}

export type Layout = "wide" | "narrow";

/** One row of columns when they fit in `widthPx`, else two lines. */
export function layoutFor(widthPx: number, columns: readonly SortColumn[], actionsPx: number): Layout {
  return widthPx >= wideMinWidth(columns, actionsPx) ? "wide" : "narrow";
}
