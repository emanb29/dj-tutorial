import { describe, expect, it } from "vitest";
import { LESSONS, lessonDefinition, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack } from "@lessons";
import { inputWording } from "../controller/wording.ts";

// Every caption a Lesson shows, as a touchscreen Learner reads it: no key is left to press.
const track = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6, partner: { ...syntheticLessonTrack(SYNTHETIC_PARTNER), peakDbfs: -6 } };
const captions = LESSONS.flatMap((lesson) => {
  const plan = lesson.planCheck(track);
  return [
    ...lesson.hook.flatMap((step) => [step.caption, step.named]),
    lesson.practice.caption,
    lesson.practiceCaptionFor?.(track),
    lesson.checkCaption,
    ...lesson.questions.map((question) => question.caption),
    ...plan.cues.map((cue) => cue.caption),
    ...(plan.readyCues ?? []),
    ...Object.values(lesson.tips).flat(),
  ]
    .filter((caption) => caption !== undefined)
    .map((caption) => ({ lesson: lesson.id, caption }));
});
/** A key label standing on its own: a deck key, the comma (PLAY B), the crossfader's C and N, Space, or R (Ready). */
const KEY_LEFT = /(?:^|[\s(:;,])(?:[ZXWSMOLRCN,]|Space)(?=$|[\s.,;:!?)])/;

describe("Lesson captions on a touchscreen", () => {
  it.each(captions)("$lesson: $caption", ({ caption }) => {
    const touch = inputWording(caption, "touch");
    expect(touch).not.toMatch(KEY_LEFT);
    expect(touch).not.toMatch(/\b(?:Click|Scroll|press)\b/);
  });

  it("names the crossfader for its cut keys", () => {
    expect(inputWording("Snap it back to A (C)", "touch")).toBe("Snap it back to A");
    expect(inputWording("Press , on the phrase's 1, crossfader to B; later C on a 1", "touch")).toBe(
      "Tap PLAY on deck B on the phrase's 1, crossfader to B; later snap the crossfader to A on a 1",
    );
    expect(inputWording("Snap it back to A (C)", "keys")).toBe("Snap it back to A (C)");
  });

  it("words the bass swap and the filter for a finger: PLAY on deck B, no S for A's fader", () => {
    const bassSwap = lessonDefinition("bass-swap");
    const filter = lessonDefinition("filter-transition");
    expect(inputWording(bassSwap.hook[1]?.caption ?? "", "touch")).toBe("On the phrase's 1: Tap PLAY on deck B and push fader B up");
    expect(inputWording(filter.practice.caption, "touch")).toBe("CFX A right from 2 bars before B; A out a phrase after B");
    const cues = filter.planCheck(track).cues.map((cue) => inputWording(cue.caption, "touch"));
    expect(cues).toContain("Next 1: Tap PLAY on deck B and slide B up");
    expect(cues).toContain("Next 1: A out");
    expect(inputWording(filter.practice.caption, "keys")).toContain("(S)");
  });

  it("names Ready for the Lesson's R key", () => {
    expect(inputWording("Both meters in the zone, then Ready (R)", "touch")).toBe("Both meters in the zone, then Ready");
    expect(inputWording("Cue 1 of 3: a 1, by ear. R when happy", "touch")).toBe("Cue 1 of 3: a 1, by ear. Ready when happy");
    expect(inputWording("Both meters in the zone, then Ready (R)", "keys")).toBe("Both meters in the zone, then Ready (R)");
  });
});
