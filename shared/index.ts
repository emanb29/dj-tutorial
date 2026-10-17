// Code shared by the client (src/) and the API server (server/).
export type { ApiErrorCode, ApiFailure, ApiResponse, ApiSuccess, HealthData } from "./api.ts";
export { HEALTH_PATH } from "./api.ts";
export type {
  Aids,
  Attempt,
  BeatGrid,
  ChannelSnapshot,
  CheckMode,
  CheckVariant,
  ControlEvent,
  ControlId,
  CtxSpan,
  CtxTime,
  CuePointSet,
  DeckId,
  DeckRecording,
  InputDevice,
  Interruption,
  InterruptionKind,
  IsoTime,
  LessonId,
  LessonTask,
  MeterFrame,
  MeterRecording,
  MixerSnapshot,
  PlayheadModel,
  PlayheadSegment,
  TaskSpec,
  TaskTrack,
} from "./attempt.ts";
export { channelFaderGainDb, crossfaderGainDb, GAIN_FLOOR_DB, LESSON_IDS } from "./attempt.ts";
export type {
  Band,
  CheckOutcome,
  CheckResult,
  CriterionId,
  CriterionResult,
  CriterionStatus,
  Evidence,
  FinalMixBands,
  Severity,
  StandingId,
  Threshold,
  Unit,
  VoidAttempt,
  VoidReason,
} from "./check-result.ts";
export { STANDING_IDS } from "./check-result.ts";
export type {
  CriterionRecord,
  CriterionRetention,
  LessonRecord,
  RetentionState,
  RetentionStep,
  SkillProfile,
} from "./skill-profile.ts";
export { emptySkillProfile } from "./skill-profile.ts";
