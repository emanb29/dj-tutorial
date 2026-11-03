// How hard a Transition is to perform live, from its Execution plan: a weighted sum of the moments that
// make it hard, mapped onto 1–5. It is advice for the Learner and never a validation error: a Transition
// rated 5 still saves, renders and can be practised. The rating is per Learner, because a control whose
// Lesson isn't Passed yet counts against it.
//
// Every number lives in COMPLEXITY_WEIGHTS. Changing one changes ratings, so it bumps `version`, and the
// golden tests (execution-plan.test.ts) pin a rating per recipe.

import type { ControllerUnlocks } from "@app/controller/control-ids.ts";
import { flx4LayoutControl } from "@app/controller/flx4-keys.ts";
import type { ExecutionStep, Hand } from "./execution-plan.ts";
import { type Occupancy, occupancy, overlaps } from "./hands.ts";
import { BEATS_PER_BAR, BEATS_PER_PHRASE, beatIndexOf, type Transition } from "@shared/mix-plan.ts";
import { isPhraseStart, trackVolume, volumeLaneIndex } from "./lanes.ts";

export const COMPLEXITY_WEIGHTS = {
  version: 1,
  /** Points per reason, in the order reasons at one beat are listed. */
  points: {
    /** More than two steps at once: more than two hands. */
    "three-hands": 4,
    /** Two steps at once on the same hand (each pair). */
    "one-hand-two-moves": 2,
    /** A tempo move while both tracks are heard. */
    "tempo-ride": 4,
    /** A control whose Lesson the Learner hasn't Passed (each control). */
    "not-unlocked": 2,
    /** A bar with more than `densePerBar` steps starting in it. */
    "dense-bar": 1,
    /** A step that must land within `fineWindowBeats`: a cut on the 1, an echo throw on the beat. */
    "fine-timing": 1,
    /** A ramp longer than `longRampBeats` that must end on a phrase start. */
    "long-ramp": 1,
    /** One hand going from deck A's side to deck B's (or back) within `handJumpBeats`. */
    "hand-jump": 1,
  },
  /** The lowest score for ratings 2, 3, 4 and 5; less than the first is 1. */
  ratingFloors: [1, 4, 7, 11],
  fineWindowBeats: 1 / 8,
  densePerBar: 2,
  longRampBeats: BEATS_PER_PHRASE,
  handJumpBeats: 1,
  /** How finely a tempo move is checked for both tracks being heard. */
  blendSampleBeats: 1 / 4,
} as const;

export type ComplexityFactor = keyof typeof COMPLEXITY_WEIGHTS.points;

export interface ComplexityReason {
  readonly factor: ComplexityFactor;
  /** Beats from the Transition's start: when it happens. */
  readonly beat: number;
  /** The lanes (indices into the Transition's) whose keyframes cause it. */
  readonly lanes: readonly number[];
  readonly points: number;
}

export interface Complexity {
  /** 1 easy, 2 steady, 3 busy, 4 hard, 5 very hard live. */
  readonly rating: 1 | 2 | 3 | 4 | 5;
  readonly reasons: readonly ComplexityReason[];
  /** The sum of the reasons' points. */
  readonly score: number;
  /** COMPLEXITY_WEIGHTS.version. */
  readonly weightsVersion: number;
}

const FACTOR_ORDER: readonly ComplexityFactor[] = Object.keys(COMPLEXITY_WEIGHTS.points) as ComplexityFactor[];

/** The lanes a step realises keyframes of. */
function lanesOf(...steps: readonly ExecutionStep[]): number[] {
  const lanes = steps.flatMap(({ source, alsoRealises }) => [source, ...alsoRealises].flatMap((entry) => (entry === "incoming-start" ? [] : [entry.lane])));
  return [...new Set(lanes)].sort((a, b) => a - b);
}

const reason = (factor: ComplexityFactor, beat: number, lanes: readonly number[]): ComplexityReason => ({ factor, beat, lanes, points: COMPLEXITY_WEIGHTS.points[factor] });

/** A step with when it keeps its hand busy. */
interface Timed {
  readonly step: ExecutionStep;
  readonly span: Occupancy;
}

/** Stretches where more than two steps are active, each reported once, at the beat the last of them starts. */
function threeHands(timed: readonly Timed[]): ComplexityReason[] {
  const points = [...new Set(timed.map(({ span }) => span.from))].sort((a, b) => a - b);
  const moments: { beat: number; members: Set<ExecutionStep> }[] = [];
  let current: { beat: number; members: Set<ExecutionStep> } | null = null;
  for (const point of points) {
    const active = timed.filter(({ span }) => span.from <= point && point < span.to).map(({ step }) => step);
    if (active.length <= 2) {
      current = null;
      continue;
    }
    if (current === null || !active.some((step) => current?.members.has(step))) {
      current = { beat: Math.max(...active.map(({ startBeat }) => startBeat)), members: new Set() };
      moments.push(current);
    }
    for (const step of active) current.members.add(step);
  }
  return moments.map(({ beat, members }) => reason("three-hands", beat, lanesOf(...members)));
}

function oneHandTwoMoves(timed: readonly Timed[]): ComplexityReason[] {
  return timed.flatMap((first, index) =>
    timed
      .slice(index + 1)
      .filter((second) => second.step.hand === first.step.hand && overlaps(first.span, second.span))
      .map((second) => reason("one-hand-two-moves", Math.max(first.step.startBeat, second.step.startBeat), lanesOf(first.step, second.step))),
  );
}

