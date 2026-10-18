// The Lesson runtime: a pure state machine, hook → practice → Check → result → retry, in one
// continuous loop (Lesson format, ISS-55). The app feeds it what the Learner did (`Observation`s)
// and what the Check returned; it never touches audio, the clock or the network.
import type { BuiltLessonId } from "./catalogue.ts";
import type { CheckResult, CriterionId, VoidReason } from "@shared/check-result.ts";
import type { ReviewTrigger } from "@checks";
import { CUE_PLACEMENT_TOLERANCE_MS } from "@checks";
import { GAIN_ZONE_DB } from "./catalogue.ts";
import { FOCUS_HISTORY_MAX, type LineFacts } from "./coach.ts";
import type { HookTrigger, LessonDefinition, Observation, PracticeConfig } from "./types.ts";

export type LessonPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  /** `progress` counts towards the step's trigger; `named` is the concept the last step named. */
  | { readonly kind: "hook"; readonly step: number; readonly progress: number; readonly named: string | null }
  | {
      readonly kind: "practice";
      /** The most recent reps, oldest first, at most the practice window. */
      readonly reps: readonly boolean[];
      /** Consistent: "Ready? This one counts." */
      readonly ready: boolean;
      /** deck-basics: the fader is up and a fade out would finish a rep. */
      readonly fadeOpen: boolean;
      readonly named: string | null;
    }
  | { readonly kind: "check"; readonly attempt: number }
  | { readonly kind: "answering"; readonly answers: Readonly<Record<string, number>> }
  | { readonly kind: "grading"; readonly answers: Readonly<Record<string, number>> }
  | {
      readonly kind: "result";
      readonly result: CheckResult;
      readonly review: ReviewTrigger | null;
      readonly tip: string | null;
      /** The Lesson was passed for the first time: the next Lesson unlocks. */
      readonly firstPass: boolean;
      /** What the Coach line knows beyond the result (margin history, best before, retention). */
      readonly lineFacts: LineFacts;
    }
  /**
   * Not counted: a void attempt (check-design §6), one the app could not record, or a graded result the
   * Learner's profile refused to store (a bug, not the Learner's mix).
   */
  | { readonly kind: "void"; readonly reason: VoidReason | "recordingFailed" | "profileRefused"; readonly message: string | null };

export interface LessonState {
  readonly lessonId: BuiltLessonId;
  readonly phase: LessonPhase;
  /** Graded (non-void) Check attempts this session. */
  readonly attempts: number;
  /** Check attempts started this session, void ones included. */
  readonly started: number;
  /** Consecutive notMet results per criterion this session (coach-design §1 c). */
  readonly missStreaks: Readonly<Record<string, number | undefined>>;
  /** Criteria that already got their one tip this session. */
  readonly tipsShown: readonly CriterionId[];
  /** The last few margins per graded criterion this session, oldest first, for the Coach line. */
  readonly margins: Readonly<Partial<Record<string, readonly number[]>>>;
}

export type LessonEvent =
  | { readonly type: "track-ready" }
  | { readonly type: "track-failed"; readonly message: string }
  | { readonly type: "observed"; readonly observation: Observation }
  | { readonly type: "skip-hook" }
  | { readonly type: "start-check" }
  | { readonly type: "audio-ended" }
  | { readonly type: "answer"; readonly questionId: string; readonly value: number }
  /** The Check ran but the attempt does not count (check-design §6). */
  | { readonly type: "voided"; readonly reason: VoidReason }
  | {
      readonly type: "graded";
      readonly result: CheckResult;
      /** From `applyCheckResult`: criteria that just reached the Review threshold. */
      readonly reviewTriggers: readonly ReviewTrigger[];
      readonly firstPass: boolean;
      /** From `lineFacts`, computed with this state's `margins` (the history before this result). */
      readonly lineFacts: LineFacts;
    }
  | { readonly type: "grading-failed"; readonly message: string }
  /** Graded, but the Skill profile schema refused the update, so it was not stored. */
  | { readonly type: "profile-refused"; readonly message: string }
  /** The Check's audio part could not start recording: it would never end or grade. */
  | { readonly type: "check-failed"; readonly message: string }
  | { readonly type: "practice-again" }
  | { readonly type: "review-declined" };

