// Which Originals a Lesson may run on, and in what order to try them so the Learner does not hear the
// same track every time. Pure, except `localTrackHistory`, which keeps a small per-browser history in
// localStorage (a convenience, not profile data: losing it only makes the pick plain random).
import { z } from "zod";
import { partnerOrder, PAIR_MAX_APART, PAIR_MIN_APART } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { Track } from "@tracks";

/** Track ids kept in the history. */
export const RECENT_KEPT = 20;
/** The most recent tracks a pick avoids while anything else fits. */
export const RECENT_AVOIDED = 10;
export const TRACK_HISTORY_KEY = "learn-to-dj.recent-tracks";

/**
 * Steady four-on-the-floor dance music with clear 8-bar phrases, by the generator's index tags.
 *
 * - House (120–126 BPM) for every Lesson: the course centres on it (docs/lesson-catalogue.md, "Genre
 *   focus (revised 2026-10-17)"). Every house subgenre in the index qualifies (deep, nu-disco, indie
 *   dance, future, electro, melodic, jackin) except electro swing: its swung groove makes the beat
 *   harder to hear, the reason Q7 keeps swung music out of Checks.
 * - Techno (125–135 BPM) only in the By-ear group (Lessons 14–16), as Q7 decides: same steady kick,
 *   a harder tempo for a beginner's first Lessons.
 * - Never UK garage (swung 2-step), dubstep and other bass music (half-time), or drum & bass (broken
 *   beats, 170+ BPM): Q7 keeps them out of every v1 Check.
 */
const HOUSE = { genre: "house", minBpm: 120, maxBpm: 126, excludedSubgenres: ["electro swing"] } as const;
const TECHNO = { genre: "techno", minBpm: 125, maxBpm: 135 } as const;
const BY_EAR_LESSONS: readonly LessonId[] = ["nudge-phase", "tempo-by-ear", "blend-by-ear"];

const lower = (text: string | undefined) => (text ?? "").trim().toLowerCase();
const within = (bpm: number | undefined, min: number, max: number) => bpm !== undefined && bpm >= min && bpm <= max;

/** May `lessonId` run on this Original, judged from its index tags alone (no download)? */
export function lessonMayUse(track: Track, lessonId: LessonId): boolean {
  const genre = lower(track.genre);
  if (genre === HOUSE.genre) {
    return within(track.bpmHint, HOUSE.minBpm, HOUSE.maxBpm) && !HOUSE.excludedSubgenres.some((excluded) => lower(track.subgenre) === excluded);
  }
  if (genre === TECHNO.genre) return BY_EAR_LESSONS.includes(lessonId) && within(track.bpmHint, TECHNO.minBpm, TECHNO.maxBpm);
  return false;
}

/** The id a history stores and a LessonTrack carries: `source:id`. */
export const historyId = (track: Track) => `${track.source}:${track.id}`;

export interface TrackHistory {
  /** Most recent first, at most `RECENT_KEPT`, across every Lesson. */
  readonly recent: readonly string[];
  /** The deck A track each Lesson last ran on. */
  readonly lastByLesson: Readonly<Partial<Record<string, string>>>;
}

export const NO_HISTORY: TrackHistory = { recent: [], lastByLesson: {} };

export interface TrackHistoryStore {
  read(): TrackHistory;
  /** `trackIds[0]` is deck A; a pair's partner follows. */
  heard(lessonId: LessonId, trackIds: readonly string[]): void;
}

/** The history after a Lesson ran on `trackIds`. */
export function withHeard(history: TrackHistory, lessonId: LessonId, trackIds: readonly string[]): TrackHistory {
  const [deckA] = trackIds;
  if (deckA === undefined) return history;
  return {
    recent: [...trackIds, ...history.recent.filter((id) => !trackIds.includes(id))].slice(0, RECENT_KEPT),
    lastByLesson: { ...history.lastByLesson, [lessonId]: deckA },
  };
}

const StoredHistory = z.object({
  recent: z.array(z.string()).transform((ids) => ids.slice(0, RECENT_KEPT)),
  lastByLesson: z.record(z.string(), z.string()),
});

const defaultStorage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/**
 * The history in localStorage. Every access is guarded: with storage blocked, full or holding junk,
 * reads give no history (plain random picks) and writes are dropped.
 */
export function localTrackHistory(storage: () => Storage | null = defaultStorage): TrackHistoryStore {
  const read = (): TrackHistory => {
    try {
      const raw = storage()?.getItem(TRACK_HISTORY_KEY);
      if (raw == null) return NO_HISTORY;
      const parsed = StoredHistory.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : NO_HISTORY;
    } catch (error) {
      console.warn("[lesson] the recent-tracks history could not be read; picking at random", error);
      return NO_HISTORY;
    }
  };
  return {
    read,
    heard(lessonId, trackIds) {
      try {
        storage()?.setItem(TRACK_HISTORY_KEY, JSON.stringify(withHeard(read(), lessonId, trackIds)));
      } catch (error) {
        console.warn("[lesson] the recent-tracks history could not be saved", error);
      }
    },
  };
}

/** A random number in [0, 1), like `Math.random`; tests pass `seededRandom`. */
export type Random = () => number;

/** A small deterministic generator (mulberry32) for tests. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<Item>(items: readonly Item[], random: Random): Item[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other] as Item, result[index] as Item];
  }
  return result;
}

/**
 * The order to try `candidates` in: those not among the last `RECENT_AVOIDED` heard, at random; then
 * the recent ones, least recently heard first; last of all `notAgain` (this Lesson's previous track),
 * so it plays twice in a row only when nothing else fits.
 */
export function rotationOrder<Item>(
  candidates: readonly Item[],
  idOf: (item: Item) => string,
  history: TrackHistory,
  random: Random,
  notAgain?: string,
): Item[] {
  const avoided = history.recent.slice(0, RECENT_AVOIDED);
  const fresh = candidates.filter((item) => idOf(item) !== notAgain && !avoided.includes(idOf(item)));
  const stale = candidates
    .filter((item) => idOf(item) !== notAgain && avoided.includes(idOf(item)))
    .toSorted((a, b) => avoided.indexOf(idOf(b)) - avoided.indexOf(idOf(a)));
  return [...shuffled(fresh, random), ...stale, ...candidates.filter((item) => idOf(item) === notAgain)];
}

/** Deck A candidates for a Lesson, in the order to try them. */
export function deckAOrder(originals: readonly Track[], lessonId: LessonId, history: TrackHistory, random: Random): Track[] {
  const pool = originals.filter((track) => lessonMayUse(track, lessonId));
  return rotationOrder(pool, historyId, history, random, history.lastByLesson[lessonId]);
}

/**
 * Deck B candidates for `main`, in the order to try them: same genre (one genre per mix), allowed in
 * this Lesson, declared tempo `PAIR_MIN_APART`–`PAIR_MAX_APART` from `bpm` (deck A's loaded grid), and
 * rotated like deck A. The loaded grids and the Lesson's own pair rules decide.
 */
export function partnerCandidates(main: Track, bpm: number, originals: readonly Track[], lessonId: LessonId, history: TrackHistory, random: Random): Track[] {
  const sameGenre = originals.filter((other) => other.id !== main.id && lower(other.genre) === lower(main.genre) && lessonMayUse(other, lessonId));
  const fitting = partnerOrder(
    bpm,
    sameGenre.map((other) => ({ other, bpm: other.bpmHint })),
    { minApart: PAIR_MIN_APART, maxApart: PAIR_MAX_APART },
  ).map(({ other }) => other);
  return rotationOrder(fitting, historyId, history, random);
}
