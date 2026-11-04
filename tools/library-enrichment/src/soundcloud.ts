/**
 * Step 2: a track's SoundCloud page, by the ID its file name carries. Personal use, off unless the
 * CLI is given --soundcloud.
 *
 * - Lookups go through yt-dlp's metadata-only mode (no audio, no format URLs), which keeps up with
 *   SoundCloud's client changes so this tool does not have to. One yt-dlp runs at a time, on a
 *   batch pulled from the list, paced per track (the CLI's --seconds-per-track), with yt-dlp's
 *   --sleep-requests spacing the requests inside one lookup.
 * - Rate limited: exponential back-off, then a clean, resumable stop.
 * - Every answer is cached on disk, misses too, with a TTL; a cached ID is never asked again.
 * - The uploader is evidence for who made the track only when it matches the remixer or the
 *   "Artist - " part of the title. It is never credited by itself: labels, promo and repost
 *   channels upload most tracks.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mapGenre } from "./genre.ts";
import { parseTrackName, type ConfidenceBand } from "./name-parse.ts";
import { writeAtomically, type Proposal } from "./store.ts";

export const SOUNDCLOUD_STEP_VERSION = 2;

export interface SoundCloudTrack {
  readonly id: string;
  readonly title: string;
  readonly uploader: string;
  readonly uploaderUrl: string;
  readonly genre: string;
  readonly tags: readonly string[];
  /** YYYYMMDD. */
  readonly uploadDate: string;
  readonly releaseYear: number | null;
  readonly description: string;
  readonly url: string;
}

export type Lookup = { readonly status: "ok"; readonly track: SoundCloudTrack } | { readonly status: "not-found" } | { readonly status: "error"; readonly message: string };

// --- yt-dlp ---------------------------------------------------------------------------------------

const YtDlpTrackSchema = z.object({
  id: z.coerce.string(),
  title: z.string().default(""),
  uploader: z.string().nullish().transform((value) => value ?? ""),
  uploader_url: z.string().nullish().transform((value) => value ?? ""),
  genre: z.string().nullish().transform((value) => value ?? ""),
  tags: z.array(z.string()).nullish().transform((value) => value ?? []),
  upload_date: z.string().nullish().transform((value) => value ?? ""),
  release_year: z.number().int().nullish().transform((value) => value ?? null),
  description: z.string().nullish().transform((value) => value ?? ""),
  webpage_url: z.string().nullish().transform((value) => value ?? ""),
});

export const trackUrl = (id: string) => `https://api.soundcloud.com/tracks/${id}`;

/** yt-dlp's --dump-json lines (one per found track) and its ERROR lines (one per failed ID). */
export function parseYtDlpOutput(stdout: string, stderr: string, ids: readonly string[]): Map<string, Lookup> {
  const results = new Map<string, Lookup>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = YtDlpTrackSchema.safeParse(json);
    if (!parsed.success) continue;
    const data = parsed.data;
    results.set(data.id, {
      status: "ok",
      track: {
        id: data.id,
        title: data.title,
        uploader: data.uploader,
        uploaderUrl: data.uploader_url,
        genre: data.genre,
        tags: data.tags,
        uploadDate: data.upload_date,
        releaseYear: data.release_year,
        description: data.description.slice(0, 2000),
        url: data.webpage_url,
      },
    });
  }
  for (const line of stderr.split("\n")) {
    const error = /^ERROR: \[soundcloud\] (\d+): (.*)$/.exec(line.trim());
    if (error?.[1] === undefined || results.has(error[1])) continue;
    const message = error[2] ?? "";
    results.set(error[1], message.includes("HTTP Error 404") ? { status: "not-found" } : { status: "error", message });
  }
  for (const id of ids) if (!results.has(id)) results.set(id, { status: "error", message: "yt-dlp said nothing about this ID" });
  return results;
}

export interface Fetcher {
  fetchBatch(ids: readonly string[]): Promise<Map<string, Lookup>>;
}

export interface YtDlpOptions {
  readonly binary: string;
  /** Seconds between yt-dlp's HTTP requests. */
  readonly sleepRequestsSec: number;
}

export function ytDlpFetcher(options: YtDlpOptions): Fetcher {
  return {
    fetchBatch: (ids) =>
      new Promise((resolve, reject) => {
        const args = [
          "--ignore-config",
          "--no-cookies",
          "--skip-download",
          "--dump-json",
          "--ignore-errors",
          "--ignore-no-formats-error",
          "--no-warnings",
          "--no-playlist",
          "--extractor-retries",
          "2",
          // No format will match, so yt-dlp asks for no stream URLs: one request per track.
          "--extractor-args",
          "soundcloud:formats=none_none",
          "--sleep-requests",
          String(options.sleepRequestsSec),
          ...ids.map(trackUrl),
        ];
        const child = spawn(options.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", (error) => {
          reject(new Error(`Could not run ${options.binary} (${error.message}). Install yt-dlp or pass --yt-dlp PATH.`));
        });
        child.on("close", () => {
          resolve(parseYtDlpOutput(stdout, stderr, ids));
        });
      }),
  };
}

