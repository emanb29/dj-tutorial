// Lesson 20, `final-mix`: the Learner's own set of 3+ tracks, by ear (check-design §5). The set's
// rules are its own criteria; the transition rules (on-phrase, drift, level-match …) are the standing
// criteria, measured on every transition's view (src/checks/set.ts) and reported as the worst.
import type { CtxSpan, TaskSpec } from "@shared/attempt.ts";
import type { Band, CriterionResult, FinalMixBands } from "@shared/check-result.ts";
import { clashSpans, handover, phraseDistanceBeats, spansSeconds, swapTime } from "../blend.ts";
import { barSeconds, loadedDeck, type CheckContext, type LessonCheck, type TaskOf } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import type { GradedAttempt } from "../deck-controls.ts";
import { TIME_EPSILON } from "../measures.ts";
import { exitTime, overlapSpans } from "../mix.ts";
import { phaseHold, phasePair } from "../phase.ts";
import { audibleSeconds, BLEND_MIN_BARS, setPlays, setTransitions, type SetTransition, type TransitionKind } from "../set.ts";
import { transitionStanding } from "../standing.ts";
import { positionAt } from "../timeline.ts";

/** `track-count`: at least this many tracks, each audible at least `TRACK_MIN_BARS` (one beat of slack for the meter clock). */
export const MIN_TRACKS = 3;
export const TRACK_MIN_BARS = 16 - 0.25;
/** `tempo-range`: every track's grid tempo within ±2% of the first track's. */
export const MAX_TEMPO_APART = 0.02;

const BANDS: readonly Band[] = ["pass", "merit", "distinction"];
const lowest = (bands: readonly Band[]): Band => BANDS[Math.min(...bands.map((band) => BANDS.indexOf(band)))] ?? "pass";

const normalGenre = (genre: string) => genre.trim().toLowerCase();

function trackCount(context: CheckContext): CriterionResult {
  const long = new Set(
    setPlays(context).flatMap((play) => {
      const grid = context.attempt.grids[play.trackId];
      const first = play.audible[0];
      if (grid === undefined || first === undefined) return [];
      const bar = barSeconds({ deck: play.deck, trackId: play.trackId, playhead: play.playhead, grid, phraseMarkers: [] }, first.from);
      return audibleSeconds(play) >= TRACK_MIN_BARS * bar - TIME_EPSILON ? [play.trackId] : [];
    }),
  );
  return judge({ id: "final-mix.track-count", severity: "fail", unit: "count", threshold: { op: ">=", value: MIN_TRACKS, unit: "count" }, measured: long.size });
}

function oneGenre(task: TaskOf<"final-mix">): CriterionResult {
  const genres = new Set(task.set.map((track) => normalGenre(track.genre)));
  return judge({ id: "final-mix.one-genre", severity: "fail", unit: "count", threshold: { op: "==", value: 1, unit: "count" }, measured: genres.size });
}

/** The largest tempo gap from the first track of the set, as a fraction (0.02 = 2%). */
function tempoRange(context: CheckContext, task: TaskOf<"final-mix">): CriterionResult {
  const bpms = task.set.map((track) => context.attempt.grids[track.trackId]?.bpm);
  const first = bpms[0];
  const measured = first === undefined || bpms.some((bpm) => bpm === undefined) ? null : Math.max(...bpms.map((bpm) => Math.abs((bpm ?? first) / first - 1)));
  return judge({ id: "final-mix.tempo-range", severity: "fail", unit: "ratio", threshold: { op: "<=", value: MAX_TEMPO_APART, unit: "ratio" }, measured });
}

function counts(transitions: readonly SetTransition[]): Readonly<Record<TransitionKind, number>> {
  const count = (kind: TransitionKind) => transitions.filter((transition) => transition.kind === kind).length;
  return { cut: count("cut"), blend: count("blend"), unclassified: count("unclassified") };
}

/** `technique`: at least one blend and one cut (mistake 15, overusing one technique). */
function technique(transitions: readonly SetTransition[]): CriterionResult {
  const { cut, blend, unclassified } = counts(transitions);
  const detail = { blends: blend, cuts: cut, unclassified };
  return judgeAll(
    { id: "final-mix.technique", severity: "fail", unit: "count", threshold: { op: ">=", value: 1, unit: "count" }, measured: blend, detail },
    { id: "final-mix.technique", severity: "fail", unit: "count", threshold: { op: ">=", value: 1, unit: "count" }, measured: cut },
  );
}

/** The blends' overlap spans in a transition's view (the spans `drift` grades). */
function blendSpans(transition: SetTransition): CtxSpan[] {
  const master = loadedDeck(transition.view, "A");
  return overlapSpans(transition.view.attempt, transition.view.window).filter(
    (span) => master !== null && span.to - span.from >= BLEND_MIN_BARS * barSeconds(master, span.from) - TIME_EPSILON,
  );
}

const measuredOf = (criteria: readonly CriterionResult[], id: string) => criteria.find((criterion) => criterion.id === id);
const metOrAbsent = (criteria: readonly CriterionResult[], id: string) => {
  return measuredOf(criteria, id)?.status !== "notMet";
};

/** Beat-syncing (check-design §5.3): Merit holds 25 ms for 92% and recovers within 2 bars; Distinction holds 15 ms for 90% and never passes 40 ms. */
function beatSyncingBand(blends: readonly SetTransition[]): Band {
  const holds = blends.flatMap((transition) => {
    const pair = phasePair(transition.view);
    const spans = blendSpans(transition);
    const first = spans[0];
    if (pair === null || first === undefined) return [];
    const bar = barSeconds(pair.master, first.from);
    return [{ merit: phaseHold(pair, spans, 25, 25), distinction: phaseHold(pair, spans, 15, 40), bar }];
  });
  if (holds.length === 0) return "pass";
  if (holds.every(({ distinction }) => distinction.holdFraction >= 0.9 && distinction.worstRunS <= TIME_EPSILON)) return "distinction";
  return holds.every(({ merit, bar }) => merit.holdFraction >= 0.92 && merit.worstRunS <= 2 * bar + TIME_EPSILON) ? "merit" : "pass";
}

