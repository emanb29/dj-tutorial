// The library browser's model (ISS-194): one row per track, as far as the library knows it without
// reading the file, and the filters, sort and "browse by" facets over those rows. Pure, so a
// 10,000-track library is filtered and sorted here with no audio touched (large-library.test.ts).
//
// - Unknown values (no BPM, no key, no genre…) always sort last, whichever way the column sorts, and a
//   filter on a field leaves out the tracks that do not know it.
// - Keys are Camelot ("8A") inside; the screen shows both notations ("8A · Am"). Sorting by key sorts
//   round the Camelot wheel: 1A, 1B, 2A … 12B.
// - "Compatible keys" are harmonic mixing's safe moves (the same as keysCompatible in src/lessons):
//   the same key, ±1 on the wheel, and the relative major or minor.

export interface LibraryRow {
  /** Unique in the picker; the picker maps it back to its own track. */
  readonly key: string;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly genre: string | null;
  readonly bpm: number | null;
  /** Camelot, "8A"; null when the key is unknown or not one the wheel has. */
  readonly camelot: string | null;
  readonly lengthSec: number | null;
  /** Stars, 1-5. */
  readonly rating: number | null;
  readonly playCount: number | null;
  /** Loading it gives a beat grid at once: rekordbox has one, or the analysis is done. */
  readonly gridReady: boolean;
}

export const SORT_COLUMNS = ["title", "artist", "album", "genre", "bpm", "key", "length", "rating", "playCount", "gridReady"] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];

export const COLUMN_NAMES: Readonly<Record<SortColumn, string>> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  genre: "Genre",
  bpm: "BPM",
  key: "Key",
  length: "Length",
  rating: "Rating",
  playCount: "Plays",
  gridReady: "Grid",
};

export interface LibrarySort {
  readonly column: SortColumn;
  readonly descending: boolean;
}

export type BpmFilter =
  | { readonly kind: "any" }
  /** Either end may be open. */
  | { readonly kind: "range"; readonly min: number | null; readonly max: number | null }
  /** Within `percent` of `bpm`, both ways: what the tempo fader can reach at that range. */
  | { readonly kind: "near"; readonly bpm: number; readonly percent: number };

export interface LibraryFilter {
  /** Matched against title, artist and genre, every word somewhere. */
  readonly search: string;
  readonly bpm: BpmFilter;
  readonly key: { readonly camelot: string; readonly compatible: boolean } | null;
  /** Compared ignoring case. */
  readonly genre: string | null;
  readonly artist: string | null;
  readonly length: { readonly minSec: number | null; readonly maxSec: number | null };
  readonly gridReadyOnly: boolean;
}

export const NO_FILTER: LibraryFilter = {
  search: "",
  bpm: { kind: "any" },
  key: null,
  genre: null,
  artist: null,
  length: { minSec: null, maxSec: null },
  gridReadyOnly: false,
};

export const DEFAULT_SORT: LibrarySort = { column: "title", descending: false };

/** The tempo fader's ranges on the DDJ-FLX4 (and rekordbox): ±6, ±10 and ±16 %. */
export const FADER_RANGES_PERCENT = [6, 10, 16] as const;

/** Floating-point slack, so a track exactly at the edge of a range (122.4 for 120 ± 2 %) stays in. */
const EDGE = 1e-9;

/** Whether `bpm` is within `percent` of `target`, either way. */
export function bpmWithin(bpm: number, target: number, percent: number): boolean {
  const reach = (target * Math.max(0, percent)) / 100;
  return bpm >= target - reach - EDGE && bpm <= target + reach + EDGE;
}

const CAMELOT = /^(1[0-2]|[1-9])([AB])$/;

function parseCamelot(camelot: string): { readonly number: number; readonly letter: "A" | "B" } | null {
  const match = CAMELOT.exec(camelot);
  if (match === null) return null;
  return { number: Number(match[1]), letter: match[2] === "A" ? "A" : "B" };
}

/** Every key on the wheel, in its order: 1A, 1B, 2A … 12B. */
export const CAMELOT_KEYS: readonly string[] = Array.from({ length: 24 }, (_, index) => `${String(Math.floor(index / 2) + 1)}${index % 2 === 0 ? "A" : "B"}`);

