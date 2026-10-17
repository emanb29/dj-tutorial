// Blend measures shared by sync-blend, crossfader, bass-swap and blend-by-ear (check-design §2, §4).
import type { CtxSpan, CtxTime, DeckId } from "@shared/attempt.ts";
import type { CriterionId, CriterionResult, Severity } from "@shared/check-result.ts";
import { barSeconds, loadedDeck, type CheckContext, type LoadedDeck } from "./context.ts";
import { judge, judgeAll } from "./criterion.ts";
import { phaseHold, phasePair } from "./phase.ts";
import { energyMeanDb, TIME_EPSILON } from "./measures.ts";
import { entryTime, exitTime, framesIn, overlapSpans } from "./mix.ts";
import { phraseOffsetBeats } from "./phrasing.ts";
import { controlEvents, controlValueAt } from "./timeline.ts";

/** One transition: `outgoing` hands the master over to `incoming` inside `span`. */
export interface Handover {
  readonly outgoing: LoadedDeck | null;
  readonly incoming: LoadedDeck | null;
  /** `t_in` of the incoming deck. */
  readonly inAt: CtxTime | null;
  /** `t_out` of the outgoing deck. */
  readonly outAt: CtxTime | null;
  /** A bar of the outgoing deck at `t_in` (both decks share a tempo during a blend). */
  readonly bar: number | null;
  readonly span: CtxSpan;
}

export function handover(context: CheckContext, outgoing: DeckId, incoming: DeckId, span: CtxSpan = context.window): Handover {
  const out = loadedDeck(context, outgoing);
  const inAt = entryTime(context.attempt, incoming, span);
  return {
    outgoing: out,
    incoming: loadedDeck(context, incoming),
    inAt,
    outAt: exitTime(context.attempt, outgoing, span),
    bar: out === null || inAt === null ? null : barSeconds(out, inAt),
    span,
  };
}

/** `|phraseOff(t, outgoing)|` in beats, for a blend start or a bass swap. */
export function phraseDistanceBeats(move: Handover, t: CtxTime | null): number | null {
  if (move.outgoing === null || t === null) return null;
  const offset = phraseOffsetBeats(move.outgoing, t);
  return offset === null ? null : Math.abs(offset);
}

/** `blend-start`: `|phraseOff(t_in, outgoing)| ≤ 1 beat`. */
export function blendStart(id: CriterionId, move: Handover): CriterionResult {
  return judge({
    id,
    severity: "fail",
    unit: "beats",
    threshold: { op: "<=", value: 1, unit: "beats" },
    measured: phraseDistanceBeats(move, move.inAt),
    evidence: move.inAt === null ? [] : [{ from: move.inAt, to: move.inAt, label: "B in" }],
  });
}

/** `t_out − t_in` in bars of the outgoing deck. */
export function blendBars(move: Handover): number | null {
  return move.inAt === null || move.outAt === null || move.bar === null ? null : (move.outAt - move.inAt) / move.bar;
}

/** `blend-length` within `[low, high]` bars. */
export function blendLength(id: CriterionId, move: Handover, range: readonly [number, number]): CriterionResult {
  return judge({
    id,
    severity: "fail",
    unit: "bars",
    threshold: { op: "in", value: range, unit: "bars" },
    measured: blendBars(move),
    evidence: move.inAt === null || move.outAt === null ? [] : [{ from: move.inAt, to: move.outAt, label: "blend" }],
  });
}

/** A blend of at least `bars` (`blend-by-ear`). */
export function blendAtLeast(id: CriterionId, move: Handover, bars: number): CriterionResult {
  return judge({
    id,
    severity: "fail",
    unit: "bars",
    threshold: { op: ">=", value: bars, unit: "bars" },
    measured: blendBars(move),
    evidence: move.inAt === null || move.outAt === null ? [] : [{ from: move.inAt, to: move.outAt, label: "blend" }],
  });
}

const LOUD_STEADY_DB = 3;

/**
 * `loud-steady`: the largest `|barLoud − ref|` over the bars of `[t_in, t_out + 4 bars]`, with `ref`
 * the mean `barLoud` of the 4 bars before `t_in`. Bars are counted from `t_in`.
 */