/** A tip shows after this many misses in a row on one criterion. */
export const TIP_AFTER_MISSES = 2;
const FADER_UP = 0.9;
const FADER_DOWN = 0.05;
/** An EQ band at or below this is cut (the eq-basics Check's kill line), within this of 0 dB centred. */
export const EQ_CUT_DB = -20;
export const EQ_CENTRED_DB = 1;
/** The crossfader within this of an end is all the way to that side. */
const CROSSFADER_END = 0.05;
/** The CFX knob this far to a side is "turned" for a hook step; within the Check's ±5% it is centred. */
const FILTER_TURNED = 0.5;
export const FILTER_CENTRED = 0.05;
/** A filter-out rep is good as the filter-transition Check's: 70% high-pass or more, on for 8–16 bars ± 1 beat. */
export const FILTER_OUT_DEPTH = 0.7;
export const FILTER_OUT_BARS: readonly [number, number] = [8 - 0.25, 16 + 0.25];

export function initialLessonState(lessonId: BuiltLessonId): LessonState {
  return { lessonId, phase: { kind: "loading" }, attempts: 0, started: 0, missStreaks: {}, tipsShown: [], margins: {} };
}

function withMargins(margins: LessonState["margins"], result: CheckResult): LessonState["margins"] {
  const measured = result.criteria.flatMap((criterion) => (criterion.margin === null ? [] : [[criterion.id, criterion.margin] as const]));
  return { ...margins, ...Object.fromEntries(measured.map(([id, margin]) => [id, [...(margins[id] ?? []), margin].slice(-FOCUS_HISTORY_MAX)])) };
}

const inZone = (peakDb: number) => peakDb >= GAIN_ZONE_DB[0] && peakDb < GAIN_ZONE_DB[1];

/** Loop lengths a loop rep counts (bars), and how close to one it must be (an auto loop is exact; a hand-closed one is not). */
const LOOP_REP_BARS = [4, 8] as const;
const LOOP_REP_SLACK_BARS = 0.1;

/** How far an observation moves a hook trigger (or a Check's step): +1, no change (0), or start over ("reset"). */
export function triggerStep(trigger: HookTrigger, observation: Observation): 1 | 0 | "reset" {
  switch (trigger.kind) {
    case "play":
      return observation.kind === "play" && observation.deck === (trigger.deck ?? "A") && observation.playing ? 1 : 0;
    case "fader-up":
      return observation.kind === "fader" && observation.deck === (trigger.deck ?? "A") && observation.value >= FADER_UP ? 1 : 0;
    case "fader-down":
      return observation.kind === "fader" && observation.deck === (trigger.deck ?? "A") && observation.value <= FADER_DOWN ? 1 : 0;
    case "touch":
      return observation.kind === "touch" && observation.control === trigger.control ? 1 : 0;
    case "cue-on":
      return observation.kind === "headphone-cue" && observation.deck === trigger.deck && observation.on ? 1 : 0;
    case "in-zone":
      return observation.kind === "level" && observation.deck === trigger.deck && inZone(observation.peakDb) ? 1 : 0;
    case "cue-set":
      return observation.kind === "cue-set" ? 1 : 0;
    case "cue-preview":
      return observation.kind === "cue-preview" ? 1 : 0;
    case "cut":
      return observation.kind === "cut" ? 1 : 0;
    case "sync-on":
      return observation.kind === "sync" && observation.deck === trigger.deck && observation.on ? 1 : 0;
    case "eq-cut":
      return observation.kind === "eq" && observation.deck === trigger.deck && observation.band === trigger.band && observation.db <= EQ_CUT_DB ? 1 : 0;
    case "eq-centred":
      return observation.kind === "eq" && observation.deck === trigger.deck && observation.band === trigger.band && Math.abs(observation.db) <= EQ_CENTRED_DB ? 1 : 0;
    case "crossfader-to":
      if (observation.kind !== "crossfader") return 0;
      return (trigger.side === "A" ? observation.value <= CROSSFADER_END : observation.value >= 1 - CROSSFADER_END) ? 1 : 0;
    case "filter-to": {
      if (observation.kind !== "filter" || observation.deck !== trigger.deck) return 0;
      const { value } = observation;
      const there = trigger.side === "high-pass" ? value >= FILTER_TURNED : trigger.side === "low-pass" ? value <= -FILTER_TURNED : Math.abs(value) <= FILTER_CENTRED;
      return there ? 1 : 0;
    }
    case "swap":
      return observation.kind === "swap" ? 1 : 0;
    case "phase-held":
      return observation.kind === "phase-rep" && observation.held ? 1 : 0;
    case "tempo-guess":
      return observation.kind === "tempo-guess" ? 1 : 0;
    case "tempo-match":
      return observation.kind === "tempo-match" ? 1 : 0;
    case "blend-step":
      return observation.kind === "blend-step" && observation.good && observation.step === trigger.step ? 1 : 0;
    case "beat-taps":
      return observation.kind === "tap" && observation.onBeat ? 1 : 0;
    case "downbeat-taps":
      // Tapping every beat must not pass: a tap off the 1 starts the count over.
      if (observation.kind !== "tap") return 0;
      return observation.onDownbeat ? 1 : "reset";
    case "phrase-taps":
      return observation.kind === "tap" && observation.onPhraseStart ? 1 : 0;
    case "hot-cue-set":
      return observation.kind === "hot-cue-set" ? 1 : 0;
    case "hot-cue-trigger":
      return observation.kind === "hot-cue" ? 1 : 0;
    case "loop-in":
      return observation.kind === "loop-in" ? 1 : 0;
    case "loop-on":
      return observation.kind === "loop" ? 1 : 0;
    case "loop-exit":
      return observation.kind === "loop-exit" ? 1 : 0;
    case "beat-fx-on":
      return observation.kind === "beat-fx" && observation.on ? 1 : 0;
  }
}

