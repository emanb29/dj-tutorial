// `runCheck(spec, attempt)`: the one grading path for Lessons, Placement, cold re-passes,
// warm-ups and bonus exercises. Pure and deterministic: no I/O, no clock.
import type { Aids, CtxSpan, LessonId, LessonTask, TaskSpec } from "@shared/attempt.ts";
import { STANDING_IDS, type CheckOutcome, type CheckResult, type CriterionId, type VoidAttempt, type VoidReason } from "@shared/check-result.ts";
import type { CheckContext, LessonCheck, OwnCriteria, TaskOf } from "./context.ts";
import { gradeDegraded } from "./degraded.ts";
import type { GradedAttempt } from "./deck-controls.ts";
import { bassSwap } from "./lessons/bass-swap.ts";
import { beatsAndBars } from "./lessons/beats-and-bars.ts";
import { blendByEar } from "./lessons/blend-by-ear.ts";
import { crossfader } from "./lessons/crossfader.ts";
import { cuePoint } from "./lessons/cue-point.ts";
import { cutOnPhrase } from "./lessons/cut-on-phrase.ts";
import { deckBasics } from "./lessons/deck-basics.ts";
import { echoOut } from "./lessons/echo-out.ts";
import { eqBasics } from "./lessons/eq-basics.ts";
import { filterTransition } from "./lessons/filter-transition.ts";
import { finalMix } from "./lessons/final-mix.ts";
import { gainStaging } from "./lessons/gain-staging.ts";
import { headphoneCue } from "./lessons/headphone-cue.ts";
import { hotCues } from "./lessons/hot-cues.ts";
import { loopTransition } from "./lessons/loop-transition.ts";
import { nudgePhase } from "./lessons/nudge-phase.ts";
import { phrases } from "./lessons/phrases.ts";
import { syncBlend } from "./lessons/sync-blend.ts";
import { tempoByEar } from "./lessons/tempo-by-ear.ts";
import { tempoFader } from "./lessons/tempo-fader.ts";
import { failingStandingIds, standingCriteria } from "./standing.ts";

/** `grid-trust`: a grid fit with an RMS residual over this cannot be graded. */
export const MAX_GRID_RESIDUAL_MS = 15;

const LESSON_CHECKS: { readonly [Id in LessonTask["lessonId"]]: LessonCheck<TaskOf<Id>> } = {
  "deck-basics": deckBasics,
  "beats-and-bars": beatsAndBars,
  phrases,
  "gain-staging": gainStaging,
  "headphone-cue": headphoneCue,
  "cue-point": cuePoint,
  "cut-on-phrase": cutOnPhrase,
  "tempo-fader": tempoFader,
  "sync-blend": syncBlend,
  crossfader,
  "eq-basics": eqBasics,
  "bass-swap": bassSwap,
  "filter-transition": filterTransition,
  "nudge-phase": nudgePhase,
  "tempo-by-ear": tempoByEar,
  "blend-by-ear": blendByEar,
  "hot-cues": hotCues,
  "loop-transition": loopTransition,
  "echo-out": echoOut,
  "final-mix": finalMix,
};

/**
 * Aids that must be off for a Check to mean anything (catalogue §1 Sync column, Q5): sync is locked
 * off from `nudge-phase`, and the BPM display and phase meter are hidden from `tempo-by-ear` on.
 * Every mode records them in `spec.aids`, and the result carries them.
 */
export const LOCKED_OFF_AIDS: Readonly<Partial<Record<LessonId, readonly (keyof Aids)[]>>> = {
  "nudge-phase": ["sync"],
  "tempo-by-ear": ["sync", "bpmDisplay", "phaseMeter"],
  "blend-by-ear": ["sync", "bpmDisplay", "phaseMeter"],
  // Exam conditions (catalogue §1, check-design §5.1): no sync or quantize, display covered, no Lesson text.
  "final-mix": ["sync", "quantize", "bpmDisplay", "phaseMeter", "lessonText"],
};

