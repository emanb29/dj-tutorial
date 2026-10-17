// `runCheck(spec, attempt)`: the one grading path for Lessons, Placement, cold re-passes,
// warm-ups and bonus exercises. Pure and deterministic: no I/O, no clock.
import type { Attempt, LessonTask, TaskSpec } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt, VoidReason } from "@shared/check-result.ts";
import type { CheckContext, LessonCheck, OwnCriteria, TaskOf } from "./context.ts";
import { beatsAndBars } from "./lessons/beats-and-bars.ts";
import { cuePoint } from "./lessons/cue-point.ts";
import { cutOnPhrase } from "./lessons/cut-on-phrase.ts";
import { deckBasics } from "./lessons/deck-basics.ts";
import { gainStaging } from "./lessons/gain-staging.ts";
import { headphoneCue } from "./lessons/headphone-cue.ts";
import { phrases } from "./lessons/phrases.ts";
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
};

function lessonCheckFor<Id extends LessonTask["lessonId"]>(task: TaskOf<Id>): LessonCheck<TaskOf<Id>> {
  return LESSON_CHECKS[task.lessonId];
}

function runOwn(context: CheckContext, task: LessonTask): OwnCriteria {
  return lessonCheckFor(task).run(context, task);
}

function voidReason(spec: TaskSpec, attempt: Attempt): VoidReason | null {
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
  return untrusted ? "gridUntrusted" : null;
}

export function runCheck(spec: TaskSpec, attempt: Attempt): CheckResult | VoidAttempt {
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
  const criteria = [...own.criteria, ...standingCriteria(context, lessonCheckFor(spec.task).situations)];
  const failedCriteria = criteria
    .filter((criterion) => criterion.severity === "fail" && criterion.status === "notMet")
    .map((criterion) => criterion.id);

  return {
    ...identity,
    endReason: attempt.endReason,
    outcome: failedCriteria.length === 0 ? { kind: "passed" } : { kind: "failed", failedCriteria },
    criteria,
    tracks: spec.tracks.map(({ trackId, trackSetId, deck }) => ({ trackId, trackSetId, deck })),
    aids: spec.aids,
    metrics: own.metrics,
  };
}
