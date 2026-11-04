import { describe, expect, it } from "vitest";
import {
  ELECTIVE_IDS,
  LESSON_IDS,
  LESSONS,
  LIVE_PATH_LESSON_IDS,
  MILESTONES,
  RECORDED_PATH_LESSON_IDS,
  REQUIRED_LESSON_IDS,
  catalogueIndex,
  coursePathOf,
  lessonById,
  milestoneById,
} from "./catalogue.ts";
import { PREREQUISITES_BEFORE_PATHS } from "./catalogue-test-support.ts";

describe("Lesson catalogue", () => {
  it("has the 20 Lessons of docs/lesson-catalogue.md, in course order: the recorded-mix path, then the live path", () => {
    expect(LESSONS.map((lesson) => lesson.id)).toEqual([...LESSON_IDS]);
    expect(LESSON_IDS).toHaveLength(20);
    expect([...LESSON_IDS]).toEqual([...RECORDED_PATH_LESSON_IDS, ...LIVE_PATH_LESSON_IDS]);
  });

  it("lists every prerequisite before the Lesson that needs it", () => {
    for (const lesson of LESSONS) {
      for (const prerequisite of lesson.prerequisites) {
        expect(catalogueIndex(prerequisite), `${prerequisite} before ${lesson.id}`).toBeLessThan(
          catalogueIndex(lesson.id),
        );
      }
    }
  });

  it("never adds a prerequisite, so no stored progress loses an open Lesson", () => {
    for (const lesson of LESSONS) {
      const before = new Set(PREREQUISITES_BEFORE_PATHS[lesson.id]);
      for (const prerequisite of lesson.prerequisites) expect(before.has(prerequisite), `${lesson.id} needs ${prerequisite}`).toBe(true);
    }
  });

  it("keeps electives off the required route, which is the critical path ending at final-mix", () => {
    expect(REQUIRED_LESSON_IDS).toHaveLength(15);
    expect(REQUIRED_LESSON_IDS.at(-1)).toBe("final-mix");
    for (const elective of ELECTIVE_IDS) expect(REQUIRED_LESSON_IDS).not.toContain(elective);
    for (const id of REQUIRED_LESSON_IDS) {
      for (const prerequisite of lessonById(id).prerequisites) {
        expect(REQUIRED_LESSON_IDS).toContain(prerequisite);
      }
    }
  });
});

describe("the two paths (catalogue, 2026-11-03)", () => {
  it("puts Lessons 1–16 on the recorded-mix path, and the by-ear Lessons and the live set on the live path", () => {
    expect(RECORDED_PATH_LESSON_IDS).toHaveLength(16);
    expect(LIVE_PATH_LESSON_IDS).toEqual(["nudge-phase", "tempo-by-ear", "blend-by-ear", "final-mix"]);
    expect(RECORDED_PATH_LESSON_IDS.slice(-3)).toEqual(["hot-cues", "loop-transition", "echo-out"]);
    expect(coursePathOf("echo-out")).toBe("recorded");
    expect(coursePathOf("blend-by-ear")).toBe("live");
    expect(coursePathOf("final-mix")).toBe("live");
  });

  it("closes the recorded-mix path under prerequisites: none of its Lessons needs a live one", () => {
    for (const id of RECORDED_PATH_LESSON_IDS) {
      for (const prerequisite of lessonById(id).prerequisites) expect(coursePathOf(prerequisite), `${id} needs ${prerequisite}`).toBe("recorded");
    }
  });

  it("opens the first mix right after the cut, and the recorded final project after the recorded path alone", () => {
    expect(milestoneById("first-mix")).toMatchObject({ after: "cut-on-phrase", prerequisites: ["cut-on-phrase"] });
    const final = milestoneById("recorded-mix");
    expect(final.after).toBe("echo-out");
    expect([...final.prerequisites]).toEqual([...RECORDED_PATH_LESSON_IDS]);
    for (const milestone of MILESTONES) {
      for (const prerequisite of milestone.prerequisites) expect(coursePathOf(prerequisite)).toBe("recorded");
      expect(milestone.prerequisites).toContain(milestone.after);
    }
  });
});