function lessonCheckFor<Id extends LessonTask["lessonId"]>(task: TaskOf<Id>): LessonCheck<TaskOf<Id>> {
  return LESSON_CHECKS[task.lessonId];
}

function runOwn(context: CheckContext, task: LessonTask): OwnCriteria {
  const check = lessonCheckFor(task);
  const own = check.run(context, task);
  const declared = new Set([...check.criteria, ...(context.spec.mode === "placement" ? (check.placementCriteria ?? []) : [])]);
  const undeclared = own.criteria.map((criterion) => criterion.id).filter((id) => !declared.has(id));
  if (undeclared.length > 0) {
    throw new RangeError(`${task.lessonId} graded ${undeclared.join(", ")}, which its LessonCheck does not declare; add them to its criteria (and a label in criterion-labels.ts)`);
  }
  return own;
}

/**
 * Every criterion that can fail a Lesson's Check, before it runs, in order: the Lesson's own, then the
 * standing ones it grades for these passed Lessons. Announced to the Learner as "Graded: …".
 */
export function gradedCriteria(lessonId: LessonTask["lessonId"], options: { readonly passedLessons: readonly LessonId[]; readonly aids: Aids }): CriterionId[] {
  const check: LessonCheck = LESSON_CHECKS[lessonId] as LessonCheck;
  return [...check.criteria, ...failingStandingIds({ lessonId, passedLessons: options.passedLessons, sync: options.aids.sync }, check.situations)];
}

/** Every criterion any Check can grade, in any mode: each Lesson's own, then every standing one. */
export function gradableCriteria(): CriterionId[] {
  const checks: readonly LessonCheck[] = Object.values(LESSON_CHECKS) as readonly LessonCheck[];
  const own = checks.flatMap((check) => [...check.criteria, ...(check.placementCriteria ?? [])]);
  return [...new Set([...own, ...STANDING_IDS.map((id) => `standing.${id}` as const)])];
}

/** The heard spans a task grades in, by name. The Lesson content finds them in the attempt's playhead. */
function taskSections(task: LessonTask, window: CtxSpan): (readonly [string, CtxSpan])[] {
  switch (task.lessonId) {
    // Graded from a heard moment on to the end: a start the deck never reached voids the attempt.
    case "nudge-phase":
      return [["phaseFrom", { from: task.phaseFrom, to: window.to }]];
    case "tempo-by-ear":
      return [["matchFrom", { from: task.matchFrom, to: window.to }]];
    case "beats-and-bars":
      return [["beatSection", task.beatSection], ["downbeatSection", task.downbeatSection]];
    case "phrases":
    case "headphone-cue":
      return [["tapSection", task.tapSection]];
    case "crossfader":
      return task.cutSection === null ? [["blendSection", task.blendSection]] : [["blendSection", task.blendSection], ["cutSection", task.cutSection.span]];
    default:
      return [];
  }
}

/** JSON keeps no Infinity: a bound the deck never reached reads null. */
const finiteOrNull = (ctx: number): number | null => (Number.isFinite(ctx) ? ctx : null);

/** A section the deck never reached, or never got to the end of, has no finite, non-empty span. */
function isHeard(section: CtxSpan): boolean {
  return Number.isFinite(section.from) && Number.isFinite(section.to) && section.from < section.to;
}

interface Void {
  readonly reason: VoidReason;
  readonly diagnostics?: Readonly<Record<string, number | string | null>>;
}

function voidOf(spec: TaskSpec, attempt: GradedAttempt): Void | null {
  const reason = voidReason(spec, attempt);
  if (reason === null) return null;
  if (reason !== "sectionNotHeard") return { reason };
  const [name, span] = taskSections(spec.task, spec.window).find(([, section]) => !isHeard(section)) ?? ["?", { from: Number.NaN, to: Number.NaN }];
  return {
    reason,
    diagnostics: { section: name, from: finiteOrNull(span.from), to: finiteOrNull(span.to), windowFrom: spec.window.from, windowTo: spec.window.to },
  };
}

