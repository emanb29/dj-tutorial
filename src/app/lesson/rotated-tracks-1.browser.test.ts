// ISS-100: Lessons 1–7 on rotated Originals, following the captions, at 48 kHz (rotated-tracks.harness.ts).
import { describe } from "vitest";
import { describeLessons, describePicks } from "./rotated-tracks.harness.ts";

describe("Lessons 1–7 on rotated Originals, following the captions, at 48 kHz", () => {
  describePicks();
  describeLessons(1, 7);
});