const MUSICAL: Readonly<Record<string, string>> = {
  "1A": "A♭m", "1B": "B", "2A": "E♭m", "2B": "F♯", "3A": "B♭m", "3B": "D♭", "4A": "Fm", "4B": "A♭",
  "5A": "Cm", "5B": "E♭", "6A": "Gm", "6B": "B♭", "7A": "Dm", "7B": "F", "8A": "Am", "8B": "C",
  "9A": "Em", "9B": "G", "10A": "Bm", "10B": "D", "11A": "F♯m", "11B": "A", "12A": "D♭m", "12B": "E",
};

/** A Camelot key in musical notation ("8A" → "Am"); null for anything else. */
export function musicalKey(camelot: string): string | null {
  return MUSICAL[camelot] ?? null;
}

/** The key as the browser shows it: "8A · Am". */
export function keyText(camelot: string | null): string {
  if (camelot === null) return "key ?";
  const musical = musicalKey(camelot);
  return musical === null ? camelot : `${camelot} · ${musical}`;
}

/** The keys that mix with `camelot`: itself, ±1 on the wheel, and its relative major or minor. */
export function compatibleKeys(camelot: string): readonly string[] {
  const key = parseCamelot(camelot);
  if (key === null) return [];
  const wrap = (number: number) => ((number + 11) % 12) + 1;
  const other = key.letter === "A" ? "B" : "A";
  return [camelot, `${String(wrap(key.number - 1))}${key.letter}`, `${String(wrap(key.number + 1))}${key.letter}`, `${String(key.number)}${other}`];
}

/** Position round the wheel, for sorting; null for an unknown key. */
function wheelPosition(camelot: string | null): number | null {
  const key = camelot === null ? null : parseCamelot(camelot);
  return key === null ? null : (key.number - 1) * 2 + (key.letter === "A" ? 0 : 1);
}

const fold = (text: string) => text.toLocaleLowerCase();
const words = (search: string) => fold(search).split(/\s+/).filter((word) => word !== "");

/** Whether a row passes every part of the filter. */
export function rowMatches(row: LibraryRow, filter: LibraryFilter): boolean {
  const searched = words(filter.search);
  if (searched.length > 0) {
    const haystack = fold(`${row.title} ${row.artist ?? ""} ${row.genre ?? ""}`);
    if (!searched.every((word) => haystack.includes(word))) return false;
  }
  const { bpm } = filter;
  if (bpm.kind !== "any") {
    if (row.bpm === null) return false;
    if (bpm.kind === "near" && !bpmWithin(row.bpm, bpm.bpm, bpm.percent)) return false;
    if (bpm.kind === "range" && ((bpm.min !== null && row.bpm < bpm.min - EDGE) || (bpm.max !== null && row.bpm > bpm.max + EDGE))) return false;
  }
  if (filter.key !== null) {
    if (row.camelot === null) return false;
    const allowed = filter.key.compatible ? compatibleKeys(filter.key.camelot) : [filter.key.camelot];
    if (!allowed.includes(row.camelot)) return false;
  }
  if (filter.genre !== null && (row.genre === null || fold(row.genre) !== fold(filter.genre))) return false;
  if (filter.artist !== null && (row.artist === null || fold(row.artist) !== fold(filter.artist))) return false;
  const { minSec, maxSec } = filter.length;
  if (minSec !== null || maxSec !== null) {
    if (row.lengthSec === null) return false;
    if ((minSec !== null && row.lengthSec < minSec) || (maxSec !== null && row.lengthSec > maxSec)) return false;
  }
  return !filter.gridReadyOnly || row.gridReady;
}

export function filterRows(rows: readonly LibraryRow[], filter: LibraryFilter): readonly LibraryRow[] {
  return rows.filter((row) => rowMatches(row, filter));
}

type SortValue = string | number | null;

