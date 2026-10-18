import { describe, expect, it } from "vitest";
import { emptyLearnerRecord, LearnerRecordSchema, withRekordboxChoice } from "@shared/learner.ts";
import { LESSON_CARDS, lessonCardFor } from "./rekordbox-steps.ts";

const AT = "2026-10-17T12:00:00.000Z";

describe("the rekordbox card after a Lesson", () => {
  const fresh = emptyLearnerRecord("tester");

  it.each(["cut-on-phrase", "sync-blend", "blend-by-ear", "final-mix"] as const)("shows after passing %s", (lessonId) => {
    expect(lessonCardFor(lessonId, true, fresh)?.id).toBe(lessonId);
  });

  it("does not show on a fail, or for a Lesson without one", () => {
    expect(lessonCardFor("cut-on-phrase", false, fresh)).toBeNull();
    expect(lessonCardFor("deck-basics", true, fresh)).toBeNull();
  });

  it("stops once done, but comes back after Not now", () => {
    expect(lessonCardFor("sync-blend", true, withRekordboxChoice(fresh, "sync-blend", "done", AT))).toBeNull();
    expect(lessonCardFor("sync-blend", true, withRekordboxChoice(fresh, "sync-blend", "notNow", AT))).not.toBeNull();
  });
});

describe("the profile field", () => {
  it("is optional, so records from before it still parse", () => {
    expect(LearnerRecordSchema.safeParse(emptyLearnerRecord("tester")).success).toBe(true);
  });

  it("still parses an answer to the retired library card", () => {
    const record = withRekordboxChoice(emptyLearnerRecord("tester"), "library", "done", AT);
    expect(LearnerRecordSchema.safeParse(record).success).toBe(true);
  });

  it("round-trips an answer", () => {
    const record = withRekordboxChoice(emptyLearnerRecord("tester"), "sync-blend", "done", AT);
    expect(LearnerRecordSchema.parse(record).rekordbox).toEqual({ "sync-blend": { choice: "done", at: AT } });
  });

  it("refuses an unknown card, an unknown choice or a bad time", () => {
    const base = emptyLearnerRecord("tester");
    expect(LearnerRecordSchema.safeParse({ ...base, rekordbox: { "deck-basics": { choice: "done", at: AT } } }).success).toBe(false);
    expect(LearnerRecordSchema.safeParse({ ...base, rekordbox: { "sync-blend": { choice: "maybe", at: AT } } }).success).toBe(false);
    expect(LearnerRecordSchema.safeParse({ ...base, rekordbox: { "sync-blend": { choice: "done", at: "yesterday" } } }).success).toBe(false);
  });
});

describe("the wording", () => {
  const cards = Object.values(LESSON_CARDS);

  it("keeps every line to 15 words or fewer", () => {
    const long = cards.flatMap((card) => [...card.steps, ...card.differs]).filter((line) => line.split(/\s+/).length > 15);
    expect(long).toEqual([]);
  });

  it("gives each Lesson 3–5 steps", () => {
    for (const card of Object.values(LESSON_CARDS)) {
      expect(card.steps.length).toBeGreaterThanOrEqual(3);
      expect(card.steps.length).toBeLessThanOrEqual(5);
    }
  });
});
