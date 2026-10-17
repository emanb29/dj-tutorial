import { describe, expect, it } from "vitest";
import { ELECTIVE_IDS, LESSON_IDS, LESSONS, REQUIRED_LESSON_IDS, catalogueIndex, lessonById } from "./catalogue.ts";

describe("Lesson catalogue", () => {
  it("has the 20 Lessons of docs/lesson-catalogue.md, in catalogue order", () => {
    expect(LESSONS.map((lesson) => lesson.id)).toEqual([...LESSON_IDS]);
    expect(LESSON_IDS).toHaveLength(20);
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
