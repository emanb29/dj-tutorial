// Checks: pure functions over a recorded attempt, shared by the client and the eval scripts (ADR 0001).
// Grading is `runCheck`; Skill profile writes are `applyCheckResult`; warm-ups are `scheduleWarmups`.
export { runCheck, LOCKED_OFF_AIDS, MAX_GRID_RESIDUAL_MS } from "./run-check.ts";
export type { GradedAttempt } from "./deck-controls.ts";
export {
  applyCheckResult,
  criterionRecords,
  DUE_SLACK_HOURS,
  FINAL_MIX_ROUTE,
  isCourseComplete,
  lessonOfCriterion,
  lessonRetention,
  RETENTION_LADDER_DAYS,
  reviewsDue,
  type ProfileUpdate,
  type RetentionChange,
  type ReviewTrigger,
} from "./profile.ts";
export { scheduleWarmups, WARMUP_LIMITS, type WarmupLimits, type WarmupPlan } from "./warmups.ts";
export { standingSeverity } from "./standing.ts";
export {
  CUE_PLACEMENT_TOLERANCE_MS,
  CUED_TAP_TOLERANCE_MS,
  pointActionToleranceMs,
  TAP_TOLERANCE_MS,
} from "./tolerance.ts";
export { matchTaps, type TapMatch } from "./measures.ts";