// --- The cache ------------------------------------------------------------------------------------

export interface CacheEntry {
  readonly id: string;
  readonly fetchedAt: string;
  readonly lookup: Lookup;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an answer is reused. Errors are retried soon; a page that exists changes rarely. */
export const CACHE_TTL_MS: Record<Lookup["status"], number> = { ok: 180 * DAY_MS, "not-found": 30 * DAY_MS, error: DAY_MS };

export function soundCloudCache(folder: string) {
  mkdirSync(folder, { recursive: true });
  const path = (id: string) => join(folder, `${id}.json`);
  return {
    get(id: string, now: Date): CacheEntry | null {
      let entry: CacheEntry;
      try {
        entry = JSON.parse(readFileSync(path(id), "utf8")) as CacheEntry;
      } catch {
        return null;
      }
      return now.getTime() - Date.parse(entry.fetchedAt) <= CACHE_TTL_MS[entry.lookup.status] ? entry : null;
    },
    put(entry: CacheEntry): void {
      writeAtomically(path(entry.id), `${JSON.stringify(entry)}\n`);
    },
  };
}
export type SoundCloudCache = ReturnType<typeof soundCloudCache>;

export interface LookupOptions {
  readonly cache: SoundCloudCache;
  readonly fetcher: Fetcher;
  readonly batchSize: number;
  /**
   * The pace: each batch takes at least this long per ID, start to start, so one ID's whole lookup
   * (however many requests it needs) never comes sooner than this after the last.
   */
  readonly msPerTrack: number;
  /** At least this long from one batch's end to the next one's start: a gap between requests too. */
  readonly minGapMs: number;
  /** When rate limited: wait this, doubling each time in a row, up to `maxBackoffMs`. */
  readonly firstBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Back-offs in a row before the run stops (resumable: the cache keeps every answer). */
  readonly maxBackoffs: number;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onLookup?: (id: string, lookup: Lookup, done: number, total: number) => void;
  readonly log?: (line: string) => void;
}

export interface LookupSummary {
  readonly fromCache: number;
  readonly fetched: number;
  /** Set when SoundCloud kept saying to slow down after every back-off: the run stopped there. */
  readonly stoppedByRateLimit: boolean;
}

const RATE_LIMITED = /HTTP Error 429|too many requests|rate.?limit/i;
export const isRateLimited = (lookup: Lookup) => lookup.status === "error" && RATE_LIMITED.test(lookup.message);

/** Looks up every ID not in the cache, one batch at a time at the given pace, and caches each answer. */
export async function lookupAll(ids: readonly string[], options: LookupOptions): Promise<LookupSummary> {
  const pending = [...new Set(ids)].filter((id) => options.cache.get(id, options.now()) === null);
  const fromCache = new Set(ids).size - pending.length;
  let fetched = 0;
  let backoffs = 0;
  let lastStart: number | null = null;
  let lastSize = 0;
  let lastEnd: number | null = null;
  for (let start = 0; start < pending.length; ) {
    const batch = pending.slice(start, start + options.batchSize);
    if (lastStart !== null && lastEnd !== null) {
      const ready = Math.max(lastStart + lastSize * options.msPerTrack, lastEnd + options.minGapMs);
      const wait = ready - options.now().getTime();
      if (wait > 0) await options.sleep(wait);
    }
    lastStart = options.now().getTime();
    lastSize = batch.length;
    const results = await options.fetcher.fetchBatch(batch);
    lastEnd = options.now().getTime();
    if ([...results.values()].some(isRateLimited)) {
      if (backoffs >= options.maxBackoffs) {
        options.log?.(`Stopped: still rate limited after ${String(backoffs)} back-offs in a row. Run the same command later to resume; the cache keeps what was found.`);
        return { fromCache, fetched, stoppedByRateLimit: true };
      }
      const wait = Math.min(options.firstBackoffMs * 2 ** backoffs, options.maxBackoffMs);
      backoffs++;
      options.log?.(`Rate limited; back-off ${String(backoffs)} of ${String(options.maxBackoffs)}: waiting ${String(Math.round(wait / 60_000))} min, then trying the same IDs again.`);
      await options.sleep(wait);
      continue;
    }
    backoffs = 0;
    const fetchedAt = options.now().toISOString();
    for (const id of batch) {
      const lookup = results.get(id) ?? { status: "error", message: "no answer" };
      options.cache.put({ id, fetchedAt, lookup });
      fetched++;
      options.onLookup?.(id, lookup, fetched, pending.length);
    }
    start += batch.length;
  }
  return { fromCache, fetched, stoppedByRateLimit: false };
}

// --- Proposals ------------------------------------------------------------------------------------

const comparable = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** One credit's names: "A & B", "A x B", "A, B" and "A and B" each name A and B. */
const creditNames = (credit: string) => credit.split(/\s*(?:,|&|\+|\/|\bx\b|\band\b|\bvs\.?)\s*/i).map(comparable).filter((name) => name !== "");

/** Whether the uploader is the credit, or one of the names in it. */
export const matchesCredit = (uploader: string, credit: string) => comparable(credit) === comparable(uploader) || creditNames(credit).includes(comparable(uploader));

/** Words in a channel's name that say it is a label, promoter or repost channel, not an artist. */
const CHANNEL_WORDS = /\b(?:records|recordings|recs|rec\.|label|promo(?:tions?)?|premieres?|network|uploads|reposts?|free\s*(?:dl|downloads?)|nation|tv|radio|channel|music\s+group|collective|official\s+music)\b/i;
export const looksLikeChannel = (uploader: string) => CHANNEL_WORDS.test(uploader);

/** What the names step credited, to check the uploader against. */
export interface NamedCredits {
  readonly artist: string | null;
  readonly originalArtist: string | null;
  readonly remixer: string | null;
}

export type UploaderEvidence = "remixer" | "original-artist" | "artist-prefix";

/** Which credit the uploader matches, if any; a label, promo or repost channel matches none. */
export function uploaderEvidence(uploader: string, credits: readonly NamedCredits[]): UploaderEvidence | null {
  const who = comparable(uploader);
  if (who.length < 2 || looksLikeChannel(uploader)) return null;
  const same = (value: string | null) => value !== null && matchesCredit(uploader, value);
  if (credits.some((credit) => same(credit.remixer))) return "remixer";
  if (credits.some((credit) => same(credit.originalArtist))) return "original-artist";
  if (credits.some((credit) => credit.originalArtist === null && same(credit.artist))) return "artist-prefix";
  return null;
}

const proposal = (field: Proposal["field"], value: string, band: ConfidenceBand, rule: string, evidence: readonly string[]): Proposal => ({
  field,
  value,
  band,
  step: "soundcloud",
  stepVersion: SOUNDCLOUD_STEP_VERSION,
  source: "soundcloud",
  rule,
  evidence,
});

/** What a SoundCloud page says, as proposals, given what the names step credited. */
export function soundCloudProposals(track: SoundCloudTrack, named: NamedCredits): Proposal[] {
  const page = parseTrackName({ rawName: track.title });
  const fromPage: NamedCredits = { artist: page.artist?.value ?? null, originalArtist: page.originalArtist?.value ?? null, remixer: page.remixer?.value ?? null };
  const evidence = uploaderEvidence(track.uploader, [named, fromPage]);
  const base = [`SoundCloud: "${track.title}" by ${track.uploader}`, track.url].filter((line) => line !== "");
  const proposals: Proposal[] = [];

  if (evidence === "remixer") {
    const remixer = [named.remixer, fromPage.remixer].find((value) => value !== null && matchesCredit(track.uploader, value)) ?? track.uploader;
    proposals.push(proposal("artist", remixer, "high", "uploader-is-remixer", [...base, "the uploader is the remixer"]));
  } else if (evidence === "original-artist") {
    const original = [named.originalArtist, fromPage.originalArtist].find((value) => value !== null && matchesCredit(track.uploader, value)) ?? track.uploader;
    proposals.push(proposal("originalArtist", original, "high", "uploader-is-original-artist", [...base, "the uploader is the original artist"]));
  } else if (evidence === "artist-prefix") {
    const artist = [named.artist, fromPage.artist].find((value) => value !== null && matchesCredit(track.uploader, value)) ?? track.uploader;
    proposals.push(proposal("artist", artist, "high", "uploader-is-artist-prefix", [...base, 'the uploader is the "Artist - " in the title']));
  }

  if (track.genre.trim() !== "") proposals.push(proposal("genreRaw", track.genre.trim(), "high", "soundcloud-genre", base));
  const genre = mapGenre(track.genre, track.tags);
  if (genre !== null) {
    const tagLine = track.tags.length === 0 ? [] : [`tags: ${track.tags.slice(0, 12).join(", ")}`];
    proposals.push(proposal("genre", genre.value, genre.band, `soundcloud-${genre.rule}`, [...base, `genre: "${track.genre}"`, ...tagLine]));
  }

  const uploadYear = /^(\d{4})\d{4}$/.exec(track.uploadDate)?.[1] ?? null;
  if (track.releaseYear !== null && track.releaseYear > 1900) {
    proposals.push(proposal("year", String(track.releaseYear), "high", "soundcloud-release-date", base));
  } else if (uploadYear !== null) {
    // The uploader's own upload dates the track; anyone else's may be a re-upload.
    const own = evidence === "remixer" || evidence === "artist-prefix";
    proposals.push(proposal("year", uploadYear, own ? "high" : "medium", own ? "upload-date-by-artist" : "upload-date", [...base, `uploaded ${track.uploadDate}`]));
  }
  return proposals;
}
