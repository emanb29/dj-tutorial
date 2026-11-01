// Shared arithmetic for Check plans and tasks: where on a track a Lesson plays, and when the Check's
// own play-through of a position was heard. Pure.
import type { Attempt, CtxSpan, DeckId } from "@shared/attempt.ts";
import { BARS_PER_PHRASE, BEATS_PER_BAR, beatSec, cuedAt, heardTimeOf, trackOnDeck } from "./track.ts";
import type { CheckPlan, LessonTrack, PositionCue } from "./types.ts";

export const barsSec = (track: LessonTrack, bars: number): number => bars * BEATS_PER_BAR * beatSec(track.grid);

/** The position the Check cues a deck to first: `plan.startPos` (or its first stop) on A, `plan.deckB.pos` on B. */
function cuePosOf(plan: CheckPlan, deck: DeckId): number | undefined {
  return deck === "A" ? (plan.stops?.[0] ?? plan.startPos) : plan.deckB?.pos;
}

/**
 * Heard span of track positions `[fromPos, toPos)` on a deck, both shifted half a beat early so beats
 * sit inside, as the deck played them after the Check's own cue to its start position (`plan.startPos`
 * on A, `plan.deckB.pos` on B) in `window`. The recorded playhead also holds the hook, practice and
 * earlier attempts, which play the same positions; and for the output latency after the attempt
 * starts, the practice is still heard. A bound the deck never reached is +Infinity: runCheck voids such
 * an attempt (`sectionNotHeard`) rather than failing it.
 */
export function heardSpan(track: LessonTrack, plan: CheckPlan, attempt: Attempt, window: CtxSpan, fromPos: number, toPos: number, deck: DeckId = "A"): CtxSpan {
  const playhead = attempt.decks[deck]?.playhead;
  const startPos = cuePosOf(plan, deck);
  const cued = playhead === undefined || startPos === undefined ? null : cuedAt(playhead, startPos, window.from);
  const half = beatSec(trackOnDeck(track, deck).grid) / 2;
  const heard = (pos: number) => (playhead === undefined || cued === null ? null : heardTimeOf(playhead, pos - half, cued));
  return { from: heard(fromPos) ?? Number.POSITIVE_INFINITY, to: heard(toPos) ?? Number.POSITIVE_INFINITY };
}

/**
 * The window from the Check's own cue on: the latest of the moments each deck the plan sets up was
 * cued to its start position, at or after `window.from`. Before that, what is heard and metered is
 * still the practice (for the output latency after the recorder starts). A deck whose cue is not in
 * the recording leaves the window as it is.
 */
export function fromOwnCue(plan: CheckPlan, attempt: Attempt, window: CtxSpan): CtxSpan {
  const cues = (["A", "B"] as const).flatMap((deck) => {
    const playhead = attempt.decks[deck]?.playhead;
    const pos = cuePosOf(plan, deck);
    const at = playhead === undefined || pos === undefined ? null : cuedAt(playhead, pos, window.from);
    return at === null ? [] : [at];
  });
  const from = Math.max(window.from, ...cues);
  return { from: Math.min(from, window.to), to: window.to };
}

/**
 * The captions that count down to `pos` (a bar's 1): `twoBars` two bars ahead, then the last bar
 * counted down on its beats ("<lastBar>: 4", "<lastBar>: 4 · 3", …), drawn large, then `now` half a
 * beat before `pos`, as the taps there open.
 */
export function barCountdown(track: LessonTrack, pos: number, captions: { readonly twoBars: string; readonly lastBar: string; readonly now: string }): PositionCue[] {
  const beat = beatSec(track.grid);
  const counts = Array.from({ length: BEATS_PER_BAR }, (_, index) => BEATS_PER_BAR - index);
  return [
    { fromPos: pos - barsSec(track, 2), caption: captions.twoBars },
    ...counts.map((_, index) => ({
      fromPos: pos - (BEATS_PER_BAR - index) * beat,
      caption: `${captions.lastBar}: ${counts.slice(0, index + 1).join(" · ")}`,
      countdown: true as const,
    })),
    { fromPos: pos - beat / 2, caption: captions.now, countdown: true },
  ];
}

/**
 * The captions that warn of a change of task mid-Check, at `switchPos` (a bar's 1): "<doing> · switch in
 * 2 bars" two bars ahead, then the last bar counted down on its beats ("Switch in 1 bar: 4", "… 4 · 3",
 * …), then `now` half a beat before the switch, as the new task's taps open.
 */
