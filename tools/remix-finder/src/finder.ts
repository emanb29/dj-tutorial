/**
 * The deterministic pass: for each song, search the platforms, keep the results that are variants
 * of it, and measure each one's BPM and key. Everything is cached, so the agent (agent.ts) can ask
 * for more searches cheaply and a rerun costs nothing.
 */
import { DAY_MS, jsonCache } from "./cache.ts";
import { ANALYSIS_VERSION, type Analyse, type Analysis } from "./audio.ts";
import { harmony, type Harmony } from "./key.ts";
import type { Platform, SearchResult, Searcher } from "./search.ts";
import type { PlaylistSong } from "./spotify.ts";
import { coreTitle, isDjKind, matchVariant, variantKey, type Song, type VariantKind } from "./variants.ts";

export interface Candidate extends SearchResult {
  readonly kind: VariantKind;
  readonly remixer: string | null;
  /** False for listening versions: slowed, sped up, nightcore, acoustic, live, cover. */
  readonly djFriendly: boolean;
  /** The same variant on other platforms shares it. */
  readonly variantKey: string;
  readonly analysis: Analysis | null;
  /** When this result's own audio could not be measured, the copy on another platform that was. */
  readonly measuredFrom: string | null;
}

export interface SongFindings {
  readonly song: PlaylistSong;
  /** The original's BPM and key, from its Spotify preview. */
  readonly original: Analysis | null;
  readonly candidates: readonly Candidate[];
  readonly queries: readonly string[];
  readonly problems: readonly string[];
}

const asSong = (song: PlaylistSong): Song => ({ title: song.title, artists: song.artists });

/** The searches every song gets before the agent asks for more. */
export function defaultQueries(song: PlaylistSong): string[] {
  const artist = song.artists[0] ?? "";
  const title = coreTitle(song.title);
  return [`${artist} ${title} remix`, `${artist} ${title} edit bootleg`];
}

/** The results that are variants of the song, once each, in the order found. */
export function toCandidates(song: PlaylistSong, results: readonly SearchResult[]): Omit<Candidate, "analysis" | "measuredFrom">[] {
  const seen = new Set<string>([`spotify:${song.spotifyId}`]);
  return results.flatMap((result) => {
    if (seen.has(result.id)) return [];
    seen.add(result.id);
    const variant = matchVariant(asSong(song), result.title, result.uploader);
    if (variant === null) return [];
    return [{ ...result, kind: variant.kind, remixer: variant.remixer, djFriendly: isDjKind(variant.kind), variantKey: variantKey(asSong(song), variant) }];
  });
}

/** Gives a result whose own audio could not be measured the numbers of the same variant elsewhere. */
export function borrowMeasurements(candidates: readonly Candidate[]): Candidate[] {
  const measured = new Map<string, Candidate>();
  for (const candidate of candidates) if (candidate.analysis?.status === "ok" && !measured.has(candidate.variantKey)) measured.set(candidate.variantKey, candidate);
  return candidates.map((candidate) => {
    if (candidate.analysis?.status === "ok") return candidate;
    const twin = measured.get(candidate.variantKey);
    return twin === undefined ? candidate : { ...candidate, analysis: twin.analysis, measuredFrom: twin.id };
  });
}

/** How a candidate's key sits with the original's, when both are known. */
export function harmonyWithOriginal(original: Analysis | null, candidate: Analysis | null): Harmony | null {
  if (original?.status !== "ok" || candidate?.status !== "ok" || original.key === null || candidate.key === null) return null;
  return harmony(original.key.camelot, candidate.key.camelot);
}

export interface FinderOptions {
  readonly searcher: Searcher;
  readonly analyse: Analyse;
  readonly dataDir: string;
  readonly perSearch: number;
  /** Measure BPM and key (slow: a clip per result). Off = metadata only. */
  readonly measure: boolean;
  readonly concurrency: number;
  readonly log: (line: string) => void;
}

const SEARCH_TTL_MS = 7 * DAY_MS;

async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function finder(options: FinderOptions) {
  const searches = jsonCache<SearchResult[]>(`${options.dataDir}/search`, () => SEARCH_TTL_MS);
  // A measurement never changes; an error is retried after a day, "unavailable" after a month.
  const analyses = jsonCache<Analysis>(`${options.dataDir}/analysis`, (value) =>
    value.version !== ANALYSIS_VERSION ? -1 : value.status === "ok" ? Infinity : value.status === "error" ? DAY_MS : 30 * DAY_MS,
  );

  const search = async (platform: Platform, query: string): Promise<SearchResult[]> => {
    const key = `${platform}|${String(options.perSearch)}|${query.toLowerCase()}`;
    const cached = searches.get(key);
    if (cached !== null) return cached;
    const results = await options.searcher.search(platform, query, options.perSearch);
    searches.put(key, results);
    return results;
  };

  const measure = async (result: SearchResult): Promise<Analysis | null> => {
    if (!options.measure) return analyses.get(result.id);
    const cached = analyses.get(result.id);
    if (cached !== null) return cached;
    const analysis = await options.analyse(result);
    analyses.put(result.id, analysis);
    return analysis;
  };

  const measureAll = async (found: readonly Omit<Candidate, "analysis" | "measuredFrom">[]): Promise<Candidate[]> =>
    borrowMeasurements(await mapLimited(found, options.concurrency, async (candidate) => ({ ...candidate, analysis: await measure(candidate), measuredFrom: null })));

  return {
    platforms: options.searcher.platforms,

    /** Runs the searches on the given platforms and returns the song's variants among the results, measured. */
    async variants(song: PlaylistSong, queries: readonly string[], platforms: readonly Platform[] = options.searcher.platforms): Promise<{ candidates: Candidate[]; problems: string[] }> {
      const problems: string[] = [];
      const results: SearchResult[] = [];
      for (const query of queries) {
        for (const platform of platforms.filter((p) => options.searcher.platforms.includes(p))) {
          try {
            results.push(...(await search(platform, query)));
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      return { candidates: await measureAll(toCandidates(song, results)), problems };
    },

    /** The original, measured from its Spotify preview. */
    async original(song: PlaylistSong): Promise<Analysis | null> {
      return measure({ platform: "spotify", id: `spotify:${song.spotifyId}`, title: song.title, uploader: song.artists.join(", "), durationSec: song.durationSec, url: `https://open.spotify.com/track/${song.spotifyId}`, plays: null });
    },

    measureAll,
  };
}
export type Finder = ReturnType<typeof finder>;

/** The default pass over one song. */
export async function findForSong(found: Finder, song: PlaylistSong): Promise<SongFindings> {
  const queries = defaultQueries(song);
  const [original, { candidates, problems }] = await Promise.all([found.original(song), found.variants(song, queries)]);
  return { song, original, candidates, queries, problems };
}

/** Merges more candidates into a song's findings (the agent's extra searches), once each. */
export function mergeFindings(findings: SongFindings, more: readonly Candidate[], queries: readonly string[], problems: readonly string[]): SongFindings {
  const known = new Set(findings.candidates.map((candidate) => candidate.id));
  return {
    ...findings,
    candidates: borrowMeasurements([...findings.candidates, ...more.filter((candidate) => !known.has(candidate.id))]),
    queries: [...findings.queries, ...queries],
    problems: [...findings.problems, ...problems],
  };
}
