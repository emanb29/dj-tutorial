// The Originals player's list logic, kept out of React so it can be tested: fetching the list as a
// value (never a throw), merging a poll into what is shown, filtering by genre, and moving between
// tracks. The API appends to index.jsonl as the generator finishes a track, so index order is
// oldest first; the page shows newest first.
import { z } from "zod";
import { ORIGINALS_PATH, OriginalSummarySchema, type OriginalSummary } from "@shared/originals.ts";

/** One row on the page: the track, and whether it arrived after the page first loaded. */
export interface OriginalRow {
  readonly original: OriginalSummary;
  readonly isNew: boolean;
}

/** Why the list could not be fetched. A value, never a throw; `fix` says what to do about it. */
export type ListProblem =
  | { readonly kind: "aborted"; readonly message: string; readonly fix: string }
  | { readonly kind: "api-down"; readonly message: string; readonly fix: string }
  | { readonly kind: "not-served"; readonly message: string; readonly fix: string }
  | { readonly kind: "bad-response"; readonly message: string; readonly fix: string };

export type ListResult = { readonly ok: true; readonly originals: readonly OriginalSummary[] } | { readonly ok: false; readonly problem: ListProblem };

const ListBodySchema = z.object({ success: z.literal(true), data: z.array(OriginalSummarySchema) });

const API_DOWN: ListProblem = {
  kind: "api-down",
  message: "The API isn't answering.",
  fix: "Is npm run dev running? It starts the API on 127.0.0.1:5180.",
};

/** Fetches `GET /api/originals`. Gateway errors count as the API being down: Vite's proxy answers them. */
export async function fetchOriginals(fetchFn: typeof fetch, signal?: AbortSignal): Promise<ListResult> {
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(ORIGINALS_PATH, { credentials: "same-origin", cache: "no-store", ...(signal === undefined ? {} : { signal }) });
    text = await response.text();
  } catch {
    if (signal?.aborted === true) return { ok: false, problem: { kind: "aborted", message: "The request was cancelled.", fix: "Nothing to do." } };
    return { ok: false, problem: API_DOWN };
  }
  if (response.status === 404) {
    return {
      ok: false,
      problem: {
        kind: "not-served",
        message: "The API doesn't serve Originals.",
        fix: "Set ORIGINALS_DIR (default .local/tracks/originals) and restart npm run dev.",
      },
    };
  }
  if (response.status >= 500) return { ok: false, problem: API_DOWN };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = ListBodySchema.safeParse(json);
  if (!response.ok || !parsed.success) {
    return {
      ok: false,
      problem: {
        kind: "bad-response",
        message: `The API answered ${String(response.status)} with a list the page can't read.`,
        fix: "Check index.jsonl in ORIGINALS_DIR, then the API's log for originals.badIndexLine.",
      },
    };
  }
  return { ok: true, originals: parsed.data.data };
}

/**
 * The rows to show after a fetch, newest first. Tracks not in `previous` are marked new, except on
 * the first load (`previous` null), when nothing is. A track keeps its "new" mark once it has one.
 */
export function mergeOriginals(previous: readonly OriginalRow[] | null, fetched: readonly OriginalSummary[]): OriginalRow[] {
  const before = new Map((previous ?? []).map((row) => [row.original.id, row]));
  return fetched.toReversed().map((original) => ({
    original,
    isNew: previous !== null && (before.get(original.id)?.isNew ?? true),
  }));
}

/** The genres there are, in the order they first appear in the list (so the newest genre leads). */
export function genresOf(rows: readonly OriginalRow[]): string[] {
  return [...new Set(rows.map((row) => row.original.genre))];
}

/** The rows in `genre`, or all of them when `genre` is null. */
export function filterByGenre(rows: readonly OriginalRow[], genre: string | null): readonly OriginalRow[] {
  return genre === null ? rows : rows.filter((row) => row.original.genre === genre);
}

/**
 * The id of the track `step` rows away from `currentId` in `rows` (1 = next, down the list; -1 =
 * previous), or null at either end. With no current track, or one filtered out, it is the first row.
 */
export function stepFrom(rows: readonly OriginalRow[], currentId: string | null, step: 1 | -1): string | null {
  const index = rows.findIndex((row) => row.original.id === currentId);
  if (index === -1) return rows[0]?.original.id ?? null;
  return rows[index + step]?.original.id ?? null;
}

/** "5:07" for 307.2 s; "1:02:03" past an hour. Seconds round down, so the elapsed time never runs ahead. */
export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${secs}` : `${String(minutes)}:${secs}`;
}

/** "A minor · 8A", or whichever of the two is known, or null. */
export function formatKey(original: Pick<OriginalSummary, "key" | "camelot">): string | null {
  const parts = [original.key, original.camelot].filter((part) => part !== undefined);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "house · deep house", or just the genre (with no subgenre, or one that repeats it). */
export function formatGenre(original: Pick<OriginalSummary, "genre" | "subgenre">): string {
  return original.subgenre === undefined || original.subgenre === original.genre ? original.genre : `${original.genre} · ${original.subgenre}`;
}
