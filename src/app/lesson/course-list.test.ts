import { describe, expect, it } from "vitest";
import { LESSON_IDS, RECORDED_PATH_LESSON_IDS, type LessonId } from "@shared/catalogue.ts";
import { openBeforePaths } from "@shared/catalogue-test-support.ts";
import { emptyLearnerRecord, type LearnerRecord } from "@shared/learner.ts";
import { courseSections, courseStart, type CourseRow } from "./course-list.ts";

const AT = "2026-10-20T10:00:00.000Z";

function learnerWith(passed: readonly LessonId[]): LearnerRecord {
  const record = emptyLearnerRecord("default");
  return {
    ...record,
    skillProfile: {
      ...record.skillProfile,
      lessons: Object.fromEntries(passed.map((lessonId) => [lessonId, { lessonId, passedAt: AT, passedVia: "lesson" as const, attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }])),
    },
  };
}

const rowKey = (row: CourseRow) => (row.kind === "lesson" ? row.lessonId : row.milestoneId);
const lessonRows = (learner: LearnerRecord) =>
  courseSections(learner).flatMap((section) => section.rows).filter((row): row is Extract<CourseRow, { kind: "lesson" }> => row.kind === "lesson");

/** Progress shaped like a Learner part-way in: Foundations by Placement, then the sync and EQ Lessons. */
const MID_COURSE: readonly LessonId[] = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "eq-basics", "bass-swap", "nudge-phase"];

describe("courseSections: the two paths", () => {
  it("lists the recorded-mix path first, with the first mix after the cut and the recorded mix last", () => {
    const [recorded, live] = courseSections(learnerWith([]));
    expect(recorded?.path).toBe("recorded");
    expect(recorded?.rows.map(rowKey)).toEqual([
      ...RECORDED_PATH_LESSON_IDS.slice(0, 7),
      "first-mix",
      ...RECORDED_PATH_LESSON_IDS.slice(7),
      "recorded-mix",
    ]);
    expect(live?.path).toBe("live");
    expect(live?.rows.map(rowKey)).toEqual(["nudge-phase", "tempo-by-ear", "blend-by-ear", "final-mix"]);
  });

  it("numbers Lessons in course order, 1 to 20, and gives milestones no number", () => {
    expect(lessonRows(learnerWith([])).map((row) => row.number)).toEqual(LESSON_IDS.map((_, index) => index + 1));
  });

  it("opens the first mix once the cut is passed, and the recorded mix only once the whole recorded path is", () => {
    const milestone = (learner: LearnerRecord, id: string) =>
      courseSections(learner).flatMap((section) => section.rows).find((row) => row.kind === "milestone" && row.milestoneId === id);
    const cut = RECORDED_PATH_LESSON_IDS.slice(0, 7);
    expect(milestone(learnerWith(cut.slice(0, 6)), "first-mix")).toMatchObject({ standing: "locked", needs: "Pass “Your first transition: the cut” first" });
    expect(milestone(learnerWith(cut), "first-mix")).toMatchObject({ standing: "ready" });
    expect(milestone(learnerWith(cut), "recorded-mix")).toMatchObject({ standing: "locked", needs: "Pass 9 more Lessons first" });
    expect(milestone(learnerWith(RECORDED_PATH_LESSON_IDS.filter((id) => id !== "echo-out")), "recorded-mix")).toMatchObject({ needs: "Pass “The echo out” first" });
    // The live path is not needed for the recorded final project.
    expect(milestone(learnerWith(RECORDED_PATH_LESSON_IDS), "recorded-mix")).toMatchObject({ standing: "ready" });
  });

  it("names only the prerequisites still to pass on a locked Lesson", () => {
    const row = lessonRows(learnerWith(["deck-basics", "beats-and-bars", "phrases"])).find((candidate) => candidate.lessonId === "cut-on-phrase");
    expect(row).toMatchObject({ standing: "locked", needs: "Pass “Set the level”, “Set a cue point by ear” first" });
  });
});

describe("stored progress keeps every open Lesson (2026-11-03)", () => {
  /** Every prefix of course order and of the old order, plus mid-course progress with a live Lesson. */
  const OLD_ORDER: readonly LessonId[] = [...LESSON_IDS.filter((id) => !["hot-cues", "loop-transition", "echo-out", "final-mix"].includes(id)), "hot-cues", "loop-transition", "echo-out", "final-mix"];
  const profiles: readonly (readonly LessonId[])[] = [
    ...LESSON_IDS.map((_, index) => LESSON_IDS.slice(0, index)),
    ...OLD_ORDER.map((_, index) => OLD_ORDER.slice(0, index)),
    MID_COURSE,
  ];

  it("never locks a Lesson that was open under the catalogue before the two paths", () => {
    for (const passed of profiles) {
      const passedSet = new Set(passed);
      for (const row of lessonRows(learnerWith(passed))) {
        if (openBeforePaths(row.lessonId, passedSet)) expect(row.standing, `${row.lessonId} after ${passed.join(", ")}`).not.toBe("locked");
      }
    }
  });

  it("keeps a passed live Lesson passed and open on the live path", () => {
    const rows = lessonRows(learnerWith(MID_COURSE));
    expect(rows.find((row) => row.lessonId === "nudge-phase")).toMatchObject({ standing: "passed" });
    expect(rows.find((row) => row.lessonId === "tempo-by-ear")).toMatchObject({ standing: "ready" });
  });
});

describe("courseStart: where LOAD A goes", () => {
  it("is the next recorded-path Lesson before any live one", () => {
    expect(courseStart(learnerWith([]))).toEqual({ kind: "lesson", lessonId: "deck-basics" });
    expect(courseStart(learnerWith(MID_COURSE))).toEqual({ kind: "lesson", lessonId: "crossfader" });
  });

  it("is the recorded final project once the recorded path is passed, never a live Lesson", () => {
    expect(courseStart(learnerWith(RECORDED_PATH_LESSON_IDS))).toEqual({ kind: "milestone", milestoneId: "recorded-mix" });
    expect(courseStart(learnerWith(LESSON_IDS))).toEqual({ kind: "milestone", milestoneId: "recorded-mix" });
  });
});