const triggerCount = (trigger: HookTrigger): number => ("count" in trigger ? trigger.count : 1);

function practicePhase(named: string | null): LessonPhase {
  return { kind: "practice", reps: [], ready: false, fadeOpen: false, named };
}

function withRep(config: PracticeConfig, phase: Extract<LessonPhase, { kind: "practice" }>, good: boolean): LessonPhase {
  const reps = [...phase.reps, good].slice(-config.window);
  return { ...phase, reps, ready: reps.filter(Boolean).length >= config.needed };
}

function practise(config: PracticeConfig, phase: Extract<LessonPhase, { kind: "practice" }>, observation: Observation): LessonPhase {
  switch (config.rep) {
    case "fade":
      if (observation.kind !== "fader" || observation.deck !== "A") return phase;
      if (observation.value >= FADER_UP) return { ...phase, fadeOpen: true };
      if (observation.value <= FADER_DOWN && phase.fadeOpen) return withRep(config, { ...phase, fadeOpen: false }, true);
      return phase;
    case "beat-tap":
      return observation.kind === "tap" ? withRep(config, phase, observation.onBeat) : phase;
    case "phrase-tap":
      return observation.kind === "tap" ? withRep(config, phase, observation.onPhraseStart) : phase;
    case "ready":
      return observation.kind === "ready" ? withRep(config, phase, observation.inZone) : phase;
    case "cue-set":
      return observation.kind === "cue-set"
        ? withRep(config, phase, observation.onDownbeat && Math.abs(observation.offsetMs) <= CUE_PLACEMENT_TOLERANCE_MS)
        : phase;
    case "cut":
      return observation.kind === "cut" ? withRep(config, phase, observation.onPhrase) : phase;
    case "blend-start":
      return observation.kind === "cut" ? withRep(config, phase, observation.withinBeat) : phase;
    case "tempo-set":
      return observation.kind === "tempo-set" ? withRep(config, phase, observation.onTarget) : phase;
    case "eq-return":
      return observation.kind === "eq-return" ? withRep(config, phase, observation.onPhrase) : phase;
    case "swap":
      return observation.kind === "swap" ? withRep(config, phase, observation.onPhrase) : phase;
    case "filter-out": {
      if (observation.kind !== "filter-out") return phase;
      const [shortest, longest] = FILTER_OUT_BARS;
      const { bars } = observation;
      return withRep(config, phase, observation.depth >= FILTER_OUT_DEPTH && bars !== null && bars >= shortest && bars <= longest);
    }
    case "phase-hold":
      return observation.kind === "phase-rep" ? withRep(config, phase, observation.held) : phase;
    case "tempo-ear":
      if (observation.kind === "tempo-guess") return withRep(config, phase, observation.right);
      return observation.kind === "tempo-match" ? withRep(config, phase, observation.good) : phase;
    case "blend-step":
      // A missed step says why at once, where the last concept was named.
      if (observation.kind !== "blend-step") return phase;
      return withRep(config, observation.mistake === null ? phase : { ...phase, named: observation.mistake }, observation.good);
    case "hot-cue-trigger":
      return observation.kind === "hot-cue" ? withRep(config, phase, observation.onPhrase) : phase;
    case "loop":
      if (observation.kind !== "loop") return phase;
      return withRep(config, phase, observation.onDownbeat && LOOP_REP_BARS.some((bars) => Math.abs(observation.bars - bars) <= LOOP_REP_SLACK_BARS));
    case "echo-cut":
      return observation.kind === "echo-cut" ? withRep(config, phase, observation.onDownbeat && observation.echoOn) : phase;
  }
}

