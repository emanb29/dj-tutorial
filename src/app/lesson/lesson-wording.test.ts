import { describe, expect, it } from "vitest";
import { LESSONS, SYNTHETIC_HOUSE, syntheticLessonTrack } from "@lessons";
import { inputWording } from "../controller/wording.ts";

// Every caption a Lesson shows, as a touchscreen Learner reads it: no key is left to press.
const track = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6 };
const captions = LESSONS.flatMap((lesson) => {
  const plan = lesson.planCheck(track);
  return [
    ...lesson.hook.flatMap((step) => [step.caption, step.named]),
    lesson.practice.caption,
    lesson.checkCaption,
    ...plan.cues.map((cue) => cue.caption),
    ...(plan.readyCues ?? []),
    ...Object.values(lesson.tips).flat(),
  ]
    .filter((caption) => caption !== undefined)
    .map((caption) => ({ lesson: lesson.id, caption }));
});
/** A key label standing on its own: a deck key, the comma (PLAY B), Space, or R (Ready). */
const KEY_LEFT = /(?:^|[\s(:;,])(?:[ZXWSMOLR,]|Space)(?=$|[\s.,;:!?)])/;

describe("Lesson captions on a touchscreen", () => {
  it.each(captions)("$lesson: $caption", ({ caption }) => {
    const touch = inputWording(caption, "touch");
    expect(touch).not.toMatch(KEY_LEFT);
    expect(touch).not.toMatch(/\b(?:Click|Scroll|press)\b/);
  });

  it("names Ready for the Lesson's R key", () => {
    expect(inputWording("Both meters in the zone, then Ready (R)", "touch")).toBe("Both meters in the zone, then Ready");
    expect(inputWording("Cue 1 of 3: a 1, by ear. R when happy", "touch")).toBe("Cue 1 of 3: a 1, by ear. Ready when happy");
    expect(inputWording("Both meters in the zone, then Ready (R)", "keys")).toBe("Both meters in the zone, then Ready (R)");
  });
});