export function loudSteady(id: CriterionId, context: CheckContext, move: Handover): CriterionResult {
  const { inAt, outAt, bar } = move;
  let measured: number | null = null;
  if (inAt !== null && outAt !== null && bar !== null) {
    const barLoud = (from: CtxTime) =>
      energyMeanDb(framesIn(context.attempt.meters.master, { from, to: from + bar }).map((frame) => frame.momentaryLufs));
    const before = [1, 2, 3, 4]
      .map((index) => barLoud(inAt - index * bar))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const reference = before.length === 0 ? null : before.reduce((sum, value) => sum + value, 0) / before.length;
    const bars = Math.ceil((outAt + 4 * bar - inAt) / bar - TIME_EPSILON);
    const deviations = Array.from({ length: bars }, (_, index) => barLoud(inAt + index * bar)).map((value) =>
      value === null || reference === null ? null : Math.abs(value - reference),
    );
    measured = reference === null || deviations.some((value) => value === null) ? null : Math.max(...deviations.map((value) => value ?? 0));
  }
  return judge({
    id,
    severity: "fail",
    unit: "dB",
    threshold: { op: "<=", value: LOUD_STEADY_DB, unit: "dB" },
    measured,
    ...(inAt === null || outAt === null || bar === null ? {} : { evidence: [{ from: inAt, to: outAt + 4 * bar, label: "loudness held" }] }),
  });
}

/** Trim events on either deck while both are audible. */
export function trimMovesInOverlap(context: CheckContext, span: CtxSpan = context.window) {
  return overlapSpans(context.attempt, span).flatMap((overlap) =>
    (["A", "B"] as const).flatMap((deck) => controlEvents(context.attempt.events, "trim", deck, overlap)),
  );
}

export function trimUntouched(id: CriterionId, context: CheckContext, span: CtxSpan = context.window): CriterionResult {
  const moves = trimMovesInOverlap(context, span);
  return judge({
    id,
    severity: "fail",
    unit: "count",
    threshold: { op: "<=", value: 0, unit: "count" },
    measured: moves.length,
    evidence: moves.map((move) => ({ from: move.ctx, to: move.ctx, label: `trim ${move.deck ?? ""}` })),
  });
}

/** The deck's LOW EQ in dB at `t`. */
export function lowDbAt(context: CheckContext, deck: DeckId, t: CtxTime): number {
  return controlValueAt(context.attempt.events, "eqLow", deck, t, context.attempt.initialMixer[deck].eqLowDb);
}

/** Maximal spans inside `span` where `predicate(dB)` holds for the deck's LOW EQ (exact, from events). */
export function lowSpans(context: CheckContext, deck: DeckId, span: CtxSpan, predicate: (db: number) => boolean): CtxSpan[] {
  const edges = [span.from, ...controlEvents(context.attempt.events, "eqLow", deck, span).map((move) => move.ctx).filter((t) => t > span.from), span.to];
  const spans: CtxSpan[] = [];
  edges.slice(0, -1).forEach((from, index) => {
    const to = edges[index + 1] ?? from;
    if (to <= from || !predicate(lowDbAt(context, deck, from))) return;
    const last = spans.at(-1);
    if (last !== undefined && Math.abs(last.to - from) < TIME_EPSILON) spans[spans.length - 1] = { from: last.from, to };
    else spans.push({ from, to });
  });
  return spans;
}

function intersect(first: readonly CtxSpan[], second: readonly CtxSpan[]): CtxSpan[] {
  return first.flatMap((a) =>
    second.flatMap((b) => {
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      return to > from ? [{ from, to }] : [];
    }),
  );
}

/** Both LOW EQs above this count as two basslines (check-design §2 `clash`). */
export const CLASH_LOW_DB = -6;

/**
 * `clash` over `overlap`: the time both decks are audible with both LOW EQs above −6 dB, as spans.
 * EQ moves are exact; audibility is on the 50 Hz meter clock.
 */
export function clashSpans(context: CheckContext, overlap: readonly CtxSpan[]): CtxSpan[] {
  const above = (db: number) => db > CLASH_LOW_DB;
  return overlap.flatMap((span) => intersect(lowSpans(context, "A", span, above), lowSpans(context, "B", span, above)));
}

