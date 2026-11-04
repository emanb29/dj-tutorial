// Blend measures shared by sync-blend, crossfader, bass-swap and blend-by-ear (check-design §2, §4).
import type { ControlEvent, CtxSpan, CtxTime, DeckId } from "@shared/attempt.ts";
import type { CriterionId, CriterionResult, Severity } from "@shared/check-result.ts";
import { barSeconds, loadedDeck, type CheckContext, type LoadedDeck } from "./context.ts";
import { judge, judgeAll } from "./criterion.ts";
import { phaseHold, phasePair } from "./phase.ts";
import { energyMeanDb, TIME_EPSILON } from "./measures.ts";
import { entryActionTime, entryTime, exitTime, framesIn, overlapSpans } from "./mix.ts";
import { phraseOffsetBeats } from "./phrasing.ts";
import { controlEvents, controlValueAt } from "./timeline.ts";

/** One transition: `outgoing` hands the master over to `incoming` inside `span`. */
export interface Handover {
  readonly outgoing: LoadedDeck | null;
  readonly incoming: LoadedDeck | null;
  /** `t_in` of the incoming deck (first audible frame): for durations and windows. */
  readonly inAt: CtxTime | null;
  /** `t_out` of the outgoing deck (first frame not audible): for durations and windows. */
  readonly outAt: CtxTime | null;
  /** When the Learner started bringing the incoming deck in (first movement of the fader move): for the blend start only. */
  readonly inActionAt: CtxTime | null;
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
    inActionAt: entryActionTime(context.attempt, incoming, span, "firstMove"),
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

/**
 * `blend-start`: `|phraseOff(t_in, outgoing)| ≤ 1 beat`, a point action, so timed from the start of
 * the fader move that brought the deck in (input leeway).
 */
export function blendStart(id: CriterionId, move: Handover): CriterionResult {
  const at = move.inActionAt;
  return judge({
    id,
    severity: "fail",
    unit: "beats",
    threshold: { op: "<=", value: 1, unit: "beats" },
    measured: phraseDistanceBeats(move, at),
    evidence: at === null ? [] : [{ from: at, to: at, label: "B in" }],
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
/** Meter frames arrive at 50 Hz. */
const METER_FRAME_S = 0.02;

/**
 * `loud-steady`: the largest `|barLoud − ref|` over the bars of `[t_in, t_out + 4 bars]`, with `ref`
 * the mean `barLoud` of the 4 bars before `t_in`. Bars are counted from `t_in`. The span stops at
 * the attempt's end (Done or timeout may come within 4 bars of `t_out`); a bar inside the attempt
 * with under half its meter frames is a recording gap and leaves the criterion unmeasured.
 */
export function loudSteady(id: CriterionId, context: CheckContext, move: Handover): CriterionResult {
  const { inAt, outAt, bar } = move;
  const end = inAt === null || outAt === null || bar === null ? null : Math.min(outAt + 4 * bar, context.window.to);
  let measured: number | null = null;
  if (inAt !== null && end !== null && bar !== null) {
    const barLoud = (from: CtxTime, to: CtxTime) => {
      const frames = framesIn(context.attempt.meters.master, { from, to });
      return frames.length < (to - from) / METER_FRAME_S / 2 ? null : energyMeanDb(frames.map((frame) => frame.momentaryLufs));
    };
    const before = [1, 2, 3, 4]
      .map((index) => barLoud(inAt - index * bar, inAt - (index - 1) * bar))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const reference = before.length === 0 ? null : before.reduce((sum, value) => sum + value, 0) / before.length;
    const bars = Math.ceil((end - inAt) / bar - TIME_EPSILON);
    const deviations = Array.from({ length: bars }, (_, index) =>
      barLoud(inAt + index * bar, Math.min(end, inAt + (index + 1) * bar)),
    ).map((value) => (value === null || reference === null ? null : Math.abs(value - reference)));
    measured = reference === null || deviations.some((value) => value === null) ? null : Math.max(...deviations.map((value) => value ?? 0));
  }
  return judge({
    id,
    severity: "fail",
    unit: "dB",
    threshold: { op: "<=", value: LOUD_STEADY_DB, unit: "dB" },
    measured,
    ...(inAt === null || end === null ? {} : { evidence: [{ from: inAt, to: end, label: "loudness held" }] }),
  });
}

/** A blend is an overlap of at least 4 bars (check-design §5.1); shorter overlaps are cuts or unclassified. */
export const BLEND_MIN_BARS = 4;
/** Overlap spans this close together are one blend: a deck dropping under the audible line for a moment does not end it. */
const BLEND_GAP_BARS = 1;

/**
 * The blends in the window: the overlap spans, those less than a bar apart joined into one (a
 * breakdown's silent beat, a fader dipped, a filter that thins a deck out), kept when at least 4 bars
 * long, in bars of the master deck.
 */
export function blendSpans(context: CheckContext): CtxSpan[] {
  const master = loadedDeck(context, "A");
  if (master === null) return [];
  const joined = overlapSpans(context.attempt, context.window).reduce<CtxSpan[]>((spans, span) => {
    const last = spans.at(-1);
    if (last !== undefined && span.from - last.to < BLEND_GAP_BARS * barSeconds(master, last.to)) spans[spans.length - 1] = { from: last.from, to: span.to };
    else spans.push(span);
    return spans;
  }, []);
  return joined.filter((span) => span.to - span.from >= BLEND_MIN_BARS * barSeconds(master, span.from) - TIME_EPSILON);
}

/**
 * TRIM messages closer together than this are one turn of the knob. A hardware knob sends a message
 * per detent (the FLX4: dozens for one turn), and a turn re-gripped halfway pauses for a moment.
 */
export const TRIM_TURN_GAP_S = 0.5;

/** One turn of a deck's TRIM: its messages, and the trim before and after it, dB. */
export interface TrimTurn {
  readonly deck: DeckId;
  readonly moves: readonly ControlEvent[];
  /** Its first and last message. */
  readonly from: CtxTime;
  readonly to: CtxTime;
  readonly startDb: number;
  readonly endDb: number;
}

/** The deck's trim just before `t` (the last move strictly before it), dB. */
function trimBefore(context: CheckContext, deck: DeckId, t: CtxTime): number {
  const earlier = context.attempt.events.filter((event) => event.control === "trim" && event.deck === deck && event.ctx < t - TIME_EPSILON);
  return earlier.at(-1)?.value ?? context.attempt.initialMixer[deck].trimDb;
}

/** The TRIM turns made while both decks are audible, deck A's first, each in time order. */
export function trimTurnsInOverlap(context: CheckContext, span: CtxSpan = context.window): TrimTurn[] {
  const overlaps = overlapSpans(context.attempt, span);
  return (["A", "B"] as const).flatMap((deck) => {
    const moves = overlaps.flatMap((overlap) => controlEvents(context.attempt.events, "trim", deck, overlap));
    const groups = moves.reduce<ControlEvent[][]>((turns, move) => {
      const last = turns.at(-1);
      const lastAt = last?.at(-1)?.ctx;
      if (last !== undefined && lastAt !== undefined && move.ctx - lastAt < TRIM_TURN_GAP_S) last.push(move);
      else turns.push([move]);
      return turns;
    }, []);
    return groups.flatMap((group) => {
      const first = group[0];
      const last = group.at(-1);
      if (first === undefined || last === undefined) return [];
      return [{ deck, moves: group, from: first.ctx, to: last.ctx, startDb: trimBefore(context, deck, first.ctx), endDb: last.value }];
    });
  });
}

/** sync-blend's TRIM rule: no turn while both decks are heard (the faders do the blend). Counted in turns, not messages. */
export function trimUntouched(id: CriterionId, context: CheckContext, span: CtxSpan = context.window): CriterionResult {
  const turns = trimTurnsInOverlap(context, span);
  return judge({
    id,
    severity: "fail",
    unit: "count",
    threshold: { op: "<=", value: 0, unit: "count" },
    measured: turns.length,
    evidence: turns.map((turn) => ({ from: turn.from, to: turn.to, label: `trim ${turn.deck}` })),
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
/** Every time in `span` the deck's LOW EQ crosses −6 dB upward (`up`) or downward. */
export function lowCrossings(context: CheckContext, deck: DeckId, up: boolean, span: CtxSpan): CtxTime[] {
  return controlEvents(context.attempt.events, "eqLow", deck, span)
    .filter((move) => {
      const before = lowDbAt(context, deck, move.ctx - TIME_EPSILON * 10);
      return up ? before <= CLASH_LOW_DB && move.value > CLASH_LOW_DB : before > CLASH_LOW_DB && move.value <= CLASH_LOW_DB;
    })
    .map((move) => move.ctx);
}

/** How far outside the overlap the outgoing LOW's cut may sit and still pair with the swap. */
const SWAP_PAIR_BARS = 2;

/**
 * `t_swap`: the mean of the incoming LOW's first up-crossing of −6 dB after `t_in` and the outgoing
 * LOW's down-crossing nearest it, within the overlap ± 2 bars (so an unrelated EQ move on the
 * outgoing deck earlier in the attempt is never paired with the swap).
 */
export function swapTime(context: CheckContext, move: Handover, outgoing: DeckId, incoming: DeckId): CtxTime | null {
  const { inAt, bar } = move;
  if (inAt === null || bar === null) return null;
  const up = lowCrossings(context, incoming, true, { from: inAt, to: move.span.to })[0];
  if (up === undefined) return null;
  const overlap = overlapSpans(context.attempt, move.span);
  const first = overlap[0];
  const last = overlap.at(-1);
  if (first === undefined || last === undefined) return null;
  const pairing = { from: Math.max(move.span.from, first.from - SWAP_PAIR_BARS * bar), to: Math.min(move.span.to, last.to + SWAP_PAIR_BARS * bar) };
  const down = lowCrossings(context, outgoing, false, pairing).reduce<CtxTime | null>(
    (nearest, t) => (nearest === null || Math.abs(t - up) < Math.abs(nearest - up) ? t : nearest),
    null,
  );
  return down === null ? null : (up + down) / 2;
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
