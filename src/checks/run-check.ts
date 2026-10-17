// `runCheck(spec, attempt)`: the one grading path for Lessons, Placement, cold re-passes,
// warm-ups and bonus exercises. Pure and deterministic: no I/O, no clock.
import type { Aids, CtxSpan, LessonId, LessonTask, TaskSpec } from "@shared/attempt.ts";
import type { CheckOutcome, CheckResult, VoidAttempt, VoidReason } from "@shared/check-result.ts";
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
import { eqBasics } from "./lessons/eq-basics.ts";
import { filterTransition } from "./lessons/filter-transition.ts";
import { gainStaging } from "./lessons/gain-staging.ts";
import { headphoneCue } from "./lessons/headphone-cue.ts";
import { nudgePhase } from "./lessons/nudge-phase.ts";
import { phrases } from "./lessons/phrases.ts";
import { syncBlend } from "./lessons/sync-blend.ts";
import { tempoByEar } from "./lessons/tempo-by-ear.ts";
import { tempoFader } from "./lessons/tempo-fader.ts";
import { standingCriteria } from "./standing.ts";

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
};

function lessonCheckFor<Id extends LessonTask["lessonId"]>(task: TaskOf<Id>): LessonCheck<TaskOf<Id>> {
  return LESSON_CHECKS[task.lessonId];
}

function runOwn(context: CheckContext, task: LessonTask): OwnCriteria {
  return lessonCheckFor(task).run(context, task);
}

/** The heard spans a task grades in. The Lesson content finds them in the attempt's playhead. */
function taskSections(task: LessonTask, window: CtxSpan): CtxSpan[] {
  switch (task.lessonId) {
    // Graded from a heard moment on to the end: a start the deck never reached voids the attempt.
    case "nudge-phase":
      return [{ from: task.phaseFrom, to: window.to }];
    case "tempo-by-ear":
      return [{ from: task.matchFrom, to: window.to }];
    case "beats-and-bars":
      return [task.beatSection, task.downbeatSection];
    case "phrases":
    case "headphone-cue":
      return [task.tapSection];
    case "crossfader":
      return task.cutSection === null ? [task.blendSection] : [task.blendSection, task.cutSection.span];
    default:
      return [];
  }
}

/** A section the deck never reached, or never got to the end of, has no finite, non-empty span. */
function isHeard(section: CtxSpan): boolean {
  return Number.isFinite(section.from) && Number.isFinite(section.to) && section.from < section.to;
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
  return taskSections(spec.task, spec.window).every(isHeard) ? null : "sectionNotHeard";
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

  const reason = voidReason(spec, attempt);
  if (reason !== null) return { ...identity, outcome: { kind: "void", reason } };

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
  const outcome: CheckOutcome =
    failedCriteria.length === 0 && degraded?.blocksPass !== true ? { kind: "passed" } : { kind: "failed", failedCriteria };

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
