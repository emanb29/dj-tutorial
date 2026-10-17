// Standing criteria (check-design §3): once their teaching Lesson is passed, every later Check
// measures them, when its task contains their situation.
import type { ControlId, CtxSpan, DeckId, LessonId } from "@shared/attempt.ts";
import type { CriterionResult, Severity, StandingId } from "@shared/check-result.ts";
import { barSeconds, framesWhere, loadedDeck, type CheckContext, type Situations } from "./context.ts";
import { judge } from "./criterion.ts";
import { TIME_EPSILON } from "./measures.ts";
import { cueOnSeconds, entryTime, exitTime, frameAt, framesIn, isAudible, MAX_FRAME_AGE_S, overlapSpans } from "./mix.ts";
import { phraseOffsetBeats } from "./phrasing.ts";
import { CUED_BEFORE_S } from "./lessons/cut-on-phrase.ts";
import { CLIP_DBFS } from "./lessons/deck-basics.ts";
import { EQ_BANDS } from "./lessons/eq-basics.ts";
import { controlsReset, drift, oneBass, overcorrect, syncKept } from "./standing-mixing.ts";
import { controlEvents, controlValueAt } from "./timeline.ts";

/** Severity before `final-mix` and in it; `null` where the criterion does not apply. */
const SEVERITY: Readonly<Record<StandingId, readonly [Severity | null, Severity | null]>> = {
  "no-clip": ["fail", "fail"],
  "no-dead-air": ["fail", "fail"],
  "on-phrase": ["fail", "fail"],
  "level-match": ["warn", "fail"],
  "cued-first": ["warn", "warn"],
  "trim-still": ["warn", "warn"],
  "no-boost": ["warn", "warn"],
  "controls-reset": ["warn", "warn"],
  "sync-kept": ["warn", null],
  "no-recue": ["warn", "warn"],
  "one-bass": ["warn", "warn"],
  drift: [null, "fail"],
  overcorrect: ["report", "report"],
  "key-clash": [null, "warn"],
  "technique-mix": [null, "report"],
};

export function standingSeverity(id: StandingId, lessonId: LessonId): Severity | null {
  return SEVERITY[id][lessonId === "final-mix" ? 1 : 0];
}

const DEAD_AIR_LUFS = -45;
const DEAD_AIR_S = 1;
const LEVEL_MATCH_DB = 2;
const BOOST_DB = 3;
/** Short-term loudness needs this long to fill its window. */
const SHORT_TERM_S = 3;
const INCOMING: DeckId = "B";
const OUTGOING: DeckId = "A";
const DECKS: readonly DeckId[] = ["A", "B"];

interface StandingDefinition {
  readonly id: StandingId;
  /** Applies once any of these Lessons is passed. */
  readonly from: readonly LessonId[];
  /** `syncAvailable`: the task offers SYNC (`spec.aids.sync`). */
  readonly situation: keyof Situations | "any" | "syncAvailable";
  readonly measure: (context: CheckContext, severity: Severity, passed: ReadonlySet<LessonId>) => CriterionResult;
}

function noClip(context: CheckContext, severity: Severity): CriterionResult {
  const { attempt, window } = context;
  const clips = (frames: Parameters<typeof framesWhere>[0], deck?: DeckId) =>
    framesWhere(frames, window, (frame) => frame.samplePeakDb > CLIP_DBFS && (deck === undefined || isAudible(attempt, deck, frame.ctx)), deck === undefined ? "master clip" : `deck ${deck} clip`);
  const peaks = [
    ...framesIn(attempt.meters.master, window),
    ...DECKS.flatMap((deck) => framesIn(attempt.meters[deck], window).filter((frame) => isAudible(attempt, deck, frame.ctx))),
  ].map((frame) => frame.samplePeakDb);
  return judge({
    id: "standing.no-clip",
    severity,
    unit: "dBFS",
    threshold: { op: "<=", value: CLIP_DBFS, unit: "dBFS" },
    measured: peaks.length === 0 ? null : peaks.reduce((highest, peak) => Math.max(highest, peak), -Infinity),
    evidence: [clips(attempt.meters.master), ...DECKS.map((deck) => clips(attempt.meters[deck], deck))].flat(),
  });
}

