// Standing criteria (check-design §3): once their teaching Lesson is passed, every later Check
// measures them, when its task contains their situation.
import type { ControlId, CtxSpan, CtxTime, DeckId, LessonId, MeterFrame } from "@shared/attempt.ts";
import type { CriterionId, CriterionResult, Severity, StandingId } from "@shared/check-result.ts";
import { barSeconds, framesWhere, loadedDeck, type CheckContext, type Situations } from "./context.ts";
import { judge, notApplicable } from "./criterion.ts";
import { TIME_EPSILON } from "./measures.ts";
import { cueOnSeconds, entryActionTime, entryTime, exitTime, frameAt, framesIn, isAudible, MAX_FRAME_AGE_S, overlapSpans } from "./mix.ts";
import { phraseOffsetBeats, phraseOffsetBeatsOf } from "./phrasing.ts";
import { CUED_BEFORE_S } from "./lessons/cut-on-phrase.ts";
import { CLIP_DBFS } from "./lessons/deck-basics.ts";
import { EQ_BANDS } from "./lessons/eq-basics.ts";
import { controlsReset, drift, oneBass, overcorrect, syncKept } from "./standing-mixing.ts";
import { loopedPhraseOffsetBeats } from "./performance.ts";
import { controlEvents, controlValueAt, firstPlayStart, isPlaying, playingFrom, positionPlayedOn } from "./timeline.ts";
import { filterAt } from "./deck-controls.ts";

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
  readonly situation: "transition" | "any" | "syncAvailable";
  /** In a set, measured on each transition's view and reported as the worst; otherwise on the whole attempt. */
  readonly perTransition?: true;
  readonly measure: (context: CheckContext, severity: Severity, passed: ReadonlySet<LessonId>) => CriterionResult;
}

/** no-clip's grace: judging starts at the Learner's first move on a meter, or this long after the audio starts. */
const NO_CLIP_GRACE_BARS = 1;
/** A bar when no deck has a grid, as at 120 BPM. */
const FALLBACK_BAR_S = 2;
/**
 * Lessons whose set-up starts in the red on purpose (gain-staging: deck A hot). A meter is judged only
 * once the Learner has moved a control and brought it out of the red: the Lesson's own criteria grade
 * the clip they were handed.
 */
const STARTS_IN_THE_RED: ReadonlySet<LessonId> = new Set(["gain-staging"]);
/** Controls that change what a channel meter (pre-fader) reads, or whether the channel reaches the master. */
const CHANNEL_LEVEL_CONTROLS: readonly ControlId[] = ["trim", "eqHigh", "eqMid", "eqLow", "filter", "channelFader"];
const MASTER_LEVEL_CONTROLS: readonly ControlId[] = [...CHANNEL_LEVEL_CONTROLS, "crossfader"];

