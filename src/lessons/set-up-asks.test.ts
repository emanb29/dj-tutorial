import { describe, expect, it } from "vitest";
import { LESSONS } from "./catalogue.ts";
import { askDone, setUpStep, trimmedPeakDb, type SetUpReading } from "./set-up-asks.ts";
import { syntheticLessonTrack, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER } from "./synthetic-track.ts";

const AS_CUED: SetUpReading = {
  cueOn: { A: false, B: false },
  syncOn: { A: false, B: false },
  lowCut: { A: false, B: false },
  fader: { A: 1, B: 0 },
  beatFxOn: false,
  levelDb: { A: -9, B: -9 },
};

describe("a set-up step's asks", () => {
  it("names every ask in its caption, in order, with no R to press", () => {
    expect(setUpStep([{ kind: "cue-on", deck: "B" }, { kind: "fader-up", deck: "B" }, { kind: "trims-matched" }])).toEqual({
      caption: "Set up: CUE 🎧 B on, fader B up, trims matched",
      asks: [{ kind: "cue-on", deck: "B" }, { kind: "fader-up", deck: "B" }, { kind: "trims-matched" }],
    });
    expect(setUpStep([{ kind: "sync-on", deck: "B" }, { kind: "cue-on", deck: "B" }]).caption).toBe("Set up: SYNC B on, CUE 🎧 B on");
    expect(setUpStep([{ kind: "cue-on", deck: "B" }, { kind: "low-cut", deck: "B" }]).caption).toBe("Set up: CUE 🎧 B on, LOW B all the way down");
    expect(setUpStep([{ kind: "cue-on", deck: "B" }, { kind: "echo-on" }]).caption).toBe("Set up: CUE 🎧 B on, ECHO on (V)");
  });

  it("reads each ask off the decks and the mixer", () => {
    const done = (ask: Parameters<typeof askDone>[0], change: Partial<SetUpReading>) => askDone(ask, { ...AS_CUED, ...change });
    expect(done({ kind: "cue-on", deck: "B" }, {})).toBe(false);
    expect(done({ kind: "cue-on", deck: "B" }, { cueOn: { A: false, B: true } })).toBe(true);
    expect(done({ kind: "cue-on", deck: "B" }, { cueOn: { A: true, B: false } })).toBe(false);
    expect(done({ kind: "sync-on", deck: "B" }, { syncOn: { A: false, B: true } })).toBe(true);
    expect(done({ kind: "low-cut", deck: "B" }, { lowCut: { A: true, B: false } })).toBe(false);
    expect(done({ kind: "low-cut", deck: "B" }, { lowCut: { A: false, B: true } })).toBe(true);
    // Fader up: the hook's "fader up" line.
    expect(done({ kind: "fader-up", deck: "B" }, { fader: { A: 1, B: 0.5 } })).toBe(false);
    expect(done({ kind: "fader-up", deck: "B" }, { fader: { A: 1, B: 0.95 } })).toBe(true);
    expect(done({ kind: "echo-on" }, { beatFxOn: true })).toBe(true);
    expect(done({ kind: "echo-on" }, {})).toBe(false);
  });

  it("counts trims as matched when both decks would peak within 1.5 dB of each other", () => {
    expect(askDone({ kind: "trims-matched" }, AS_CUED)).toBe(true);
    expect(askDone({ kind: "trims-matched" }, { ...AS_CUED, levelDb: { A: -9, B: -10.4 } })).toBe(true);
    expect(askDone({ kind: "trims-matched" }, { ...AS_CUED, levelDb: { A: -9, B: -12 } })).toBe(false);
    // No deck B: nothing to match.
    expect(askDone({ kind: "trims-matched" }, { ...AS_CUED, levelDb: { A: -9, B: null } })).toBe(true);
    // A track's measured peak plus its trim; an unmeasured one as the set-up level assumes.
    expect(trimmedPeakDb(syntheticLessonTrack(SYNTHETIC_PARTNER), 2)).toBeCloseTo((syntheticLessonTrack(SYNTHETIC_PARTNER).peakDbfs ?? -6) + 2, 9);
    expect(trimmedPeakDb({}, -3)).toBe(-9);
  });

  it("every Lesson's set-up step says what it asks, and its caption comes from those asks", () => {
    const track = syntheticLessonTrack(SYNTHETIC_HOUSE);
    const steps = LESSONS.flatMap((lesson) => {
      const plan = lesson.planCheck(track, 1, LESSONS.map((each) => each.id));
      return plan.setUp === undefined ? [] : [{ id: lesson.id, step: plan.setUp }];
    });
    expect(steps.length).toBeGreaterThan(5);
    for (const { id, step } of steps) {
      expect(step.asks.length, id).toBeGreaterThan(0);
      expect(step, id).toEqual(setUpStep(step.asks));
      expect(step.caption, id).not.toMatch(/\bR\b/);
    }
  });
});
