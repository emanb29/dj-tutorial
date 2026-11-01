// "Your music": a Lesson on the Learner's own tracks (the music folder, with rekordbox's grids) when one
// passes the Lesson's own track check (`trackProblems`, and `partner.problems` for deck B). Grading
// does not change; only where the track comes from. A Lesson that asks about named sections (a drop, a
// breakdown) keeps the app's tracks: the Learner's have none named.
//
// Built for a large library: every track is first judged on what the library already knows (its grid
// is ready, its tempo and length, rekordbox's key), with no audio touched. Only the few that pass are
// decoded, one at a time, and the first that still fits is played.
import { keysCompatible, type LessonDefinition, type LessonTrack } from "@lessons";
import type { Random } from "./track-rotation.ts";

/** One of the Learner's tracks whose grid is ready now, decoded only when tried. */
export interface OwnTrack<Audio> {
  readonly key: string;
  /** The track as the library knows it without its audio: tempo and length, no sections. */
  readonly sketch: LessonTrack;
  /** rekordbox's key, as Camelot ("8A"); null when unknown. */
  readonly camelot: string | null;
  readonly prepare: () => Promise<{ readonly track: LessonTrack; readonly audio: Audio } | null>;
}

export interface OwnReady<Audio> {
  readonly track: LessonTrack;
  readonly audio: Audio;
  readonly partnerAudio?: Audio;
}

export type OwnPick<Audio> = { readonly ok: true; readonly ready: OwnReady<Audio> } | { readonly ok: false; readonly reason: string };

/** Each try decodes a whole track: a few at most, however large the library. */
const MAIN_TRIED = 3;
const PARTNERS_TRIED = 3;

function shuffled<Item>(items: readonly Item[], random: Random): Item[] {
  return items
    .map((item) => ({ item, order: random() }))
    .toSorted((a, b) => a.order - b.order)
    .map(({ item }) => item);
}

/** Deck B's candidates for `main`: tempo fits on paper; a key that mixes with A's first, then the rest. */
function partnersFor<Audio>(main: OwnTrack<Audio>, mainTrack: LessonTrack, tracks: readonly OwnTrack<Audio>[], definition: LessonDefinition, random: Random): OwnTrack<Audio>[] {
  const pairing = definition.partner;
  if (pairing === undefined) return [];
  const fitting = shuffled(
    tracks.filter((other) => other.key !== main.key && pairing.problems(mainTrack, other.sketch).length === 0),
    random,
  );
  const mixes = (other: OwnTrack<Audio>) => main.camelot !== null && other.camelot !== null && keysCompatible(main.camelot, other.camelot);
  return [...fitting.filter(mixes), ...fitting.filter((other) => !mixes(other))];
}

export async function pickOwnTracks<Audio>(definition: LessonDefinition, tracks: readonly OwnTrack<Audio>[], random: Random): Promise<OwnPick<Audio>> {
  if (definition.questions.length > 0) return { ok: false, reason: "This Lesson asks about a track's sections, so it uses the app's tracks." };
  if (tracks.length === 0) return { ok: false, reason: "None of your tracks has a beat grid yet: link rekordbox.xml, or let the folder finish (Controller page)." };
  const problemsOf = tracks.map((track) => definition.trackProblems(track.sketch));
  const fitting = tracks.filter((_, index) => problemsOf[index]?.length === 0);
  if (fitting.length === 0) return { ok: false, reason: `None of your tracks fit this Lesson: ${problemsOf[0]?.[0] ?? "they could not be read."}` };
  let firstProblem: string | null = null;
  for (const candidate of shuffled(fitting, random).slice(0, MAIN_TRIED)) {
    const main = await candidate.prepare();
    if (main === null) continue;
    // The audio can still refuse what the sketch allowed (its quiet phrases, the grid's real bar 1).
    const problems = definition.trackProblems(main.track);
    if (problems.length > 0) {
      firstProblem ??= problems[0] ?? null;
      continue;
    }
    const pairing = definition.partner;
    if (pairing === undefined) return { ok: true, ready: main };
    const partners = partnersFor(candidate, main.track, tracks, definition, random);
    if (partners.length === 0) firstProblem ??= "No second track of yours is close enough in tempo to it.";
    for (const other of partners.slice(0, PARTNERS_TRIED)) {
      const second = await other.prepare();
      if (second === null) continue;
      const pairProblems = pairing.problems(main.track, second.track);
      if (pairProblems.length === 0) return { ok: true, ready: { track: { ...main.track, partner: second.track }, audio: main.audio, partnerAudio: second.audio } };
      firstProblem ??= pairProblems[0] ?? null;
    }
  }
  return { ok: false, reason: `None of your tracks fit this Lesson: ${firstProblem ?? "they could not be loaded."}` };
}
