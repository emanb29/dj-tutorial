// Lessons: the hand-authored Lesson catalogue (the built Lessons so far) and the pure runtime that runs one.
// The app (src/app/lesson) owns audio, React and the network; everything here is data and pure functions.
export {
  checkDecksFor,
  checkSpecFor,
  GAIN_ZONE_DB,
  isBuiltLesson,
  LESSON_AIDS,
  LESSON_GRADING,
  type Grading,
  LESSONS,
  lessonDefinition,
  practiceDecksFor,
  practiceLoopFor,
  readyUsedIn,
  lessonUnlocks,
  unlocksAfter,
  withPlannedGrids,
  type BuiltLesson,
  type BuiltLessonId,
} from "./catalogue.ts";
export {
  checkLineRequest,
  curriculumRequest,
  describeCriterion,
  lineFacts,
  NO_LINE_FACTS,
  skipGroupsPassed,
  toCoachSummary,
  withCurriculum,
  type CurriculumAnswer,
  type LineContext,
  type LineFacts,
} from "./coach.ts";
export { blendPose, followBlend, START_BLEND, type BlendFollow } from "./blend-steps.ts";
export { classifyTap } from "./feedback.ts";
export { criterionLabel, gradedLine } from "./criterion-labels.ts";
export {
  ancestorsOf,
  applyPlacement,
  creditedLessons,
  hasPlacement,
  nextStep,
  nextTask,
  PLACEMENT_GROUPS,
  PLACEMENT_TASK_IDS,
  placementCurriculumRequest,
  startLesson,
  withPlacement,
  withTaskOutcome,
  type PlacementStep,
  type PlacementTask,
  type PlacementTaskId,
  type TaskOutcome,
} from "./placement.ts";
export { placementControls, placementTask, placementTrackProblems, type PlacementTaskDefinition } from "./placement-tasks.ts";
export { pairProblems, PAIR_MAX_APART, PAIR_MIN_APART, tempoTargets, withoutMasterTempo } from "./catalogue-sync.ts";
export { blendPositions, eqPairProblems } from "./catalogue-eq-filter.ts";
export { partnerOrder } from "./plan.ts";
export { phrasePreviewSpan, previewPhraseAt } from "./phrase-preview.ts";
export { PHRASE_COUNT_START, phraseCountStep, phrasePosition, type PhraseCountState, type PhrasePosition } from "./phrase-count.ts";
export { BY_EAR_LESSONS, COVERED_DISPLAYS, describeByEar, kickRun } from "./catalogue-by-ear.ts";
export { drillReveals, drillStep, livePhaseMs, startDrill, tempoPercentApart, type DrillAction, type DrillInput, type DrillReading, type DrillState, type DrillStep, type RoundStart } from "./drill.ts";
export { hotCuePadPhrases, PERFORMANCE_LESSONS, type PerformanceLessonId } from "./catalogue-performance.ts";
export { EQ_CENTRED_DB, EQ_CUT_DB, FILTER_CENTRED, initialLessonState, lessonReducer, TIP_AFTER_MISSES, triggerStep, type LessonEvent, type LessonPhase, type LessonState } from "./runtime.ts";
export { SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, SYNTHETIC_TRACK_ID, synthesizeHouse, syntheticLessonTrack, type SyntheticLayout } from "./synthetic-track.ts";
export { barStart, beatSec, heardTimeOf, lessonTrackFromAnalysis, lessonTrackFromKnownGrid, peakDbfsOf, phraseStart, SET_UP_PEAK_DB, setUpTrim, setUpTrimDb, sliceTrack, trackOnDeck } from "./track.ts";
export type * from "./types.ts";
export {
  camelotOf,
  COURSE,
  describeSetCriterion,
  FINAL_MIX,
  FINAL_MIX_AIDS,
  finalMixMode,
  finalMixSpec,
  finalMixWindow,
  keysCompatible,
  preparedTrack,
  SET_GENRES,
  SET_RULES,
  SYNTHETIC_SET,
  setEntry,
  setNotesText,
  setProblems,
  warningText,
  type CourseLessonId,
  type PlayedTrack,
  type SetCandidate,
  type SetEntry,
  type SetLessonDefinition,
  type SetProblems,
  type SetWarning,
  type TransitionNote,
} from "./catalogue-final.ts";