/** The most bass-clash beats in any blend. */
function worstClashBeats(blends: readonly SetTransition[]): number {
  return Math.max(
    0,
    ...blends.map((transition) => {
      const master = loadedDeck(transition.view, "A");
      return master === null ? Number.POSITIVE_INFINITY : spansSeconds(clashSpans(transition.view, blendSpans(transition))) / (barSeconds(master, transition.inAt) / 4);
    }),
  );
}

function balanceBand(criteria: readonly CriterionResult[], blends: readonly SetTransition[]): Band {
  const level = measuredOf(criteria, "standing.level-match")?.measured ?? Number.POSITIVE_INFINITY;
  const clash = worstClashBeats(blends);
  if (level <= 1 && clash <= 1 && metOrAbsent(criteria, "standing.no-boost") && metOrAbsent(criteria, "standing.controls-reset")) return "distinction";
  return level <= 1.5 && clash <= 2 && metOrAbsent(criteria, "standing.no-boost") ? "merit" : "pass";
}

/** Every outgoing track left before its last phrase marker (it did not run out). */
function leftBeforeTheEnd(transition: SetTransition): boolean {
  const outgoing = loadedDeck(transition.view, "A");
  const outAt = exitTime(transition.view.attempt, "A", transition.view.window);
  const pos = outgoing === null || outAt === null ? null : positionAt(outgoing.playhead, outAt);
  const last = outgoing?.phraseMarkers.at(-1);
  return pos !== null && last !== undefined && pos < last;
}

function phrasingBand(criteria: readonly CriterionResult[], transitions: readonly SetTransition[], blends: readonly SetTransition[]): Band {
  const entries = measuredOf(criteria, "standing.on-phrase")?.measured ?? Number.POSITIVE_INFINITY;
  const swaps = blends.every((transition) => {
    const move = handover(transition.view, "A", "B", transition.view.window);
    const at = swapTime(transition.view, move, "A", "B");
    return at === null || (phraseDistanceBeats(move, at) ?? Number.POSITIVE_INFINITY) <= 1;
  });
  if (!(entries <= 0.25 && swaps)) return "pass";
  return transitions.every(leftBeforeTheEnd) ? "distinction" : "merit";
}

export const finalMix: LessonCheck<TaskOf<"final-mix">> = {
  criteria: ["final-mix.track-count", "final-mix.one-genre", "final-mix.tempo-range", "final-mix.technique"],
  situations: { transition: true, transitionViews: (context) => setTransitions(context).map((transition) => transition.view) },
  run(context, task) {
    const transitions = setTransitions(context);
    const blends = transitions.filter((transition) => transition.kind === "blend");
    const { cut, blend, unclassified } = counts(transitions);
    return {
      criteria: [trackCount(context), oneGenre(task), tempoRange(context, task), technique(transitions)],
      metrics: { transitions: transitions.length, blends: blend, cuts: cut, unclassified },
      bands: (criteria): FinalMixBands => {
        const beatSyncing = beatSyncingBand(blends);
        const balance = balanceBand(criteria, blends);
        const phrasing = phrasingBand(criteria, transitions, blends);
        return { beatSyncing, balance, phrasing, overall: lowest([beatSyncing, balance, phrasing]) };
      },
    };
  },
};

/** One transition of a graded set, for the result screen and the final project's notes. */
export interface TransitionReport {
  readonly number: number;
  readonly fromTrackId: string;
  readonly toTrackId: string;
  readonly kind: TransitionKind;
  /** `t_in` of the incoming track, heard time. */
  readonly at: number;
  /** The fail-severity transition rules this one met (on-phrase, level-match, and drift for a blend). */
  readonly met: boolean;
  /** `on-phrase`: the larger of the two decks' offsets from a phrase start, beats. */
  readonly phraseBeats: number | null;
  /** `level-match`: dB apart at the handover. */
  readonly levelDb: number | null;
  /** `drift` (blends): share of the blend within 25 ms, and the longest stretch over 60 ms in bars. */
  readonly phaseHold: number | null;
  readonly worstRunBars: number | null;
}

/** Each transition of a set with its own results: the same measures as the graded criteria, per transition. */
export function finalMixTransitions(spec: TaskSpec, attempt: GradedAttempt): TransitionReport[] {
  const context: CheckContext = { spec, attempt, window: spec.window, lessonId: "final-mix" };
  return setTransitions(context).map((transition) => {
    const results = transitionStanding(transition.view);
    const result = (id: string) => results.find((criterion) => criterion.id === id);
    const drift = transition.kind === "blend" ? result("standing.drift") : undefined;
    const failing = results.filter((criterion) => criterion.severity === "fail" && criterion.status === "notMet");
    return {
      number: transition.number,
      fromTrackId: transition.outgoing.trackId,
      toTrackId: transition.incoming.trackId,
      kind: transition.kind,
      at: transition.inAt,
      met: failing.length === 0,
      phraseBeats: result("standing.on-phrase")?.measured ?? null,
      levelDb: result("standing.level-match")?.measured ?? null,
      phaseHold: drift?.measured ?? null,
      worstRunBars: drift?.detail?.["worstRunBars"] ?? null,
    };
  });
}