export function spansSeconds(spans: readonly CtxSpan[]): number {
  return spans.reduce((total, span) => total + (span.to - span.from), 0);
}

/** `clash-short`: bass clash `≤ 1 beat` in total over the blend. */
export function clashShort(id: CriterionId, context: CheckContext, move: Handover): CriterionResult {
  const clash = clashSpans(context, overlapSpans(context.attempt, move.span));
  return judge({
    id,
    severity: "fail",
    unit: "beats",
    threshold: { op: "<=", value: 1, unit: "beats" },
    measured: move.bar === null ? null : spansSeconds(clash) / (move.bar / 4),
    evidence: clash.map((span) => ({ ...span, label: "two basslines" })),
  });
}

/** The first time at or after `from` the deck's LOW EQ crosses −6 dB upward (`up`) or downward. */
export function lowCrossing(context: CheckContext, deck: DeckId, from: CtxTime, up: boolean, span: CtxSpan): CtxTime | null {
  const moves = controlEvents(context.attempt.events, "eqLow", deck, { from, to: span.to });
  const crossing = moves.find((move) => {
    const before = lowDbAt(context, deck, move.ctx - TIME_EPSILON * 10);
    return up ? before <= CLASH_LOW_DB && move.value > CLASH_LOW_DB : before > CLASH_LOW_DB && move.value <= CLASH_LOW_DB;
  });
  return crossing?.ctx ?? null;
}

/**
 * `t_swap`: the mean of the incoming LOW's up-crossing of −6 dB (after `t_in`) and the outgoing
 * LOW's down-crossing of −6 dB (anywhere in the span).
 */
export function swapTime(context: CheckContext, move: Handover, outgoing: DeckId, incoming: DeckId): CtxTime | null {
  if (move.inAt === null) return null;
  const up = lowCrossing(context, incoming, move.inAt, true, move.span);
  const down = lowCrossing(context, outgoing, move.span.from, false, move.span);
  return up === null || down === null ? null : (up + down) / 2;
}

const DRIFT_HOLD_MS = 25;
const DRIFT_HOLD_FRACTION = 0.85;
const DRIFT_RUN_MS = 60;

/**
 * Blend phase rules (`blend-by-ear.phase-hold`, standing `drift`): `holdFrac(spans, 25 ms) ≥ 0.85`
 * ∧ `worstRun(spans, 60 ms) ≤ 1 bar`, bars of the master deck.
 */
export function blendPhaseHold(id: CriterionId, severity: Severity, context: CheckContext, spans: readonly CtxSpan[]): CriterionResult {
  const pair = phasePair(context);
  const first = spans[0];
  const bar = pair === null || first === undefined ? null : barSeconds(pair.master, first.from);
  const hold = pair === null || spans.length === 0 ? null : phaseHold(pair, spans, DRIFT_HOLD_MS, DRIFT_RUN_MS);
  const runBars = hold === null || bar === null ? null : hold.worstRunS / bar;
  return judgeAll(
    {
      id,
      severity,
      unit: "ratio",
      threshold: { op: ">=", value: DRIFT_HOLD_FRACTION, unit: "ratio" },
      measured: hold?.holdFraction ?? null,
      ...(runBars === null ? {} : { detail: { worstRunBars: runBars } }),
      evidence: hold?.worstRun == null ? [] : [{ ...hold.worstRun, label: "phase over 60 ms" }],
    },
    { id, severity, unit: "bars", threshold: { op: "<=", value: 1, unit: "bars" }, measured: runBars },
  );
}

/** `swap-time`: `|phraseOff(t_swap, outgoing)| ≤ 1 beat`. */
export function swapOnPhrase(id: CriterionId, context: CheckContext, move: Handover): CriterionResult {
  const at = swapTime(context, move, "A", "B");
  return judge({
    id,
    severity: "fail",
    unit: "beats",
    threshold: { op: "<=", value: 1, unit: "beats" },
    measured: phraseDistanceBeats(move, at),
    evidence: at === null ? [] : [{ from: at, to: at, label: "bass swap" }],
  });
}
