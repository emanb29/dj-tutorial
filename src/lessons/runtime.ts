// The Lesson runtime: a pure state machine, hook → practice → Check → result → retry, in one
// continuous loop (Lesson format, ISS-55). The app feeds it what the Learner did (`Observation`s)
// and what the Check returned; it never touches audio, the clock or the network.
import type { BuiltLessonId } from "./catalogue.ts";
import type { CheckResult, CriterionId, VoidAttempt, VoidReason } from "@shared/check-result.ts";
import type { ReviewTrigger } from "@checks";
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
  /** Not counted: a void attempt (check-design §6), or one the app could not record. */
  | { readonly kind: "void"; readonly reason: VoidReason | "recordingFailed"; readonly message: string | null };

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
  | {
      readonly type: "graded";
      readonly outcome: CheckResult | VoidAttempt;
      /** From `applyCheckResult`: criteria that just reached the Review threshold. */
      readonly reviewTriggers: readonly ReviewTrigger[];
      readonly firstPass: boolean;
      /** From `lineFacts`, computed with this state's `margins` (the history before this result). */
      readonly lineFacts: LineFacts;
    }
  | { readonly type: "grading-failed"; readonly message: string }
  /** The Check's audio part could not start recording: it would never end or grade. */
  | { readonly type: "check-failed"; readonly message: string }
  | { readonly type: "practice-again" }
  | { readonly type: "review-declined" };

/** A tip shows after this many misses in a row on one criterion. */
export const TIP_AFTER_MISSES = 2;
const FADER_UP = 0.9;
const FADER_DOWN = 0.05;

export function initialLessonState(lessonId: BuiltLessonId): LessonState {
  return { lessonId, phase: { kind: "loading" }, attempts: 0, started: 0, missStreaks: {}, tipsShown: [], margins: {} };
}

function withMargins(margins: LessonState["margins"], result: CheckResult): LessonState["margins"] {
  const measured = result.criteria.flatMap((criterion) => (criterion.margin === null ? [] : [[criterion.id, criterion.margin] as const]));
  return { ...margins, ...Object.fromEntries(measured.map(([id, margin]) => [id, [...(margins[id] ?? []), margin].slice(-FOCUS_HISTORY_MAX)])) };
}

/** How far an observation moves a hook trigger: +1, no change (0), or start over ("reset"). */
function triggerStep(trigger: HookTrigger, observation: Observation): 1 | 0 | "reset" {
  switch (trigger.kind) {
    case "play":
      return observation.kind === "play" && observation.playing ? 1 : 0;
    case "fader-up":
      return observation.kind === "fader" && observation.value >= FADER_UP ? 1 : 0;
    case "fader-down":
      return observation.kind === "fader" && observation.value <= FADER_DOWN ? 1 : 0;
    case "beat-taps":
      return observation.kind === "tap" && observation.onBeat ? 1 : 0;
    case "downbeat-taps":
      // Tapping every beat must not pass: a tap off the 1 starts the count over.
      if (observation.kind !== "tap") return 0;
      return observation.onDownbeat ? 1 : "reset";
    case "phrase-taps":
      return observation.kind === "tap" && observation.onPhraseStart ? 1 : 0;
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
      if (observation.kind !== "fader") return phase;
      if (observation.value >= FADER_UP) return { ...phase, fadeOpen: true };
      if (observation.value <= FADER_DOWN && phase.fadeOpen) return withRep(config, { ...phase, fadeOpen: false }, true);
      return phase;
    case "beat-tap":
      return observation.kind === "tap" ? withRep(config, phase, observation.onBeat) : phase;
    case "phrase-tap":
      return observation.kind === "tap" ? withRep(config, phase, observation.onPhraseStart) : phase;
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
      case "observed":
        if (phase.kind === "hook") return { ...state, phase: hook(definition, phase, event.observation) };
        if (phase.kind === "practice") return { ...state, phase: practise(definition.practice, phase, event.observation) };
        return state;
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
      case "graded": {
        if (phase.kind !== "grading") return state;
        const { outcome } = event;
        if (outcome.outcome.kind === "void") return { ...state, phase: { kind: "void", reason: outcome.outcome.reason, message: null } };
        const result = outcome as CheckResult;
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
      case "check-failed":
        return phase.kind === "check" ? { ...state, phase: { kind: "void", reason: "recordingFailed", message: event.message } } : state;
      case "practice-again":
        return phase.kind === "result" || phase.kind === "void" || phase.kind === "check" ? { ...state, phase: practicePhase(null) } : state;
      case "review-declined":
        return phase.kind === "result" ? { ...state, phase: { ...phase, review: null } } : state;
    }
  };
}
