// What a Check grades, in the Learner's words: one short label per criterion, and the "Graded: …"
// line shown before and during a Check, derived from what the Check will grade (`gradedCriteria`).
import { gradedCriteria } from "@checks";
import type { CriterionId, StandingId } from "@shared/check-result.ts";
import type { LessonId } from "@shared/attempt.ts";
import { LESSON_AIDS, type BuiltLesson } from "./catalogue.ts";

/** A few words each, lower case, to sit in one line after "Graded:". */
const OWN_LABELS: Readonly<Record<string, string>> = {
  "deck-basics.fade-in": "fade A in",
  "deck-basics.fade-out": "fade all the way out",
  "deck-basics.no-clip-local": "keep out of the red",
  "beats-and-bars.beat-taps": "taps on the beat",
  "beats-and-bars.downbeat-taps": "then only the 1",
  "phrases.phrase-taps": "a tap each phrase",
  "phrases.name-sections": "name breakdown and drop",
  "gain-staging.trim-A": "TRIM A in the zone",
  "gain-staging.trim-B": "TRIM B in the zone",
  "gain-staging.loud-match": "decks as loud",
  "headphone-cue.cued-taps": "taps on B's kick",
  "headphone-cue.b-off-master": "B off the master",
  "cue-point.cue-on-downbeat": "cue points on a 1",
  "cut-on-phrase.cut-start": "cut on the phrase",
  "cut-on-phrase.cut-tight": "a quick cut",
  "cut-on-phrase.cued-before": "B cued first",
  "cut-on-phrase.loud-jump": "no loudness jump",
  "tempo-fader.set-bpm": "B on the target BPM",
  "tempo-fader.master-tempo-ear": "Master Tempo by ear",
  "tempo-fader.tempo-matched": "tempos matched",
  "sync-blend.blend-start": "in on the phrase",
  "sync-blend.blend-length": "8–16 bar blend",
  "sync-blend.loud-steady": "steady level",
  "sync-blend.trim-untouched": "TRIM alone",
  "crossfader.xf-blend": "slow blend",
  "crossfader.xf-cut": "cut on the 1",
  "crossfader.faders-up": "faders up",
  "eq-basics.low-kill": "LOW down on the 1",
  "eq-basics.low-return": "LOW back on the phrase",
  "eq-basics.eq-centred": "EQs centred",
  "bass-swap.enter-low-cut": "B's LOW down",
  "bass-swap.swap-time": "swap on the 1",
  "bass-swap.clash-short": "short bass clash",
  "filter-transition.hpf-depth": "deep filter",
  "filter-transition.filter-length": "long sweep",
  "filter-transition.cfx-back": "CFX back",
  "nudge-phase.converge": "kicks nudged together",
  "nudge-phase.hold": "kept together",
  "nudge-phase.cue-presses": "no re-cueing",
  "tempo-by-ear.tempo-match": "match the tempo by ear",
  "blend-by-ear.blend-length": "long blend",
  "blend-by-ear.phase-hold": "kicks together",
  "blend-by-ear.swap-time": "swap on the 1",
  "blend-by-ear.clash-short": "short bass clash",
  "blend-by-ear.loud-steady": "steady level",
  "hot-cues.hc-place": "pads on phrase starts",
  "hot-cues.hc-trigger": "pads on the 1",
  "loop-transition.loop-length": "4 or 8 bars",
  "loop-transition.loop-in": "loop from a 1",
  "loop-transition.loop-exit": "EXIT on a 1",
  "loop-transition.loop-entry": "B in on the loop",
  "loop-transition.no-double": "one press each",
  "echo-out.echo-cut": "echo cut on a 1",
  "echo-out.echo-entry": "B on the phrase",
  "echo-out.fx-off": "FX off after the echoes",
  "final-mix.track-count": "3 tracks, 16 bars each",
  "final-mix.one-genre": "one genre",
  "final-mix.tempo-range": "tempos within 2%",
  "final-mix.technique": "a blend and a cut",
};

const STANDING_LABELS: Readonly<Record<StandingId, string>> = {
  "no-clip": "master out of the red",
  "no-dead-air": "no silence",
  "on-phrase": "on the phrase",
  "level-match": "levels matched",
  "cued-first": "cue it first",
  "trim-still": "TRIM alone",
  "no-boost": "no EQ boosts",
  "controls-reset": "knobs centred",
  "sync-kept": "SYNC stays on",
  "no-recue": "no re-cueing",
  "one-bass": "one bassline at a time",
  drift: "no drift",
  overcorrect: "small nudges",
  "key-clash": "keys that fit",
  "technique-mix": "a mix of techniques",
};

/** The Learner's label for a criterion. A criterion without one is a content bug: add it above. */
export function criterionLabel(id: CriterionId): string {
  const [scope, name = ""] = id.split(".", 2) as [string, string | undefined];
  const label = scope === "standing" ? STANDING_LABELS[name as StandingId] : OWN_LABELS[id];
  if (label === undefined) throw new RangeError(`criterion ${id} has no Learner label; add one to criterion-labels.ts`);
  return label;
}

/** "Graded: taps on the beat · then only the 1 · master out of the red", for a Lesson's Check. */
export function gradedLine(definition: { readonly id: BuiltLesson["id"] | "final-mix"; readonly aids?: BuiltLesson["aids"] }, passedLessons: readonly LessonId[]): string {
  const ids = gradedCriteria(definition.id, { passedLessons, aids: { ...LESSON_AIDS, ...definition.aids } });
  // Two criteria can share a label (TRIM alone); say it once.
  const labels = [...new Set(ids.map(criterionLabel))];
  return `Graded: ${labels.join(" · ")}`;
}
