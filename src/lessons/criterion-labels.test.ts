import { describe, expect, it } from "vitest";
import { gradableCriteria } from "@checks";
import { LESSONS, lessonDefinition } from "./catalogue.ts";
import { criterionLabel, gradedLine } from "./criterion-labels.ts";

describe("criterion labels", () => {
  it.each(gradableCriteria())("%s has a short Learner label", (id) => {
    const label = criterionLabel(id);
    expect(label.length).toBeGreaterThan(0);
    expect(label.split(" ").length).toBeLessThanOrEqual(5);
  });

  it("refuses a criterion without a label", () => {
    expect(() => criterionLabel("beats-and-bars.not-a-criterion")).toThrow(/criterion-labels\.ts/);
  });
});

describe("the Graded line", () => {
  it("names Lesson 2's taps", () => {
    expect(gradedLine(lessonDefinition("beats-and-bars"), ["deck-basics"])).toBe("Graded: taps on the beat · then only the 1");
  });

  // Maintainer feedback: the level is graded once gain-staging is passed, and nothing said so.
  it("announces a standing criterion the Check grades", () => {
    const passed = ["deck-basics", "beats-and-bars", "phrases", "gain-staging"] as const;
    expect(gradedLine(lessonDefinition("headphone-cue"), passed)).toBe("Graded: taps on B's kick · B off the master · master out of the red");
  });

  it("leaves out standing criteria that only warn", () => {
    const passed = LESSONS.map((lesson) => lesson.id).filter((id) => id !== "blend-by-ear");
    const line = gradedLine(lessonDefinition("blend-by-ear"), passed);
    expect(line).toContain("master out of the red");
    expect(line).not.toContain("no EQ boosts");
  });

  it.each(LESSONS.map((lesson) => lesson.id))("%s's line fits one line with every Lesson before it passed", (id) => {
    const passed = LESSONS.map((lesson) => lesson.id).slice(0, LESSONS.findIndex((lesson) => lesson.id === id));
    const line = gradedLine(lessonDefinition(id), passed);
    expect(line.startsWith("Graded: ")).toBe(true);
    expect(line.length, line).toBeLessThanOrEqual(140);
  });
});
