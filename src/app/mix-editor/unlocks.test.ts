import { describe, expect, it } from "vitest";
import { emptyLearnerRecord } from "@shared/learner.ts";
import { plannerUnlocks } from "./unlocks.ts";

describe("plannerUnlocks", () => {
  it("a new Learner has learned nothing yet, so every planned control counts against the rating", () => {
    expect(plannerUnlocks(emptyLearnerRecord("e2e-someone")).size).toBe(0);
  });
});