function voidReason(spec: TaskSpec, attempt: GradedAttempt): VoidReason | null {
  if (attempt.abandoned) return "abandoned";
  const interruption = attempt.interruptions.find(
    (candidate) => candidate.ctx >= spec.window.from && candidate.ctx < spec.window.to,
  );
  if (interruption !== undefined) return interruption.kind;
  // A missing grid, or a residual that is not a number, cannot be trusted either.
  const untrusted = spec.tracks.some((track) => {
    const residual = attempt.grids[track.trackId]?.rmsResidualMs;
    return residual === undefined || !(residual <= MAX_GRID_RESIDUAL_MS);
  });
  if (untrusted) return "gridUntrusted";
  return taskSections(spec.task, spec.window).every(([, section]) => isHeard(section)) ? null : "sectionNotHeard";
}

/** An aid left on where the Lesson locks it off would grade a different skill: a content bug. */
function assertAidsLockedOff(spec: TaskSpec): void {
  const onAnyway = (LOCKED_OFF_AIDS[spec.task.lessonId] ?? []).filter((aid) => spec.aids[aid]);
  if (onAnyway.length > 0) {
    throw new RangeError(
      `${spec.task.lessonId} must be graded with ${onAnyway.join(", ")} off, but its task spec has them on; fix the Lesson content's aids`,
    );
  }
}

/** Grades a contract `Attempt`, or the recorder's `RecordedAttempt` (engine events, `degraded`). */
export function runCheck(spec: TaskSpec, attempt: GradedAttempt): CheckResult | VoidAttempt {
  assertAidsLockedOff(spec);
  const identity = {
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    learnerId: attempt.learnerId,
    lessonId: spec.task.lessonId,
    mode: spec.mode,
    variant: spec.variant,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    inputDevice: attempt.inputDevice,
  } as const;

  const voided = voidOf(spec, attempt);
  if (voided !== null) {
    const outcome = { kind: "void", reason: voided.reason } as const;
    return voided.diagnostics === undefined ? { ...identity, outcome } : { ...identity, outcome, diagnostics: voided.diagnostics };
  }

  const context: CheckContext = { spec, attempt, window: spec.window, lessonId: spec.task.lessonId };
  const own = runOwn(context, spec.task);
  if (own.criteria.length === 0) {
    // A task that grades nothing would pass by default: that is a Lesson content bug.
    throw new RangeError(`${spec.task.lessonId} task has no criteria to grade; check its Lesson content (e.g. gain-staging decks)`);
  }
  const measured = [...own.criteria, ...standingCriteria(context, lessonCheckFor(spec.task).situations)];
  // Degraded recordings: see degraded.ts for why this grades with a warning instead of voiding.
  const degraded = attempt.degraded === true ? gradeDegraded(measured, attempt, spec.window) : null;
  const criteria = degraded?.criteria ?? measured;
  const failedCriteria = criteria
    .filter((criterion) => criterion.severity === "fail" && criterion.status === "notMet")
    .map((criterion) => criterion.id);
  const passed = failedCriteria.length === 0 && degraded?.blocksPass !== true;
  // final-mix: the LCME bands of a passed set (check-design §5.3).
  const outcome: CheckOutcome = passed
    ? own.bands === undefined
      ? { kind: "passed" }
      : { kind: "passed", bands: own.bands(criteria) }
    : { kind: "failed", failedCriteria };

  return {
    ...identity,
    endReason: attempt.endReason,
    outcome,
    criteria,
    tracks: spec.tracks.map(({ trackId, trackSetId, deck }) => ({ trackId, trackSetId, deck })),
    aids: spec.aids,
    metrics: degraded === null ? own.metrics : { ...own.metrics, recordingDegraded: 1 },
  };
}