function denseBars(steps: readonly ExecutionStep[], transition: Transition): ComplexityReason[] {
  const start = beatIndexOf(transition.outgoingAt);
  const bars = new Map<number, ExecutionStep[]>();
  for (const step of steps) {
    const bar = Math.floor((start + step.startBeat) / BEATS_PER_BAR);
    bars.set(bar, [...(bars.get(bar) ?? []), step]);
  }
  return [...bars].flatMap(([bar, inBar]) => (inBar.length > COMPLEXITY_WEIGHTS.densePerBar ? [reason("dense-bar", bar * BEATS_PER_BAR - start, lanesOf(...inBar))] : []));
}

function handJumps(timed: readonly Timed[]): ComplexityReason[] {
  const onHand = (hand: Hand) => timed.filter(({ step }) => step.hand === hand).sort((a, b) => a.span.from - b.span.from);
  return (["left", "right"] as const).flatMap((hand) =>
    onHand(hand).flatMap((next, index, all) => {
      const previous = all[index - 1];
      if (previous === undefined) return [];
      const [from, to] = [flx4LayoutControl(previous.step.control).side, flx4LayoutControl(next.step.control).side];
      const crosses = from !== "centre" && to !== "centre" && from !== to;
      return crosses && next.span.from - previous.span.to < COMPLEXITY_WEIGHTS.handJumpBeats ? [reason("hand-jump", next.step.startBeat, lanesOf(previous.step, next.step))] : [];
    }),
  );
}

function notUnlocked(steps: readonly ExecutionStep[], unlocked: ControllerUnlocks): ComplexityReason[] {
  const locked = [...new Set(steps.map(({ control }) => control))].filter((control) => !unlocked.has(control));
  return locked.map((control) => {
    const using = steps.filter((step) => step.control === control);
    return reason("not-unlocked", Math.min(...using.map(({ startBeat }) => startBeat)), lanesOf(...using));
  });
}

function tempoRides(steps: readonly ExecutionStep[], transition: Transition): ComplexityReason[] {
  const volumeLanes = (["outgoing", "incoming"] as const).map((track) => volumeLaneIndex(transition, track)).filter((index) => index >= 0);
  const bothHeard = (beat: number) => trackVolume(transition, "outgoing", beat) > 0 && trackVolume(transition, "incoming", beat) > 0;
  return steps
    .filter((step) => step.control.endsWith(".tempo"))
    .filter(({ startBeat, endBeat }) => {
      const samples = Math.floor((endBeat - startBeat) / COMPLEXITY_WEIGHTS.blendSampleBeats);
      return Array.from({ length: samples + 1 }, (_, sample) => Math.min(endBeat, startBeat + sample * COMPLEXITY_WEIGHTS.blendSampleBeats)).some(bothHeard);
    })
    .map((step) => reason("tempo-ride", step.startBeat, [...new Set([...lanesOf(step), ...volumeLanes])].sort((a, b) => a - b)));
}

function longRamps(steps: readonly ExecutionStep[], transition: Transition): ComplexityReason[] {
  return steps
    .filter(({ startBeat, endBeat }) => endBeat - startBeat > COMPLEXITY_WEIGHTS.longRampBeats && isPhraseStart(transition, endBeat))
    .map((step) => reason("long-ramp", step.startBeat, lanesOf(step)));
}

function fineTiming(steps: readonly ExecutionStep[]): ComplexityReason[] {
  return steps.filter(({ windowBeats }) => windowBeats <= COMPLEXITY_WEIGHTS.fineWindowBeats).map((step) => reason("fine-timing", step.startBeat, lanesOf(step)));
}

/** The rating for a score: one more than the number of rating floors it reaches. */
export function ratingFor(score: number): Complexity["rating"] {
  return (1 + COMPLEXITY_WEIGHTS.ratingFloors.filter((floor) => score >= floor).length) as Complexity["rating"];
}

/** The first lane that differs decides; a shorter list that matches so far comes first. */
const compareLanes = (a: readonly number[], b: readonly number[]): number => {
  const differs = a.findIndex((lane, position) => lane !== b[position]);
  if (differs === -1) return a.length - b.length;
  const other = b[differs];
  return other === undefined ? 1 : (a[differs] ?? 0) - other;
};

/** At one beat, reasons are listed in the weights table's order, then by lanes. */
const compareReasons = (a: ComplexityReason, b: ComplexityReason) =>
  a.beat - b.beat || FACTOR_ORDER.indexOf(a.factor) - FACTOR_ORDER.indexOf(b.factor) || compareLanes(a.lanes, b.lanes);

/** The Complexity rating of an Execution plan's steps (already in time order, with hands), for one Learner. */
export function rateComplexity(steps: readonly ExecutionStep[], transition: Transition, unlocked: ControllerUnlocks): Complexity {
  const timed = steps.map((step) => ({ step, span: occupancy(step) }));
  const reasons = [
    ...threeHands(timed),
    ...oneHandTwoMoves(timed),
    ...tempoRides(steps, transition),
    ...notUnlocked(steps, unlocked),
    ...denseBars(steps, transition),
    ...fineTiming(steps),
    ...longRamps(steps, transition),
    ...handJumps(timed),
  ].sort(compareReasons);
  const score = reasons.reduce((sum, { points }) => sum + points, 0);
  return { rating: ratingFor(score), reasons, score, weightsVersion: COMPLEXITY_WEIGHTS.version };
}