function noDeadAir(context: CheckContext, severity: Severity): CriterionResult {
  const frames = framesIn(context.attempt.meters.master, context.window);
  const firstAudio = frames.findIndex((frame) => frame.momentaryLufs >= DEAD_AIR_LUFS);
  const gaps: CtxSpan[] = [];
  let openedAt: number | null = null;
  for (const frame of firstAudio < 0 ? [] : frames.slice(firstAudio)) {
    if (frame.momentaryLufs < DEAD_AIR_LUFS) openedAt ??= frame.ctx;
    else if (openedAt !== null) {
      gaps.push({ from: openedAt, to: frame.ctx });
      openedAt = null;
    }
  }
  const lastFrame = frames.at(-1);
  if (openedAt !== null) gaps.push({ from: openedAt, to: context.window.to });
  else if (lastFrame !== undefined && context.window.to - lastFrame.ctx > MAX_FRAME_AGE_S) {
    // The meter stream stopped early: nothing shows the master was playing.
    gaps.push({ from: lastFrame.ctx, to: context.window.to });
  }
  // No audio at all is not "no dead air": there is nothing to grade.
  const longest = firstAudio < 0 ? null : gaps.reduce((most, gap) => Math.max(most, gap.to - gap.from), 0);
  return judge({
    id: "standing.no-dead-air",
    severity,
    unit: "s",
    threshold: { op: "<", value: DEAD_AIR_S, unit: "s" },
    measured: longest,
    evidence: gaps.filter((gap) => gap.to - gap.from >= DEAD_AIR_S - TIME_EPSILON).map((gap) => ({ ...gap, label: "dead air" })),
  });
}

function onPhrase(context: CheckContext, severity: Severity): CriterionResult {
  const inAt = entryTime(context.attempt, INCOMING, context.window);
  const master = loadedDeck(context, OUTGOING);
  const incoming = loadedDeck(context, INCOMING);
  const masterBeats = inAt === null || master === null ? null : phraseOffsetBeats(master, inAt);
  const incomingBeats = inAt === null || incoming === null ? null : phraseOffsetBeats(incoming, inAt);
  const measured = masterBeats === null || incomingBeats === null ? null : Math.max(Math.abs(masterBeats), Math.abs(incomingBeats));
  return judge({
    id: "standing.on-phrase",
    severity,
    unit: "beats",
    threshold: { op: "<=", value: 1, unit: "beats" },
    measured,
    ...(masterBeats === null || incomingBeats === null ? {} : { detail: { masterBeats, incomingBeats } }),
    evidence: inAt === null ? [] : [{ from: inAt, to: inAt, label: "B in" }],
  });
}

/** At the handover: A's short-term loudness as it leaves vs B's once its 3 s window is full. */
function levelMatch(context: CheckContext, severity: Severity): CriterionResult {
  const { attempt, window } = context;
  const inAt = entryTime(attempt, INCOMING, window);
  const outAt = exitTime(attempt, OUTGOING, window) ?? inAt;
  const outgoing = outAt === null ? null : frameAt(attempt.meters[OUTGOING], outAt - TIME_EPSILON - 0.02);
  const incoming = inAt === null ? null : frameAt(attempt.meters[INCOMING], Math.min(inAt + SHORT_TERM_S, window.to - TIME_EPSILON));
  return judge({
    id: "standing.level-match",
    severity,
    unit: "dB",
    threshold: { op: "<=", value: LEVEL_MATCH_DB, unit: "dB" },
    measured: outgoing === null || incoming === null ? null : Math.abs(outgoing.shortTermLufs - incoming.shortTermLufs),
  });
}

function cuedFirst(context: CheckContext, severity: Severity): CriterionResult {
  const inAt = entryTime(context.attempt, INCOMING, context.window);
  return judge({
    id: "standing.cued-first",
    severity,
    unit: "s",
    threshold: { op: ">=", value: CUED_BEFORE_S, unit: "s" },
    measured: inAt === null ? null : cueOnSeconds(context.attempt, INCOMING, { from: context.window.from, to: inAt }),
  });
}

function eventsInOverlap(context: CheckContext, control: ControlId, decks: readonly DeckId[], value?: number) {
  return overlapSpans(context.attempt, context.window).flatMap((span) =>
    decks.flatMap((deck) => controlEvents(context.attempt.events, control, deck, span)).filter((event) => value === undefined || event.value === value),
  );
}

function trimStill(context: CheckContext, severity: Severity): CriterionResult {
  const moves = eventsInOverlap(context, "trim", DECKS);
  return judge({
    id: "standing.trim-still",
    severity,
    unit: "count",
    threshold: { op: "<=", value: 0, unit: "count" },
    measured: moves.length,
    scale: 1,
    evidence: moves.map((move) => ({ from: move.ctx, to: move.ctx, label: `trim ${move.deck ?? ""}` })),
  });
}

