// Where a library preview starts, and how far it jumps (the mini player, preview-player.ts). Pure.
//
// A preview is for hearing what a track is, so it starts at the part that says so, not the intro.
// The first of these that is known wins:
// 1. A rekordbox cue (hot or memory) the Learner named for it: "Drop", "Chorus", "Hook". Their own
//    marks beat any guess; a cue with no such name may be a mix-in point, so it is not used.
// 2. An Original's first drop or chorus (its generator's sections).
// 3. The analysis's first big rise in energy (6 dB over 8 bars) past the first tenth: a drop, most often.
// 4. A third of the way in, on the 8-bar line at or before it when the grid is known: past the intro
//    of nearly every dance track, and on a phrase line so it does not start mid-phrase.
// A track under 45 s, or of unknown length, plays from the top.
import type { PreviewHints } from "@tracks";

export const PREVIEW_JUMP_BARS = 16;
/** A jump without a grid: about 16 bars at 128 BPM. */
export const PREVIEW_JUMP_SEC = 30;

const NAMED_FOR_IT = /\b(drop|chorus|hook)\b/i;
const SECTION_FOR_IT = /^(drop|chorus)/i;
const DROP_RISE_DB = 6;
const INTRO_FRACTION = 0.1;
const SHORT_SEC = 45;
const BEATS_PER_BAR = 4;
const SNAP_BARS = 8;
/** A jump forward stops this far before the end, so it never lands on the last frame. */
const END_MARGIN_SEC = 1;

export interface PreviewStart {
  readonly sec: number;
  readonly why: "cue" | "section" | "energy" | "third" | "top";
}

const barSec = (bpm: number) => (BEATS_PER_BAR * 60) / bpm;

export function previewStart(hints: PreviewHints): PreviewStart {
  const duration = hints.durationSec ?? null;
  const inside = (sec: number) => sec >= 0 && (duration === null || sec < duration);
  const earliest = (times: readonly number[]) => times.filter(inside).toSorted((a, b) => a - b)[0];

  const cue = earliest((hints.cues ?? []).filter((each) => NAMED_FOR_IT.test(each.name)).map((each) => each.startSec));
  if (cue !== undefined) return { sec: cue, why: "cue" };
  const section = earliest((hints.sections ?? []).filter((each) => SECTION_FOR_IT.test(each.section)).map((each) => each.startSec));
  if (section !== undefined) return { sec: section, why: "section" };
  if (duration === null || duration < SHORT_SEC) return { sec: 0, why: "top" };
  const rise = earliest((hints.energyRises ?? []).filter((each) => each.energyChangeDb >= DROP_RISE_DB && each.timeSec >= duration * INTRO_FRACTION).map((each) => each.timeSec));
  if (rise !== undefined) return { sec: rise, why: "energy" };

  const third = duration / 3;
  const grid = hints.grid;
  if (grid === undefined || third < grid.barOneSec) return { sec: third, why: "third" };
  const phrase = SNAP_BARS * barSec(grid.bpm);
  return { sec: grid.barOneSec + Math.floor((third - grid.barOneSec) / phrase) * phrase, why: "third" };
}

/** Where a jump of `by` steps (16 bars each with a grid, else 30 s) from `positionSec` lands. */
export function jumpTarget(from: { readonly positionSec: number; readonly by: number; readonly durationSec: number | null; readonly grid?: PreviewHints["grid"] }): number {
  const step = from.grid === undefined ? PREVIEW_JUMP_SEC : PREVIEW_JUMP_BARS * barSec(from.grid.bpm);
  const target = Math.max(0, from.positionSec + from.by * step);
  return from.durationSec === null ? target : Math.min(target, Math.max(0, from.durationSec - END_MARGIN_SEC));
}