function hook(definition: LessonDefinition, phase: Extract<LessonPhase, { kind: "hook" }>, observation: Observation): LessonPhase {
  const step = definition.hook[phase.step];
  if (step === undefined) return practicePhase(phase.named);
  const moved = triggerStep(step.trigger, observation);
  if (moved === 0) return phase;
  if (moved === "reset") return { ...phase, progress: 0 };
  if (phase.progress + 1 < triggerCount(step.trigger)) return { ...phase, progress: phase.progress + 1 };
  const next = phase.step + 1;
  return next < definition.hook.length ? { kind: "hook", step: next, progress: 0, named: step.named } : practicePhase(step.named);
}

/** Updates miss streaks and picks at most one tip, never alongside a Review suggestion. */
function afterGrade(
  definition: LessonDefinition,
  state: LessonState,
  result: CheckResult,
  review: ReviewTrigger | null,
): { missStreaks: LessonState["missStreaks"]; tipsShown: readonly CriterionId[]; tip: string | null } {
  const graded = result.criteria.filter((criterion) => criterion.status !== "notApplicable" && criterion.severity === "fail");
  const missStreaks = {
    ...state.missStreaks,
    ...Object.fromEntries(graded.map((criterion) => [criterion.id, criterion.status === "notMet" ? (state.missStreaks[criterion.id] ?? 0) + 1 : 0])),
  };
  if (review !== null) return { missStreaks, tipsShown: state.tipsShown, tip: null };
  const due = graded.find(
    (criterion) =>
      (missStreaks[criterion.id] ?? 0) >= TIP_AFTER_MISSES && !state.tipsShown.includes(criterion.id) && (definition.tips[criterion.id]?.length ?? 0) > 0,
  );
  if (due === undefined) return { missStreaks, tipsShown: state.tipsShown, tip: null };
  const tips = definition.tips[due.id] ?? [];
  return { missStreaks, tipsShown: [...state.tipsShown, due.id], tip: tips[state.tipsShown.length % tips.length] ?? null };
}

export function lessonReducer(definition: LessonDefinition): (state: LessonState, event: LessonEvent) => LessonState {
  return (state, event) => {
    const { phase } = state;
    switch (event.type) {
      case "track-ready":
        return phase.kind === "loading" ? { ...state, phase: { kind: "hook", step: 0, progress: 0, named: null } } : state;
      case "track-failed":
        return { ...state, phase: { kind: "unavailable", message: event.message } };
      case "observed": {
        // Most observations change nothing (level readings arrive twice a second): keep the same state.
        const next =
          phase.kind === "hook" ? hook(definition, phase, event.observation) : phase.kind === "practice" ? practise(definition.practice, phase, event.observation) : phase;
        return next === phase ? state : { ...state, phase: next };
      }
      case "skip-hook":
        return phase.kind === "hook" ? { ...state, phase: practicePhase(phase.named) } : state;
      case "start-check":
        if (phase.kind === "loading" || phase.kind === "unavailable" || phase.kind === "grading" || phase.kind === "answering") return state;
        return { ...state, started: state.started + 1, phase: { kind: "check", attempt: state.started + 1 } };
      case "audio-ended":
        if (phase.kind !== "check") return state;
        return { ...state, phase: definition.questions.length > 0 ? { kind: "answering", answers: {} } : { kind: "grading", answers: {} } };
      case "answer": {
        if (phase.kind !== "answering") return state;
        const answers = { ...phase.answers, [event.questionId]: event.value };
        const done = Object.keys(answers).length >= definition.questions.length;
        return { ...state, phase: done ? { kind: "grading", answers } : { kind: "answering", answers } };
      }
      case "voided":
        return phase.kind === "grading" ? { ...state, phase: { kind: "void", reason: event.reason, message: null } } : state;
      case "graded": {
        if (phase.kind !== "grading") return state;
        const { result } = event;
        const review = event.reviewTriggers[0] ?? null;
        const { tip, ...memory } = afterGrade(definition, state, result, review);
        return {
          ...state,
          ...memory,
          margins: withMargins(state.margins, result),
          attempts: state.attempts + 1,
          phase: { kind: "result", result, review, tip, firstPass: event.firstPass, lineFacts: event.lineFacts },
        };
      }
      case "grading-failed":
        return phase.kind === "grading" ? { ...state, phase: { kind: "void", reason: "recordingFailed", message: event.message } } : state;
      case "profile-refused":
        return phase.kind === "grading" ? { ...state, phase: { kind: "void", reason: "profileRefused", message: event.message } } : state;
      case "check-failed":
        return phase.kind === "check" ? { ...state, phase: { kind: "void", reason: "recordingFailed", message: event.message } } : state;
      case "practice-again":
        return phase.kind === "result" || phase.kind === "void" || phase.kind === "check" ? { ...state, phase: practicePhase(null) } : state;
      case "review-declined":
        return phase.kind === "result" ? { ...state, phase: { ...phase, review: null } } : state;
    }
  };
}