function noRecue(context: CheckContext, severity: Severity): CriterionResult {
  const presses = eventsInOverlap(context, "deckCue", [INCOMING], 1);
  return judge({
    id: "standing.no-recue",
    severity,
    unit: "count",
    threshold: { op: "<=", value: 1, unit: "count" },
    measured: presses.length,
    evidence: presses.map((press) => ({ from: press.ctx, to: press.ctx, label: "CUE B" })),
  });
}


/** Longest stretch, in bars, that any EQ band sits above +3 dB. */
function noBoost(context: CheckContext, severity: Severity): CriterionResult {
  const { attempt, window } = context;
  const boosts = DECKS.flatMap((deck) =>
    EQ_BANDS.flatMap(([control, field]) => {
      const initial = attempt.initialMixer[deck][field];
      const edges = [window.from, ...controlEvents(attempt.events, control, deck, window).map((event) => event.ctx), window.to];
      const spans: CtxSpan[] = [];
      edges.slice(0, -1).forEach((from, index) => {
        const to = edges[index + 1] ?? from;
        if (controlValueAt(attempt.events, control, deck, from, initial) <= BOOST_DB) return;
        const last = spans.at(-1);
        if (last !== undefined && Math.abs(last.to - from) < TIME_EPSILON) spans[spans.length - 1] = { from: last.from, to };
        else spans.push({ from, to });
      });
      const loaded = loadedDeck(context, deck) ?? loadedDeck(context, OUTGOING);
      return spans.map((span) => ({ span, deck, bars: loaded === null ? null : (span.to - span.from) / barSeconds(loaded, span.from) }));
    }),
  );
  return judge({
    id: "standing.no-boost",
    severity,
    unit: "bars",
    threshold: { op: "<=", value: 1, unit: "bars" },
    // A boost on a deck without a grid cannot be measured in bars.
    measured: boosts.reduce<number | null>((most, boost) => (most === null || boost.bars === null ? null : Math.max(most, boost.bars)), 0),
    evidence: boosts.map(({ span, deck }) => ({ ...span, label: `EQ boost ${deck}` })),
  });
}

/**
 * Implemented standing criteria, in check-design §3 order. Deferred until their Lessons' Checks
 * exist: key-clash and technique-mix (`final-mix`), and the FX part of controls-reset (`echo-out`).
 */
const DEFINITIONS: readonly StandingDefinition[] = [
  { id: "no-clip", from: ["gain-staging"], situation: "any", measure: noClip },
  { id: "no-dead-air", from: ["cut-on-phrase"], situation: "transition", measure: noDeadAir },
  { id: "on-phrase", from: ["cut-on-phrase"], situation: "transition", measure: onPhrase },
  { id: "level-match", from: ["cut-on-phrase"], situation: "transition", measure: levelMatch },
  { id: "cued-first", from: ["cut-on-phrase"], situation: "transition", measure: cuedFirst },
  { id: "trim-still", from: ["sync-blend"], situation: "transition", measure: trimStill },
  { id: "no-boost", from: ["eq-basics"], situation: "any", measure: noBoost },
  {
    id: "controls-reset",
    // Each Lesson teaches its own part: EQ from eq-basics, CFX from filter-transition.
    from: ["eq-basics", "filter-transition"],
    situation: "transition",
    measure: (context, severity, passed) =>
      controlsReset(context, severity, { eq: passed.has("eq-basics"), cfx: passed.has("filter-transition") }),
  },
  // "Warn (sync Checks only)": only where the task offers sync; n/a in final-mix (severity table).
  { id: "sync-kept", from: ["sync-blend"], situation: "syncAvailable", measure: syncKept },
  { id: "no-recue", from: ["nudge-phase"], situation: "transition", measure: noRecue },
  { id: "one-bass", from: ["blend-by-ear"], situation: "transition", measure: oneBass },
  { id: "drift", from: ["blend-by-ear"], situation: "transition", measure: drift },
  { id: "overcorrect", from: ["tempo-by-ear"], situation: "any", measure: overcorrect },
];

export function standingCriteria(context: CheckContext, situations: Situations): CriterionResult[] {
  const passed: ReadonlySet<LessonId> = new Set(context.spec.passedLessons);
  const present = (situation: StandingDefinition["situation"]) =>
    situation === "any" || (situation === "syncAvailable" ? context.spec.aids.sync : situations[situation]);
  return DEFINITIONS.flatMap((definition) => {
    const severity = standingSeverity(definition.id, context.lessonId);
    const applies = severity !== null && definition.from.some((lesson) => passed.has(lesson)) && present(definition.situation);
    return applies ? [definition.measure(context, severity, passed)] : [];
  });
}
