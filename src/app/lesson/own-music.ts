// "Your music": a Lesson on the Learner's own tracks (the music folder, with rekordbox's grids) when one
// passes the Lesson's own track check (`trackProblems`, and `partner.problems` for deck B). Grading
// does not change; only where the track comes from. A Lesson that asks about named sections (a drop, a
// breakdown) keeps the app's tracks: the Learner's have none named.
import type { LessonDefinition, LessonTrack } from "@lessons";
import type { Random } from "./track-rotation.ts";

/** One of the Learner's tracks, prepared (grid, audio) only when tried. */
export interface OwnTrack<Audio> {
  readonly key: string;
  /** From the folder's analysis or rekordbox; tracks without one are not analysed yet and are left out. */
  readonly bpm: number | null;
  readonly prepare: () => Promise<{ readonly track: LessonTrack; readonly audio: Audio } | null>;
}

export interface OwnReady<Audio> {
  readonly track: LessonTrack;
  readonly audio: Audio;
  readonly partnerAudio?: Audio;
}

export type OwnPick<Audio> = { readonly ok: true; readonly ready: OwnReady<Audio> } | { readonly ok: false; readonly reason: string };

/** Each try decodes a whole track: a few, not the whole folder. */
const MAIN_TRIED = 4;
const PARTNERS_TRIED = 4;
/** Partners are tried only this close in tempo; the Lesson's own check then decides. */
const PARTNER_PREFILTER = 0.06;

function shuffled<Item>(items: readonly Item[], random: Random): Item[] {
  return items
    .map((item) => ({ item, order: random() }))
    .toSorted((a, b) => a.order - b.order)
    .map(({ item }) => item);
}

export async function pickOwnTracks<Audio>(definition: LessonDefinition, tracks: readonly OwnTrack<Audio>[], random: Random): Promise<OwnPick<Audio>> {
  if (definition.questions.length > 0) return { ok: false, reason: "This Lesson asks about a track's sections, so it uses the app's tracks." };
  const analysed = tracks.filter((track) => track.bpm !== null);
  if (analysed.length === 0) return { ok: false, reason: "No tracks from your music folder yet: pick it on the Controller page." };
  let firstProblem: string | null = null;
  for (const candidate of shuffled(analysed, random).slice(0, MAIN_TRIED)) {
    const main = await candidate.prepare();
    if (main === null) continue;
    const problems = definition.trackProblems(main.track);
    if (problems.length > 0) {
      firstProblem ??= problems[0] ?? null;
      continue;
    }
    const pairing = definition.partner;
    if (pairing === undefined) return { ok: true, ready: main };
    const bpm = main.track.grid.bpm;
    const others = analysed.filter((other) => other.key !== candidate.key && other.bpm !== null && Math.abs(other.bpm - bpm) / bpm <= PARTNER_PREFILTER);
    for (const other of shuffled(others, random).slice(0, PARTNERS_TRIED)) {
      const second = await other.prepare();
      if (second === null) continue;
      const pairProblems = pairing.problems(main.track, second.track);
      if (pairProblems.length === 0) return { ok: true, ready: { track: { ...main.track, partner: second.track }, audio: main.audio, partnerAudio: second.audio } };
      firstProblem ??= pairProblems[0] ?? null;
    }
    firstProblem ??= "No second track of yours is within 3% of its tempo.";
  }
  return { ok: false, reason: `None of your tracks fit this Lesson: ${firstProblem ?? "they could not be loaded."}` };
}
