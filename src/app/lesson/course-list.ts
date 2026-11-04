// What the Lesson list shows (docs/lesson-catalogue.md, "Two paths"): the recorded-mix path with its
// two milestones, then the live path. Pure: the list's rows and where LOAD A goes, from the profile.
// A row opens once its prerequisites are passed; progress is never time-gated.
import { lessonRetention } from "@checks";
import { COURSE, type CourseLessonId } from "@lessons";
import {
  catalogueIndex,
  coursePathOf,
  lessonById,
  MILESTONES,
  RECORDED_PATH_LESSON_IDS,
  type CoursePathId,
  type LessonId,
  type MilestoneId,
} from "@shared/catalogue.ts";
import type { LearnerRecord } from "@shared/learner.ts";

export type LessonStanding = "locked" | "ready" | "passed" | "retained" | "lapsed";
/** A milestone records nothing yet: it is open or not. */
export type MilestoneStanding = "locked" | "ready";

export type CourseRow =
  | {
      readonly kind: "lesson";
      readonly lessonId: CourseLessonId;
      /** "Lesson 3": the catalogue position, 1 to 20. */
      readonly number: number;
      readonly title: string;
      readonly standing: LessonStanding;
      /** What to pass first, when locked. */
      readonly needs: string | null;
    }
  | {
      readonly kind: "milestone";
      readonly milestoneId: MilestoneId;
      readonly title: string;
      readonly caption: string;
      readonly standing: MilestoneStanding;
      readonly needs: string | null;
    };

export interface CourseSection {
  readonly path: CoursePathId;
  readonly title: string;
  readonly caption: string;
  readonly rows: readonly CourseRow[];
}

const SECTION_WORDS: Readonly<Record<CoursePathId, Pick<CourseSection, "title" | "caption">>> = {
  recorded: { title: "Recorded mixes", caption: "Plan, record, post. Sync and the BPM display are fine here." },
  live: { title: "Live sets (later)", caption: "Optional, for streaming: beatmatch by ear, no sync." },
};

/** More unpassed Lessons than this are counted, not named. */
const NAMED_NEEDS = 2;

const passedIn = (learner: LearnerRecord, id: LessonId) => learner.skillProfile.lessons[id]?.passedAt != null;

function needsLine(learner: LearnerRecord, prerequisites: readonly LessonId[]): string | null {
  const missing = prerequisites.filter((id) => !passedIn(learner, id));
  if (missing.length === 0) return null;
  if (missing.length > NAMED_NEEDS) return `Pass ${String(missing.length)} more Lessons first`;
  return `Pass “${missing.map((id) => lessonById(id).title).join("”, “")}” first`;
}

export function lessonStanding(learner: LearnerRecord, lessonId: CourseLessonId): LessonStanding {
  if (passedIn(learner, lessonId)) {
    const retention = lessonRetention(learner.skillProfile, lessonId);
    return retention === "retained" || retention === "lapsed" ? retention : "passed";
  }
  return needsLine(learner, lessonById(lessonId).prerequisites) === null ? "ready" : "locked";
}

function lessonRow(learner: LearnerRecord, lesson: (typeof COURSE)[number]): CourseRow {
  const standing = lessonStanding(learner, lesson.id);
  return {
    kind: "lesson",
    lessonId: lesson.id,
    number: catalogueIndex(lesson.id) + 1,
    title: lesson.title,
    standing,
    needs: standing === "locked" ? needsLine(learner, lessonById(lesson.id).prerequisites) : null,
  };
}

function milestoneRows(learner: LearnerRecord, after: LessonId): CourseRow[] {
  return MILESTONES.filter((milestone) => milestone.after === after).map((milestone) => {
    const needs = needsLine(learner, milestone.prerequisites);
    return { kind: "milestone", milestoneId: milestone.id, title: milestone.title, caption: milestone.caption, standing: needs === null ? "ready" : "locked", needs };
  });
}

/** The list: the recorded-mix path (Lessons, milestones after their Lesson), then the live path. */
export function courseSections(learner: LearnerRecord): CourseSection[] {
  return (["recorded", "live"] as const).map((path) => ({
    path,
    ...SECTION_WORDS[path],
    rows: COURSE.filter((lesson) => coursePathOf(lesson.id) === path).flatMap((lesson) => [lessonRow(learner, lesson), ...milestoneRows(learner, lesson.id)]),
  }));
}

export type CourseStart = { readonly kind: "lesson"; readonly lessonId: CourseLessonId } | { readonly kind: "milestone"; readonly milestoneId: MilestoneId };

/**
 * Where LOAD A (Enter) goes with no ring: the next recorded-path Lesson, then the recorded final
 * project. The live path is optional: the Learner turns BROWSE to it.
 */
export function courseStart(learner: LearnerRecord): CourseStart {
  const next = RECORDED_PATH_LESSON_IDS.find((id) => !passedIn(learner, id));
  return next === undefined ? { kind: "milestone", milestoneId: "recorded-mix" } : { kind: "lesson", lessonId: next };
}
