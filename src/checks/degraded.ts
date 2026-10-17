// Grading a degraded attempt (src/audio RecordedAttempt.degraded): the recorder ran out of room and
// left out continuous moves (faders, knobs, tempo, jog) or meter frames past its budget.
//
// Decision: grade with a warning, never void and never fail on lost data.
// - The drop point is estimated conservatively (earliest it could be): the last continuous move the
//   recorder kept, or where the meter frames stop before the attempt ends, whichever is earlier.
// - Criteria that read only data the recorder never drops (taps, button presses, cue points,
//   answers, playhead models) are graded as usual.
// - "No violation" criteria (no clip, no trim move, no boost, …) cannot be met when the data after
//   the drop is missing: met becomes `notApplicable`. Not met stays not met when the violation was
//   recorded before the drop (it really happened), and becomes `notApplicable` otherwise.
// - Other continuous measures: met stays met (what was kept showed the skill); not met becomes
//   `notApplicable`.
// - Ungraded criteria carry `detail.recordingDegraded = 1` (and `keptMeasured`), are not written to
//   the Skill profile and do not count toward a Review. If one is fail-severity, the attempt cannot
//   pass either: the outcome is `failed` with no failed criteria (a void needs a VoidReason the app
//   shows, and the attempt did measure everything else).
import type { CtxSpan, CtxTime } from "@shared/attempt.ts";
import type { CriterionId, CriterionResult } from "@shared/check-result.ts";
import type { GradedAttempt } from "./deck-commands.ts";
import { MAX_FRAME_AGE_S } from "./mix.ts";

/** Criteria computed only from data the recorder always keeps. Every other criterion reads continuous data. */
const DISCRETE_ONLY: ReadonlySet<CriterionId> = new Set<CriterionId>([
  "beats-and-bars.beat-taps",
  "beats-and-bars.downbeat-taps",
  "phrases.phrase-taps",
  "phrases.name-sections",
  "headphone-cue.cued-taps",
  "cue-point.cue-on-downbeat",
  "tempo-fader.master-tempo-ear",
  "nudge-phase.converge",
  "nudge-phase.hold",
  "nudge-phase.cue-presses",
  "standing.no-recue",
  "standing.cued-first",
]);

/** Criteria met by the absence of something over the attempt: data after the drop could hold it. */
const NO_VIOLATION: ReadonlySet<CriterionId> = new Set<CriterionId>([
  "deck-basics.no-clip-local",
  "headphone-cue.b-off-master",
  "sync-blend.trim-untouched",
  "bass-swap.clash-short",
  "blend-by-ear.clash-short",
  "crossfader.faders-up",
  "standing.no-clip",
  "standing.no-dead-air",
  "standing.trim-still",
  "standing.no-boost",
  "standing.controls-reset",
  "standing.sync-kept",
  "standing.one-bass",
]);

export function readsContinuousData(id: CriterionId): boolean {
  return !DISCRETE_ONLY.has(id);
}

/** Engine command names of the continuous controls (src/audio CONTINUOUS_CONTROLS) and their contract ids. */
const CONTINUOUS = new Set([
  "tempo",
  "jog-bend",
  "trim",
  "eq-low",
  "eq-mid",
  "eq-high",
  "filter",
  "channel-fader",
  "crossfader",
  "master-level",
  "cue-mix",
  "channelFader",
  "eqLow",
  "eqMid",
  "eqHigh",
]);

/** The earliest moment the recorder may have started dropping data. */
export function estimateDropPoint(attempt: GradedAttempt, window: CtxSpan): CtxTime {
  // Every kept move is in `engineEvents`; contract events are read too, for attempts without them.
  const moves = [
    ...(attempt.engineEvents ?? []).filter((record) => CONTINUOUS.has(record.command.control)).map((record) => record.heardCtx ?? record.appliedCtx),
    ...attempt.events.filter((event) => CONTINUOUS.has(event.control)).map((event) => event.ctx),
  ];
  const lastMove = moves.length === 0 ? null : Math.max(...moves);
  const lastFrames = [attempt.meters.master, attempt.meters.A, attempt.meters.B].flatMap((frames) => {
    const last = frames?.at(-1);
    return last === undefined ? [] : [last.ctx];
  });
  const metersEnd = lastFrames.length === 0 ? null : Math.max(...lastFrames);
  const metersStopped = metersEnd !== null && metersEnd < window.to - MAX_FRAME_AGE_S ? metersEnd : null;
  const candidates = [lastMove, metersStopped].filter((t) => t !== null);
  return candidates.length === 0 ? window.from : Math.min(...candidates);
}

export interface DegradedGrading {
  readonly criteria: readonly CriterionResult[];
  /** A fail-severity criterion could not be graded, so the attempt cannot pass. */
  readonly blocksPass: boolean;
}

function ungraded(criterion: CriterionResult): CriterionResult {
  const kept = criterion.measured === null ? {} : { keptMeasured: criterion.measured };
  return {
    ...criterion,
    status: "notApplicable",
    measured: null,
    margin: null,
    detail: { ...criterion.detail, ...kept, recordingDegraded: 1 },
  };
}

function regrade(criterion: CriterionResult, dropAt: CtxTime, window: CtxSpan): CriterionResult {
  if (criterion.status === "notApplicable" || !readsContinuousData(criterion.id)) return criterion;
  if (NO_VIOLATION.has(criterion.id)) {
    if (dropAt >= window.to) return criterion;
    if (criterion.status === "met") return ungraded(criterion);
    return criterion.evidence.some((evidence) => evidence.from < dropAt) ? criterion : ungraded(criterion);
  }
  return criterion.status === "notMet" ? ungraded(criterion) : criterion;
}

export function gradeDegraded(criteria: readonly CriterionResult[], attempt: GradedAttempt, window: CtxSpan): DegradedGrading {
  const dropAt = estimateDropPoint(attempt, window);
  const graded = criteria.map((criterion) => regrade(criterion, dropAt, window));
  const blocksPass = graded.some(
    (criterion, index) => criterion.severity === "fail" && criterion.status === "notApplicable" && criteria[index]?.status !== "notApplicable",
  );
  return { criteria: graded, blocksPass };
}