function sortValue(row: LibraryRow, column: SortColumn): SortValue {
  switch (column) {
    case "title":
      return row.title.trim() === "" ? null : fold(row.title);
    case "artist":
      return row.artist === null ? null : fold(row.artist);
    case "album":
      return row.album === null ? null : fold(row.album);
    case "genre":
      return row.genre === null ? null : fold(row.genre);
    case "bpm":
      return row.bpm;
    case "key":
      return wheelPosition(row.camelot);
    case "length":
      return row.lengthSec;
    case "rating":
      return row.rating;
    case "playCount":
      return row.playCount;
    case "gridReady":
      return row.gridReady ? 1 : 0;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareKnown(a: string | number, b: string | number): number {
  return typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
}

/** Sorted by the column, unknown values last either way; ties by title, then key, so the order is stable. */
export function sortRows(rows: readonly LibraryRow[], sort: LibrarySort): readonly LibraryRow[] {
  const keyed = rows.map((row) => ({ row, value: sortValue(row, sort.column), title: fold(row.title) }));
  keyed.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value !== b.value) return a.value === null ? 1 : -1;
    } else {
      const order = compareKnown(a.value, b.value);
      if (order !== 0) return sort.descending ? -order : order;
    }
    return collator.compare(a.title, b.title) || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0);
  });
  return keyed.map(({ row }) => row);
}

export const FACETS = ["artist", "genre", "key"] as const;
export type Facet = (typeof FACETS)[number];

export const FACET_NAMES: Readonly<Record<Facet, string>> = { artist: "Artist", genre: "Genre", key: "Key" };

export interface FacetValue {
  /** The filter value: the artist or genre as the library spells it most often, or the Camelot key. */
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface FacetList {
  readonly values: readonly FacetValue[];
  /** Tracks that do not know this field. */
  readonly unknown: number;
}

function facetOf(row: LibraryRow, facet: Facet): string | null {
  return facet === "artist" ? row.artist : facet === "genre" ? row.genre : row.camelot;
}

/** The filter without its own facet, so a facet's counts say what picking each value would give. */
export function withoutFacet(filter: LibraryFilter, facet: Facet): LibraryFilter {
  return facet === "key" ? { ...filter, key: null } : { ...filter, [facet]: null };
}

/**
 * The values of a facet with their track counts, over the rows the rest of the filter keeps. Artists
 * and genres group ignoring case; keys go round the wheel, the rest most tracks first, then by name.
 */
export function facetValues(rows: readonly LibraryRow[], filter: LibraryFilter, facet: Facet): FacetList {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  let unknown = 0;
  for (const row of filterRows(rows, withoutFacet(filter, facet))) {
    const value = facetOf(row, facet);
    if (value === null || value.trim() === "") {
      unknown += 1;
      continue;
    }
    const group = groups.get(fold(value)) ?? { count: 0, spellings: new Map<string, number>() };
    group.count += 1;
    group.spellings.set(value, (group.spellings.get(value) ?? 0) + 1);
    groups.set(fold(value), group);
  }
  const values = [...groups.values()].map(({ count, spellings }) => {
    const value = [...spellings.entries()].reduce((best, each) => (each[1] > best[1] ? each : best))[0];
    return { value, label: facet === "key" ? keyText(value) : value, count };
  });
  const sorted =
    facet === "key"
      ? values.toSorted((a, b) => (wheelPosition(a.value) ?? 99) - (wheelPosition(b.value) ?? 99))
      : values.toSorted((a, b) => b.count - a.count || collator.compare(a.value, b.value));
  return { values: sorted, unknown };
}

/** The filter with a facet's value picked. */
export function pickFacet(filter: LibraryFilter, facet: Facet, value: string): LibraryFilter {
  return facet === "key" ? { ...filter, key: { camelot: value, compatible: filter.key?.compatible ?? false } } : { ...filter, [facet]: value };
}

/** Whether anything but the search narrows the list. */
export function narrowed(filter: LibraryFilter): boolean {
  return (
    filter.bpm.kind !== "any" ||
    filter.key !== null ||
    filter.genre !== null ||
    filter.artist !== null ||
    filter.length.minSec !== null ||
    filter.length.maxSec !== null ||
    filter.gridReadyOnly
  );
}

/** "3:05"; "?" when unknown. */
export function lengthText(seconds: number | null): string {
  if (seconds === null) return "?";
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

/** "123.5 BPM", as Freestyle has always shown it; "BPM ?" when unknown. */
export function bpmText(bpm: number | null): string {
  return bpm === null ? "BPM ?" : `${bpm.toFixed(1)} BPM`;
}
