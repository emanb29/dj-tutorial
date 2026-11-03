// Each picker's filter, sort and "browse by" choice, kept in this browser (localStorage) so the
// library opens the way the Learner left it. A per-device convenience: when storage is blocked, or
// what is stored no longer validates, the browser simply opens with no filter.
import { z } from "zod";
import { DEFAULT_SORT, FACETS, NO_FILTER, SORT_COLUMNS, type Facet, type LibraryFilter, type LibrarySort } from "./browse.ts";

export interface BrowseState {
  readonly filter: LibraryFilter;
  readonly sort: LibrarySort;
  /** The facet list open in place of the tracks; null shows the tracks. */
  readonly browseBy: Facet | null;
}

export const FRESH_STATE: BrowseState = { filter: NO_FILTER, sort: DEFAULT_SORT, browseBy: null };

const bpm = z.number().positive().max(999);
const seconds = z.number().nonnegative().nullable();

const StateSchema = z.object({
  filter: z.object({
    search: z.string().max(200),
    bpm: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("any") }),
      z.object({ kind: z.literal("range"), min: bpm.nullable(), max: bpm.nullable() }),
      z.object({ kind: z.literal("near"), bpm, percent: z.number().min(0).max(100) }),
    ]),
    key: z.object({ camelot: z.string().regex(/^(1[0-2]|[1-9])[AB]$/), compatible: z.boolean() }).nullable(),
    genre: z.string().nullable(),
    artist: z.string().nullable(),
    length: z.object({ minSec: seconds, maxSec: seconds }),
    gridReadyOnly: z.boolean(),
  }),
  sort: z.object({ column: z.enum(SORT_COLUMNS), descending: z.boolean() }),
  browseBy: z.enum(FACETS).nullable(),
});

/** Where a picker's state is kept: one per picker ("mix-plans", "freestyle"). */
export const storageKey = (picker: string) => `library-browser:${picker}`;

/** The storage localStorage is, or null where the browser refuses it (private mode, blocked site data). */
function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readBrowseState(picker: string, storage = defaultStorage()): BrowseState {
  try {
    const text = storage?.getItem(storageKey(picker)) ?? null;
    if (text === null) return FRESH_STATE;
    const parsed = StateSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    console.warn(`[library-browser] the remembered ${picker} filter no longer fits; starting with none`, parsed.error.issues);
    return FRESH_STATE;
  } catch (error) {
    console.warn(`[library-browser] the remembered ${picker} filter could not be read; starting with none`, error);
    return FRESH_STATE;
  }
}

export function writeBrowseState(picker: string, state: BrowseState, storage = defaultStorage()): void {
  try {
    storage?.setItem(storageKey(picker), JSON.stringify(state));
  } catch (error) {
    // Full or blocked storage: the filter is simply not remembered.
    console.warn(`[library-browser] the ${picker} filter could not be remembered`, error);
  }
}
