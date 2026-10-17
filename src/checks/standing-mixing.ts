// Standing criteria taught in Lessons 9–16 (check-design §3): controls-reset, sync-kept, one-bass,
// drift and overcorrect. Registered, with their teaching Lessons and severities, in standing.ts.
import type { CtxSpan, CtxTime, DeckId } from "@shared/attempt.ts";
import type { CriterionResult, Severity } from "@shared/check-result.ts";
import { blendPhaseHold, clashSpans, spansSeconds } from "./blend.ts";
import { barSeconds, loadedDeck, type CheckContext } from "./context.ts";
import { judge, notApplicable } from "./criterion.ts";
import { deckControlChanges, filterAt, isSyncedAt } from "./deck-controls.ts";
import { TIME_EPSILON } from "./measures.ts";
import { audibleSpans, overlapSpans } from "./mix.ts";
import { overcorrection } from "./overcorrect.ts";
import { EQ_BANDS } from "./lessons/eq-basics.ts";
import { CFX_CENTRE_BAND } from "./lessons/filter-transition.ts";
import { controlEvents, controlValueAt } from "./timeline.ts";

const DECKS: readonly DeckId[] = ["A", "B"];
const EQ_CENTRED_DB = 1;
/** A blend is an overlap of at least 4 bars (check-design §5.1); shorter overlaps are cuts or unclassified. */
const BLEND_MIN_BARS = 4;

/** Which parts of `controls-reset` apply: each is taught by its own Lesson. */
export interface ResetParts {
  readonly eq: boolean;
  readonly cfx: boolean;
}

/**
 * `controls-reset`: within 1 bar of a deck going silent (the end of each audible span before the
 * window ends), its EQs are within ±1 dB and its CFX within ±5% of centre. Measured: the slowest
 * reset, in bars. The FX part (`echo-out`) waits for Beat FX in the recorded attempt.
 */
export function controlsReset(context: CheckContext, severity: Severity, parts: ResetParts): CriterionResult {
  const { attempt, window } = context;
  const resets = DECKS.flatMap((deck) => {
    const loaded = loadedDeck(context, deck);
    if (loaded === null) return [];
    const centred = (t: CtxTime) =>
      (!parts.eq ||
        EQ_BANDS.every(
          ([control, field]) => Math.abs(controlValueAt(attempt.events, control, deck, t, attempt.initialMixer[deck][field])) <= EQ_CENTRED_DB,
        )) &&
      (!parts.cfx || Math.abs(filterAt(attempt, deck, t)) <= CFX_CENTRE_BAND);
    const knobMoves = (from: CtxTime) =>
      [
        ...EQ_BANDS.flatMap(([control]) => controlEvents(attempt.events, control, deck, { from, to: window.to })),
        ...deckControlChanges(attempt, "filter", deck).filter((move) => move.ctx > from && move.ctx < window.to),
      ]
        .map((move) => move.ctx)
        .sort((a, b) => a - b);
    return audibleSpans(attempt, deck, window)
      .filter((span) => span.to < window.to - TIME_EPSILON)
      .map((span) => {
        const silentAt = span.to;
        const resetAt = centred(silentAt) ? silentAt : (knobMoves(silentAt).find((t) => centred(t)) ?? null);
        return { deck, silentAt, resetAt, bar: barSeconds(loaded, silentAt) };
      });
  });
  if (resets.length === 0) return notApplicable("standing.controls-reset", severity, "bars", { op: "<=", value: 1, unit: "bars" });
  const slowest = resets.some((reset) => reset.resetAt === null)
    ? null
    : Math.max(...resets.map((reset) => ((reset.resetAt ?? reset.silentAt) - reset.silentAt) / reset.bar));
  return judge({
    id: "standing.controls-reset",
    severity,
    unit: "bars",
    threshold: { op: "<=", value: 1, unit: "bars" },
    measured: slowest,
    evidence: resets.map((reset) => ({ from: reset.silentAt, to: reset.resetAt ?? window.to, label: `deck ${reset.deck} reset` })),
  });
}

/**
 * `sync-kept`: no jog bend on a deck while its SYNC is on. A bend is counted once per turn (a
 * non-zero bend after a release). SYNC state comes from the attempt's initial deck state and the recorded SYNC
 * commands, including the engine dropping it.
 */
export function syncKept(context: CheckContext, severity: Severity): CriterionResult {
  const { attempt, window } = context;
  const bends = DECKS.flatMap((deck) =>
    deckControlChanges(attempt, "jogBend", deck)
      .filter((bend, index, all) => bend.value !== 0 && (all[index - 1]?.value ?? 0) === 0)
      .filter((bend) => bend.ctx >= window.from && bend.ctx < window.to && isSyncedAt(attempt, deck, bend.ctx))
      .map((bend) => ({ deck, ctx: bend.ctx })),
  );
  return judge({
    id: "standing.sync-kept",
    severity,
    unit: "count",
    threshold: { op: "<=", value: 0, unit: "count" },
    measured: bends.length,
    evidence: bends.map((bend) => ({ from: bend.ctx, to: bend.ctx, label: `jog bend on synced deck ${bend.deck}` })),
  });
}

/** Overlap spans of at least 4 bars: the blends. */
function blends(context: CheckContext): CtxSpan[] {
  const master = loadedDeck(context, "A");
  return overlapSpans(context.attempt, context.window).filter(
    (span) => master !== null && span.to - span.from >= BLEND_MIN_BARS * barSeconds(master, span.from) - TIME_EPSILON,
  );
}

/** `one-bass`: bass clash `≤ 1 beat` in every blend. Measured: the worst blend, in beats. */
export function oneBass(context: CheckContext, severity: Severity): CriterionResult {
  const master = loadedDeck(context, "A");
  const spans = blends(context);
  if (master === null || spans.length === 0) return notApplicable("standing.one-bass", severity, "beats", { op: "<=", value: 1, unit: "beats" });
  const perBlend = spans.map((span) => {
    const clash = clashSpans(context, [span]);
    return { clash, beats: spansSeconds(clash) / (barSeconds(master, span.from) / 4) };
  });
  return judge({
    id: "standing.one-bass",
    severity,
    unit: "beats",
    threshold: { op: "<=", value: 1, unit: "beats" },
    measured: Math.max(...perBlend.map((blend) => blend.beats)),
    evidence: perBlend.flatMap((blend) => blend.clash.map((span) => ({ ...span, label: "two basslines" }))),
  });
}

/** `drift`: `blend-by-ear`'s phase rules on every blend. Measured: the worst blend's hold fraction. */
export function drift(context: CheckContext, severity: Severity): CriterionResult {
  const spans = blends(context);
  if (spans.length === 0) return notApplicable("standing.drift", severity, "ratio", { op: ">=", value: 0.85, unit: "ratio" });
  const perBlend = spans.map((span) => blendPhaseHold("standing.drift", severity, context, [span]));
  const lowestMargin = perBlend.reduce((worst, blend) => ((blend.margin ?? Infinity) < (worst.margin ?? Infinity) ? blend : worst));
  return perBlend.find((blend) => blend.status === "notMet") ?? lowestMargin;
}

/** `overcorrect`: report only, no threshold. Measured: tempo-fader reversals; the largest bend in `detail`. */
export function overcorrect(context: CheckContext, severity: Severity): CriterionResult {
  const { tempoReversals, maxBendPercent } = overcorrection(context);
  return {
    id: "standing.overcorrect",
    severity,
    status: "met",
    measured: tempoReversals,
    unit: "count",
    threshold: null,
    margin: null,
    evidence: [],
    detail: { tempoReversals, maxBendPercent },
  };
}