export function switchCountdown(track: LessonTrack, switchPos: number, captions: { readonly doing: string; readonly now: string }): PositionCue[] {
  return barCountdown(track, switchPos, { twoBars: `${captions.doing} · switch in 2 bars`, lastBar: "Switch in 1 bar", now: captions.now });
}

/** The first phrase at or after 2 whose 16 bars hold no breakdown or build (they may have no kick). */
export function steadyPhrase(track: LessonTrack): number {
  const quiet = track.sections.filter((section) => section.name === "breakdown" || section.name === "build").map((section) => section.phrase);
  for (let phrase = 2; phrase + 1 < track.phraseStarts.length; phrase += 1) {
    if (!quiet.includes(phrase) && !quiet.includes(phrase + 1)) return phrase;
  }
  return 2;
}

/**
 * The first phrase at or after 2 that starts `phrases` phrases in a row with no breakdown or build: a
 * blend and what follows it stay on the groove. Null when the track has no such run. `from` moves the
 * earliest phrase later, for a Check that needs more lead-in before it.
 */
export function steadyRun(track: LessonTrack, phrases: number, from = 2): number | null {
  const quiet = (phrase: number) => {
    const name = sectionOf(track, phrase);
    return name === "breakdown" || name === "build";
  };
  for (let phrase = from; phrase + phrases <= track.phraseStarts.length; phrase += 1) {
    if (!Array.from({ length: phrases }, (_, index) => phrase + index).some(quiet)) return phrase;
  }
  return null;
}

/** The section a 1-based phrase is in: the last named section starting at or before it; null when unknown. */
export function sectionOf(track: LessonTrack, phrase: number): string | null {
  return track.sections.filter((section) => section.phrase <= phrase).at(-1)?.name ?? null;
}

/** Sections with the full groove: the kick and the bassline both play (eq-basics needs a LOW to cut). */
const FULL_SECTIONS: ReadonlySet<string> = new Set(["groove", "drop", "main", "chorus", "verse", "peak"]);

/**
 * The first phrase at or after 2 where it and the next `phrases − 1` phrases sit in full-groove
 * sections; null when the track names none. A track without named sections falls back to the steady
 * phrase.
 */
export function fullGroovePhrase(track: LessonTrack, phrases: number): number | null {
  if (track.sections.length === 0) return steadyPhrase(track);
  return firstRunIn(track, phrases, FULL_SECTIONS);
}

/**
 * Sections where chords or a melody play over the groove. The Originals' intros (and the synthetic
 * groove's first two sections) are drums and at most a short, low bass: nothing there holds a note.
 */
const MELODIC_SECTIONS: ReadonlySet<string> = new Set(["drop", "chorus", "peak", "main"]);

/**
 * The first phrase at or after 2 where it and the next `phrases − 1` phrases sit in sections with
 * chords or a melody, so a change of pitch is heard (tempo-fader's Master Tempo clips); null when the
 * track names none.
 */
export function melodicPhrase(track: LessonTrack, phrases: number): number | null {
  return firstRunIn(track, phrases, MELODIC_SECTIONS);
}

function firstRunIn(track: LessonTrack, phrases: number, names: ReadonlySet<string>): number | null {
  for (let phrase = 2; phrase + phrases <= track.phraseStarts.length; phrase += 1) {
    const run = Array.from({ length: phrases }, (_, index) => sectionOf(track, phrase + index));
    if (run.every((name) => name !== null && names.has(name))) return phrase;
  }
  return null;
}

/** How far apart a partner's tempo ideally is: enough for SYNC to be heard doing something. */
const IDEAL_APART = 0.02;

/**
 * Candidates for deck B, best first: only those whose declared tempo is `[minApart, maxApart]` from
 * `bpm` (fractions), nearest 2% apart first. A candidate without a declared tempo is left out.
 */
export function partnerOrder<Candidate extends { readonly bpm: number | undefined }>(
  bpm: number,
  candidates: readonly Candidate[],
  range: { readonly minApart: number; readonly maxApart: number },
): Candidate[] {
  const apart = (candidate: Candidate) => (candidate.bpm === undefined ? Number.POSITIVE_INFINITY : Math.abs(candidate.bpm - bpm) / bpm);
  return candidates
    .filter((candidate) => apart(candidate) >= range.minApart && apart(candidate) <= range.maxApart)
    .toSorted((a, b) => Math.abs(apart(a) - IDEAL_APART) - Math.abs(apart(b) - IDEAL_APART));
}

export { BARS_PER_PHRASE };
