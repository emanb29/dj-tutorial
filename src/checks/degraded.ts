// Grading a degraded attempt (src/audio RecordedAttempt.degraded): the recorder ran out of room and
// left out continuous moves (faders, knobs, tempo, jog) or meter frames past its budget.
//
// Decision: grade with a warning, never void and never fail on lost data.
// - Criteria that read only data the recorder never drops (taps, button presses, cue points,
//   answers, playhead models) are graded as usual.
// - A criterion that reads continuous data and is met stays met: the recorder drops only once its
//   budget is full, so what it kept is the true timeline up to that point and showed the skill.
// - A criterion that reads continuous data and is not met becomes `notApplicable` ("not graded:
//   the recording is incomplete") with `detail.recordingDegraded = 1`. It is not a fail, is not
//   written to the Skill profile and does not count toward a Review.
// - If that happens to a fail-severity criterion, the attempt cannot pass either (the skill was
//   not measured): the outcome is `failed` with no failed criteria. It is not voided because a void
//   needs a VoidReason the app shows, and the attempt did measure everything else.
import type { CriterionId, CriterionResult } from "@shared/check-result.ts";

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
]);

export function readsContinuousData(id: CriterionId): boolean {
  return !DISCRETE_ONLY.has(id);
}

export interface DegradedGrading {
  readonly criteria: readonly CriterionResult[];
  /** A fail-severity criterion could not be graded, so the attempt cannot pass. */
  readonly blocksPass: boolean;
}

export function gradeDegraded(criteria: readonly CriterionResult[]): DegradedGrading {
  const graded = criteria.map((criterion): CriterionResult => {
    if (criterion.status !== "notMet" || !readsContinuousData(criterion.id)) return criterion;
    const kept = criterion.measured === null ? {} : { keptMeasured: criterion.measured };
    return {
      ...criterion,
      status: "notApplicable",
      measured: null,
      margin: null,
      detail: { ...criterion.detail, ...kept, recordingDegraded: 1 },
    };
  });
  const blocksPass = graded.some(
    (criterion, index) => criterion.severity === "fail" && criterion.status === "notApplicable" && criteria[index]?.status === "notMet",
  );
  return { criteria: graded, blocksPass };
}
