// Lesson tracks: turning what a track source knows (an Original's exact grid, a starter-pack
// analysis, the synthetic track's layout) into the `LessonTrack` a Lesson plans its Check on.
// Pure: no audio here.
import type { BeatGrid, CtxTime, PlayheadModel } from "@shared/attempt.ts";
import type { KnownBeatGrid } from "@tracks";
import type { LessonTrack, TrackSection } from "./types.ts";

export const BEATS_PER_BAR = 4;
export const BARS_PER_PHRASE = 8;

export function beatSec(grid: BeatGrid): number {
  return 60 / grid.bpm;
}

/** Track seconds where 1-based `bar` starts. Bar 1 is the grid's first downbeat at or after its first beat. */
export function barStart(grid: BeatGrid, bar: number): number {
  const firstDownbeat = ((grid.downbeatIndex % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  return grid.firstBeat + (firstDownbeat + (bar - 1) * BEATS_PER_BAR) * beatSec(grid);
}

/** Track seconds where 1-based 8-bar `phrase` starts. */
export function phraseStart(grid: BeatGrid, phrase: number): number {
  return barStart(grid, (phrase - 1) * BARS_PER_PHRASE + 1);
}

/** Every 8-bar phrase start from bar 1 that has at least one full bar before the track ends. */
export function phraseStartsOf(grid: BeatGrid, durationSec: number): number[] {
  const barLength = BEATS_PER_BAR * beatSec(grid);
  const starts: number[] = [];
  for (let phrase = 1; phraseStart(grid, phrase) + barLength <= durationSec + 1e-9; phrase += 1) {
    starts.push(phraseStart(grid, phrase));
  }
  return starts;
}

/** The first section called `name` at or after phrase `from`; null when the track has none. */
export function phraseOf(sections: readonly TrackSection[], name: string, from = 1): number | null {
  return sections.find((section) => section.name === name && section.phrase >= from)?.phrase ?? null;
}

interface TrackMeta {
  readonly id: string;
  readonly title: string;
  readonly artist?: string;
  readonly attribution: LessonTrack["attribution"];
}

/**
 * A known grid (src/tracks KnownBeatGrid): an Original's, with sections from the generator, or one the
 * Learner set in rekordbox, with none. Either way no analysis, and phrases count from its bar 1. A
 * rekordbox track is the Learner's own file: not an Original (which can be swapped for another).
 */
export function lessonTrackFromKnownGrid(
  meta: TrackMeta,
  known: KnownBeatGrid,
): LessonTrack {
  const grid: BeatGrid = { bpm: known.bpm, firstBeat: known.firstBeatSec, downbeatIndex: known.downbeatPhase, rmsResidualMs: 0 };
  return {
    trackId: meta.id,
    title: meta.title,
    ...(meta.artist === undefined ? {} : { artist: meta.artist }),
    attribution: meta.attribution,
    source: known.origin === "generator-meta" ? "original" : "starter-pack",
    durationSec: known.durationSec,
    grid,
    phraseStarts: phraseStartsOf(grid, known.durationSec),
    sections: known.phrases.map((phrase) => ({
      name: phrase.section,
      phrase: Math.floor((phrase.bar - 1) / BARS_PER_PHRASE) + 1,
    })),
  };
}

/**
 * A starter-pack track's analysis (src/analysis TrackAnalysis). Null when the analysis found no bar 1
 * or gave no residual (the dj-core fallback): the Check could not grade on it.
 */
export function lessonTrackFromAnalysis(
  meta: TrackMeta,
  analysis: {
    readonly bpm: number;
    readonly durationSec: number;
    readonly firstBeatSec: number;
    readonly downbeatPhase: number | null;
    readonly residualRmsMs: number | null;
  },
): LessonTrack | null {
  if (analysis.downbeatPhase === null || analysis.residualRmsMs === null) return null;
  const grid: BeatGrid = {
    bpm: analysis.bpm,
    firstBeat: analysis.firstBeatSec,
    downbeatIndex: analysis.downbeatPhase,
    rmsResidualMs: analysis.residualRmsMs,
  };
  return {
    trackId: meta.id,
    title: meta.title,
    attribution: meta.attribution,
    source: "starter-pack",
    durationSec: analysis.durationSec,
    grid,
    phraseStarts: phraseStartsOf(grid, analysis.durationSec),
    sections: [],
  };
}

/**
 * The first heard time at or after `notBefore` at which a recorded deck plays track position `pos`;
 * null if it never does.
 */
export function heardTimeOf(playhead: PlayheadModel, pos: number, notBefore: CtxTime = Number.NEGATIVE_INFINITY): CtxTime | null {
  for (const [index, segment] of playhead.segments.entries()) {
    if (segment.rate <= 0) continue;
    const end = playhead.segments[index + 1]?.fromCtx ?? Number.POSITIVE_INFINITY;
    const at = segment.fromCtx + (pos - segment.pos) / segment.rate;
    if (at >= Math.max(segment.fromCtx - 1e-9, notBefore) && at < end) return at;
  }
  return null;
}

/** When the deck was cued to `pos` (a seek or a start exactly there) at or after `notBefore`; null if never. */
export function cuedAt(playhead: PlayheadModel, pos: number, notBefore: CtxTime = Number.NEGATIVE_INFINITY): CtxTime | null {
  return playhead.segments.find((segment) => segment.fromCtx >= notBefore && Math.abs(segment.pos - pos) < 1e-6)?.fromCtx ?? null;
}

/** Sample peak of some audio channels, dBFS; −Infinity for silence. */
export function peakDbfsOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
}

/**
 * The trim knob (−1…1) that adds `decibels`: the inverse of the engine's trim curve (+9 dB fully right,
 * linear down to −24 dB just before silence). Clamped to the knob's audible range.
 */
export function trimKnobFor(decibels: number): number {
  return decibels >= 0 ? Math.min(1, decibels / 9) : Math.max(-0.95, decibels / 24);
}

/**
 * Where a set-up puts a track's sample peak, dBFS (measured on the file, before the mixer). Originals
 * are mastered to about −8.6 LUFS and peak near −0.5 dBFS decoded, and the isolator's phase shift
 * raises a limited master's peaks by up to about 5.5 dB: at unity a channel meter reads +4 dBFS. From
 * −9 the channel reads about −3.5 dBFS, and two decks summed at the crossfader's centre (−3 dB each)
 * stay out of the red even in phase.
 */
export const SET_UP_PEAK_DB = -9;
/** The peak a track is taken to have when it was not measured: the synthetic groove's. */
export const UNMEASURED_PEAK_DB = -6;

/**
 * The trim, dB, a set-up gives both decks: brings the louder of the Lesson's tracks (this one and its
 * partner) down to `SET_UP_PEAK_DB`; never a boost, so a quiet track stays at unity. One value for
 * both decks keeps the tracks' own loudness difference, which level-match grades.
 */
export function setUpTrimDb(track: LessonTrack): number {
  const peaks = [track.peakDbfs ?? UNMEASURED_PEAK_DB, ...(track.partner === undefined ? [] : [track.partner.peakDbfs ?? UNMEASURED_PEAK_DB])];
  return Math.min(0, SET_UP_PEAK_DB - Math.max(...peaks));
}

/** `setUpTrimDb` as the trim knob: what every Lesson set-up turns TRIM to, except where trimming is the point (gain-staging). */
export function setUpTrim(track: LessonTrack): number {
  return trimKnobFor(setUpTrimDb(track));
}

/**
 * A piece of a Lesson track as a track of its own (the cue-point Check loads three in turn). Its grid is
 * the parent's, shifted so position 0 is `fromSec`; it has no phrases or sections.
 */
export function sliceTrack(track: LessonTrack, slice: { readonly fromSec: number; readonly lengthSec: number }, index: number): LessonTrack {
  const beat = beatSec(track.grid);
  const firstInSlice = Math.ceil((slice.fromSec - track.grid.firstBeat) / beat - 1e-9);
  const downbeatIndex = (((track.grid.downbeatIndex - firstInSlice) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  return {
    ...track,
    trackId: `${track.trackId}#cue-${String(index + 1)}`,
    durationSec: slice.lengthSec,
    grid: { ...track.grid, firstBeat: track.grid.firstBeat + firstInSlice * beat - slice.fromSec, downbeatIndex },
    phraseStarts: [],
    sections: [],
  };
}

/** The track on a deck: on B the partner when the Lesson has one, else the Lesson track itself. */
export function trackOnDeck(track: LessonTrack, deck: "A" | "B"): LessonTrack {
  return deck === "B" ? (track.partner ?? track) : track;
}
