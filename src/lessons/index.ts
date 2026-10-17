// Lessons: the hand-authored Lesson catalogue (Lessons 1–3 so far) and the pure runtime that runs one.
// The app (src/app/lesson) owns audio, React and the network; everything here is data and pure functions.
export { checkSpecFor, isBuiltLesson, LESSON_AIDS, LESSONS, lessonDefinition, unlocksAfter, type BuiltLesson, type BuiltLessonId } from "./catalogue.ts";
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
export { classifyTap } from "./feedback.ts";
export { initialLessonState, lessonReducer, TIP_AFTER_MISSES, type LessonEvent, type LessonPhase, type LessonState } from "./runtime.ts";
export { SYNTHETIC_HOUSE, SYNTHETIC_TRACK_ID, synthesizeHouse, syntheticLessonTrack, type SyntheticLayout } from "./synthetic-track.ts";
export { barStart, beatSec, heardTimeOf, lessonTrackFromAnalysis, lessonTrackFromKnownGrid, phraseStart } from "./track.ts";
export type * from "./types.ts";