/** When the Check's audio starts: the first time at or after `window.from` that any deck plays; null if none does. */
function audioStart(context: CheckContext): CtxTime | null {
  const { attempt, window } = context;
  const starts = DECKS.flatMap((deck) => {
    const playhead = attempt.decks[deck]?.playhead;
    if (playhead === undefined) return [];
    const start = isPlaying(playhead, window.from) ? window.from : firstPlayStart(playhead, window.from);
    return start === null || start >= window.to ? [] : [start];
  });
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * When no-clip starts judging a meter (the master, or one deck's channel): the set-up's own level is not
 * the Learner's doing. From their first move on it (that channel's level controls; any channel's, or the
 * crossfader, for the master), or a bar after the audio starts, whichever is earlier; strict from then
 * on. In a Lesson that starts in the red on purpose, from the first frame out of the red after their
 * first move instead. Null: never.
 */
export function noClipJudgedFrom(context: CheckContext, deck?: DeckId): CtxTime | null {
  const { attempt, window } = context;
  const controls = deck === undefined ? MASTER_LEVEL_CONTROLS : CHANNEL_LEVEL_CONTROLS;
  const firstMove = attempt.events.find(
    (event) =>
      event.byEngine !== true &&
      controls.includes(event.control) &&
      (deck === undefined || event.deck === deck) &&
      event.ctx >= window.from - TIME_EPSILON &&
      event.ctx < window.to,
  )?.ctx;
  if (STARTS_IN_THE_RED.has(context.lessonId)) {
    if (firstMove === undefined) return null;
    const frames = deck === undefined ? attempt.meters.master : attempt.meters[deck];
    return framesIn(frames, { from: firstMove, to: window.to }).find((frame) => frame.samplePeakDb <= CLIP_DBFS)?.ctx ?? null;
  }
  const start = audioStart(context);
  if (start === null) return firstMove ?? null;
  const loaded = loadedDeck(context, OUTGOING) ?? loadedDeck(context, INCOMING);
  const graceEnd = start + NO_CLIP_GRACE_BARS * (loaded === null ? FALLBACK_BAR_S : barSeconds(loaded, start));
  return Math.min(firstMove ?? Number.POSITIVE_INFINITY, graceEnd);
}

function noClip(context: CheckContext, severity: Severity): CriterionResult {
  const { attempt, window } = context;
  const meters = [undefined, ...DECKS].map((deck) => {
    const from = noClipJudgedFrom(context, deck);
    const span: CtxSpan = { from: from === null ? window.to : Math.max(window.from, from), to: window.to };
    const frames = deck === undefined ? attempt.meters.master : attempt.meters[deck];
    const counts = (frame: MeterFrame) => deck === undefined || isAudible(attempt, deck, frame.ctx);
    return {
      peaks: framesIn(frames, span).filter(counts).map((frame) => frame.samplePeakDb),
      evidence: framesWhere(frames, span, (frame) => frame.samplePeakDb > CLIP_DBFS && counts(frame), deck === undefined ? "master clip" : `deck ${deck} clip`),
    };
  });
  const peaks = meters.flatMap((meter) => meter.peaks);
  return judge({
    id: "standing.no-clip",
    severity,
    unit: "dBFS",
    threshold: { op: "<=", value: CLIP_DBFS, unit: "dBFS" },
    measured: peaks.length === 0 ? null : peaks.reduce((highest, peak) => Math.max(highest, peak), -Infinity),
    evidence: meters.flatMap((meter) => meter.evidence),
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

/** A point action, timed on intent from the start of the move that brought B in (as `blend-start`). */
function onPhrase(context: CheckContext, severity: Severity): CriterionResult {
  const inAt = entryActionTime(context.attempt, INCOMING, context.window, "firstMove");
  const master = loadedDeck(context, OUTGOING);
  const incoming = loadedDeck(context, INCOMING);
  // The master may be looping (loop-transition): its loop's start and end are one moment. Stopped (an
  // echo out, then A paused), it is read where it would be had it kept playing, as echo-entry reads it.
  const masterBeats = (() => {
    if (inAt === null || master === null) return null;
    if (isPlaying(master.playhead, inAt)) return loopedPhraseOffsetBeats(context.attempt, master, inAt);
    const playedOn = positionPlayedOn(master.playhead, inAt);
    return playedOn === null ? null : phraseOffsetBeatsOf(master, playedOn);
  })();
  // A Play is timed from its press, before the deck's audio starts: read the deck where it starts.
  const incomingBeats = inAt === null || incoming === null ? null : phraseOffsetBeats(incoming, playingFrom(incoming.playhead, inAt));
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

/** Within these of centre a channel plays its track as the trim set it (the channel meter reads after EQ and CFX). */
const FLAT_EQ_DB = 1;
const FLAT_CFX = 0.05;
/**
 * A tone move is heard at its event time but reaches the channel meter an output latency (and the
 * engine's lookahead) later: a Bluetooth output's few hundred ms, with room.
 */
const TONE_SETTLE_S = 0.5;

function flatAt(attempt: CheckContext["attempt"], deck: DeckId, t: CtxTime): boolean {
  return (
    EQ_BANDS.every(([control, field]) => Math.abs(controlValueAt(attempt.events, control, deck, t, attempt.initialMixer[deck][field])) <= FLAT_EQ_DB) &&
    Math.abs(filterAt(attempt, deck, t)) <= FLAT_CFX
  );
}

/** Maximal stretches of `span` in which the deck's EQs and CFX are all at centre. */
function flatStretches(attempt: CheckContext["attempt"], deck: DeckId, span: CtxSpan): CtxSpan[] {
  const moves = [
    ...EQ_BANDS.flatMap(([control]) => controlEvents(attempt.events, control, deck, span).map((event) => event.ctx)),
    ...controlEvents(attempt.events, "filter", deck, span).map((event) => event.ctx),
  ].filter((t) => t > span.from);
  const edges = [span.from, ...new Set(moves.toSorted((a, b) => a - b)), span.to];
  const stretches: CtxSpan[] = [];
  edges.slice(0, -1).forEach((from, index) => {
    const to = edges[index + 1] ?? from;
    if (to <= from || !flatAt(attempt, deck, from)) return;
    const last = stretches.at(-1);
    if (last !== undefined && Math.abs(last.to - from) < TIME_EPSILON) stretches[stretches.length - 1] = { from: last.from, to };
    else stretches.push({ from, to });
  });
  return stretches;
}

/**
 * At the handover, the two tracks' levels as their trims set them (mistake 2), from the channel
 * meters' short-term loudness. The channel meter reads after the EQ and CFX, and a transition moves
 * them on purpose (A high-passed or its LOW cut on the way out, B in with its LOW cut), so: A's
 * level just before its last stretch with every EQ and CFX centred ended (at the latest as it
 * leaves), and B's once its 3 s window is full after its entry with them centred (at the earliest
 * 3 s after it comes in). A deck never centred is read as it leaves or 3 s in.
 */
function levelMatch(context: CheckContext, severity: Severity): CriterionResult {
  const { attempt, window } = context;
  const inAt = entryTime(attempt, INCOMING, window);
  const outAt = exitTime(attempt, OUTGOING, window) ?? inAt;
  const outgoingAt = outAt === null ? null : (flatStretches(attempt, OUTGOING, { from: window.from, to: outAt }).at(-1)?.to ?? outAt);
  const incomingAt = (() => {
    if (inAt === null) return null;
    const earliest = inAt + SHORT_TERM_S;
    const full = flatStretches(attempt, INCOMING, window)
      .map((stretch) => ({ stretch, at: Math.max(earliest, stretch.from + SHORT_TERM_S + TONE_SETTLE_S) }))
      .find(({ stretch, at }) => at <= stretch.to && at < window.to);
    return full?.at ?? Math.min(earliest, window.to - TIME_EPSILON);
  })();
  const outgoing = outgoingAt === null ? null : frameAt(attempt.meters[OUTGOING], outgoingAt - TIME_EPSILON - 0.02);
  const incoming = incomingAt === null ? null : frameAt(attempt.meters[INCOMING], incomingAt);
  return judge({
    id: "standing.level-match",
    severity,
    unit: "dB",
    threshold: { op: "<=", value: LEVEL_MATCH_DB, unit: "dB" },
    measured: outgoing === null || incoming === null ? null : Math.abs(outgoing.shortTermLufs - incoming.shortTermLufs),
    ...(outgoingAt === null || incomingAt === null ? {} : { evidence: [{ from: outgoingAt, to: incomingAt, label: "levels compared" }] }),
  });
}

/** CUE time up to the action that brought B in, as `cut-on-phrase.cued-before`, so the two agree. */
function cuedFirst(context: CheckContext, severity: Severity): CriterionResult {
  const inAt = entryActionTime(context.attempt, INCOMING, context.window);
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
 * Implemented standing criteria, in check-design §3 order. Deferred: key-clash (`final-mix` warns in
 * the set builder instead, check-design §5.5) and technique-mix (`final-mix` reports the counts in
 * its metrics).
 */
const DEFINITIONS: readonly StandingDefinition[] = [
  { id: "no-clip", from: ["gain-staging"], situation: "any", measure: noClip },
  { id: "no-dead-air", from: ["cut-on-phrase"], situation: "transition", measure: noDeadAir },
  { id: "on-phrase", perTransition: true, from: ["cut-on-phrase"], situation: "transition", measure: onPhrase },
  { id: "level-match", perTransition: true, from: ["cut-on-phrase"], situation: "transition", measure: levelMatch },
  { id: "cued-first", perTransition: true, from: ["cut-on-phrase"], situation: "transition", measure: cuedFirst },
  { id: "trim-still", perTransition: true, from: ["sync-blend"], situation: "transition", measure: trimStill },
  { id: "no-boost", from: ["eq-basics"], situation: "any", measure: noBoost },
  {
    id: "controls-reset",
    perTransition: true,
    // Each Lesson teaches its own part: EQ from eq-basics, CFX from filter-transition, FX from echo-out.
    from: ["eq-basics", "filter-transition", "echo-out"],
    situation: "transition",
    measure: (context, severity, passed) =>
      controlsReset(context, severity, { eq: passed.has("eq-basics"), cfx: passed.has("filter-transition"), fx: passed.has("echo-out") }),
  },
  // "Warn (sync Checks only)": only where the task offers sync; n/a in final-mix (severity table).
  { id: "sync-kept", from: ["sync-blend"], situation: "syncAvailable", measure: syncKept },
  { id: "no-recue", perTransition: true, from: ["nudge-phase"], situation: "transition", measure: noRecue },
  { id: "one-bass", perTransition: true, from: ["blend-by-ear"], situation: "transition", measure: oneBass },
  { id: "drift", perTransition: true, from: ["blend-by-ear"], situation: "transition", measure: drift },
  { id: "overcorrect", from: ["tempo-by-ear"], situation: "any", measure: overcorrect },
];

interface StandingScope {
  readonly lessonId: LessonId;
  readonly passedLessons: readonly LessonId[];
  /** Whether the task offers sync. */
  readonly sync: boolean;
}

/** The standing criteria a task grades, each with its severity there. */
function applicable(scope: StandingScope, situations: Situations): { readonly definition: StandingDefinition; readonly severity: Severity }[] {
  const passed: ReadonlySet<LessonId> = new Set(scope.passedLessons);
  const present = (situation: StandingDefinition["situation"]) => situation === "any" || (situation === "syncAvailable" ? scope.sync : situations[situation]);
  return DEFINITIONS.flatMap((definition) => {
    const severity = standingSeverity(definition.id, scope.lessonId);
    const applies = severity !== null && definition.from.some((lesson) => passed.has(lesson)) && present(definition.situation);
    return applies ? [{ definition, severity }] : [];
  });
}

export function standingCriteria(context: CheckContext, situations: Situations): CriterionResult[] {
  const passed: ReadonlySet<LessonId> = new Set(context.spec.passedLessons);
  const scope = { lessonId: context.lessonId, passedLessons: context.spec.passedLessons, sync: context.spec.aids.sync };
  const views = situations.transitionViews?.(context) ?? null;
  return applicable(scope, situations).map(({ definition, severity }) =>
    views === null || definition.perTransition !== true
      ? definition.measure(context, severity, passed)
      : worstOf(definition, severity, views.map((view, index) => labelled(definition.measure(view, severity, passed), index + 1))),
  );
}

/** The standing criteria that can fail a task (severity `fail`), before it is run. */
export function failingStandingIds(scope: StandingScope, situations: Situations): CriterionId[] {
  return applicable(scope, situations).filter(({ severity }) => severity === "fail").map(({ definition }) => `standing.${definition.id}` as const);
}

/** One transition's results, by standing id (the set's per-transition report reads them). */
export function transitionStanding(view: CheckContext): CriterionResult[] {
  return standingCriteria(view, { transition: true }).filter((result) =>
    DEFINITIONS.some((definition) => definition.perTransition === true && `standing.${definition.id}` === result.id),
  );
}

/** A transition's result, its evidence labelled with the transition's number (its decks are relabelled). */
function labelled(result: CriterionResult, transition: number): CriterionResult {
  return { ...result, evidence: result.evidence.map((item) => ({ ...item, label: `transition ${String(transition)}: ${item.label}` })) };
}

/**
 * One criterion over every transition of a set: the worst one (a not-met one first, then the lowest
 * margin; an unmeasured one is the worst of all), with every transition's evidence. Not applicable
 * when no transition contains its situation.
 */
function worstOf(definition: StandingDefinition, severity: Severity, results: readonly CriterionResult[]): CriterionResult {
  const graded = results.filter((result) => result.status !== "notApplicable");
  const rank = (result: CriterionResult) => [result.status === "met" ? 1 : 0, result.margin ?? Number.NEGATIVE_INFINITY] as const;
  const worst = graded.reduce<CriterionResult | null>((found, result) => {
    if (found === null) return result;
    const [foundMet, foundMargin] = rank(found);
    const [met, margin] = rank(result);
    return met < foundMet || (met === foundMet && margin < foundMargin) ? result : found;
  }, null);
  if (worst === null) return results[0] ?? notApplicable(`standing.${definition.id}`, severity, "count", null);
  return { ...worst, evidence: graded.flatMap((result) => result.evidence), detail: { ...worst.detail, transitions: graded.length } };
}
