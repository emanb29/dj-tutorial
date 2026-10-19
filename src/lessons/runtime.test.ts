import { describe, expect, it } from "vitest";
import type { CheckResult, CriterionResult } from "@shared/check-result.ts";
import { lessonDefinition } from "./catalogue.ts";
import { initialLessonState, lessonReducer, type LessonEvent, type LessonState } from "./runtime.ts";
import type { Observation } from "./types.ts";

const deckBasics = lessonDefinition("deck-basics");
const beatsAndBars = lessonDefinition("beats-and-bars");
const phrases = lessonDefinition("phrases");

function run(definition = deckBasics, events: readonly LessonEvent[], from: LessonState = initialLessonState(definition.id)): LessonState {
  const reduce = lessonReducer(definition);
  return events.reduce(reduce, from);
}

const seen = (observation: Observation): LessonEvent => ({ type: "observed", observation });
const tap = (overrides: Partial<Extract<Observation, { kind: "tap" }>> = {}): LessonEvent =>
  seen({ kind: "tap", offsetMs: 5, onBeat: true, onDownbeat: false, onPhraseStart: false, ...overrides });

const identity = {
  schemaVersion: 1,
  attemptId: "a1",
  learnerId: "default",
  lessonId: "deck-basics",
  mode: "lesson",
  variant: "full",
  startedAt: "2026-10-17T10:00:00.000Z",
  endedAt: "2026-10-17T10:00:20.000Z",
  inputDevice: "keyboard",
} as const;

function criterion(id: CriterionResult["id"], met: boolean): CriterionResult {
  return {
    id,
    severity: "fail",
    status: met ? "met" : "notMet",
    measured: met ? 0 : 1,
    unit: "position",
    threshold: { op: "<=", value: 0, unit: "position" },
    margin: met ? 0.5 : -1,
    evidence: [],
  };
}

function result(failed: readonly CriterionResult["id"][]): CheckResult {
  return {
    ...identity,
    endReason: "done",
    outcome: failed.length === 0 ? { kind: "passed" } : { kind: "failed", failedCriteria: failed },
    criteria: [criterion("deck-basics.fade-in", !failed.includes("deck-basics.fade-in")), criterion("deck-basics.fade-out", !failed.includes("deck-basics.fade-out"))],
    tracks: [],
    aids: { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: true },
    metrics: {},
  };
}

const graded = (outcome: CheckResult, extra: Partial<Extract<LessonEvent, { type: "graded" }>> = {}): LessonEvent => ({
  type: "graded",
  result: outcome,
  reviewTriggers: [],
  firstPass: false,
  lineFacts: { focusHistory: [], bestMarginBefore: null, retentionChange: null },
  ...extra,
});

describe("the hook", () => {
  it("starts on the first step once the track is ready, pulsing its control", () => {
    const state = run(deckBasics, [{ type: "track-ready" }]);
    expect(state.phase).toEqual({ kind: "hook", step: 0, progress: 0, named: null });
  });

  it("names the concept only after the Learner has done it, then moves to the next step", () => {
    const state = run(deckBasics, [{ type: "track-ready" }, seen({ kind: "play", deck: "A", playing: true })]);
    expect(state.phase).toEqual({ kind: "hook", step: 1, progress: 0, named: "That's PLAY. The deck spins, but it's silent." });
  });

  it("ignores what the step does not ask for", () => {
    const state = run(deckBasics, [{ type: "track-ready" }, seen({ kind: "fader", deck: "A", value: 1 })]);
    expect(state.phase).toMatchObject({ kind: "hook", step: 0 });
  });

  it("flows into practice after the last step, keeping the last concept on screen", () => {
    const state = run(deckBasics, [
      { type: "track-ready" },
      seen({ kind: "play", deck: "A", playing: true }),
      seen({ kind: "fader", deck: "A", value: 1 }),
      seen({ kind: "fader", deck: "A", value: 0 }),
    ]);
    expect(state.phase).toEqual({ kind: "practice", reps: [], ready: false, fadeOpen: false, named: "Fade out. That's a deck.", cueLadder: null });
  });

  it("counts on-beat taps, and for downbeats starts over on a tap that is not the 1", () => {
    const four = [tap(), tap(), tap(), tap()];
    const afterBeats = run(beatsAndBars, [{ type: "track-ready" }, ...four]);
    expect(afterBeats.phase).toMatchObject({ kind: "hook", step: 1, progress: 0 });

    const one = tap({ onDownbeat: true });
    const offBeatOne = tap({ onDownbeat: false });
    const reset = run(beatsAndBars, [one, offBeatOne], afterBeats);
    expect(reset.phase).toMatchObject({ kind: "hook", step: 1, progress: 0 });
    expect(run(beatsAndBars, [one, one], afterBeats).phase).toMatchObject({ kind: "practice" });
  });
});

describe("practice", () => {
  const inPractice = run(beatsAndBars, [{ type: "track-ready" }, { type: "skip-hook" }]);

  it("is ready ('this one counts') once enough recent reps were good", () => {
    const sevenGood = Array.from({ length: 7 }, () => tap());
    const state = run(beatsAndBars, [tap({ onBeat: false, offsetMs: 90 }), ...sevenGood], inPractice);
    expect(state.phase).toMatchObject({ kind: "practice", ready: true });
  });

  it("keeps only the last reps in its window", () => {
    const state = run(beatsAndBars, Array.from({ length: 12 }, () => tap()), inPractice);
    expect(state.phase).toMatchObject({ kind: "practice", reps: Array.from({ length: 8 }, () => true) });
  });

  it("counts a fade in and out as one deck-basics rep", () => {
    const practising = run(deckBasics, [{ type: "track-ready" }, { type: "skip-hook" }]);
    const state = run(deckBasics, [seen({ kind: "fader", deck: "A", value: 1 }), seen({ kind: "fader", deck: "A", value: 0 })], practising);
    expect(state.phase).toMatchObject({ kind: "practice", reps: [true], ready: true });
  });
});

describe("the Check loop", () => {
  const practising = run(deckBasics, [{ type: "track-ready" }, { type: "skip-hook" }]);

  it("can always jump to the Check, and goes to grading when the audio part ends", () => {
    const checking = run(deckBasics, [{ type: "start-check" }], practising);
    expect(checking.phase).toEqual({ kind: "check", attempt: 1 });
    expect(run(deckBasics, [{ type: "audio-ended" }], checking).phase).toEqual({ kind: "grading", answers: {} });
  });

  it("asks the questions before grading when the Lesson has them", () => {
    const checking = run(phrases, [{ type: "track-ready" }, { type: "skip-hook" }, { type: "start-check" }, { type: "audio-ended" }]);
    expect(checking.phase).toEqual({ kind: "answering", answers: {} });
    const half = run(phrases, [{ type: "answer", questionId: "breakdown", value: 4 }], checking);
    expect(half.phase).toEqual({ kind: "answering", answers: { breakdown: 4 } });
    expect(run(phrases, [{ type: "answer", questionId: "drop", value: 6 }], half).phase).toEqual({
      kind: "grading",
      answers: { breakdown: 4, drop: 6 },
    });
  });

  it("shows the result card, and retry goes straight back into the Check", () => {
    const shown = run(deckBasics, [{ type: "start-check" }, { type: "audio-ended" }, graded(result([]), { firstPass: true })], practising);
    expect(shown.phase).toMatchObject({ kind: "result", review: null, tip: null, firstPass: true });
    expect(shown.attempts).toBe(1);
    expect(run(deckBasics, [{ type: "start-check" }], shown).phase).toEqual({ kind: "check", attempt: 2 });
  });

  it("does not count a void attempt and says why", () => {
    const state = run(deckBasics, [{ type: "start-check" }, { type: "audio-ended" }, { type: "voided", reason: "tabHidden" }], practising);
    expect(state.phase).toEqual({ kind: "void", reason: "tabHidden", message: null });
    expect(state.attempts).toBe(0);
  });

  const failFadeOut = [{ type: "start-check" }, { type: "audio-ended" }, graded(result(["deck-basics.fade-out"]))] as const;

  it("gives one authored tip when the same criterion misses twice in a row, once per session", () => {
    const once = run(deckBasics, failFadeOut, practising);
    expect(once.phase).toMatchObject({ kind: "result", tip: null });
    const twice = run(deckBasics, failFadeOut, once);
    expect(twice.phase).toMatchObject({ kind: "result", tip: "Finish with the fader all the way down (S)." });
    const thrice = run(deckBasics, failFadeOut, twice);
    expect(thrice.phase).toMatchObject({ kind: "result", tip: null });
  });

  it("starts the miss count over after a met result", () => {
    const passed = [{ type: "start-check" }, { type: "audio-ended" }, graded(result([]))] as const;
    const state = run(deckBasics, [...failFadeOut, ...passed, ...failFadeOut], practising);
    expect(state.phase).toMatchObject({ kind: "result", tip: null });
  });

  it("surfaces a Review suggestion from the Skill profile, and never a tip on the same card", () => {
    const twiceThenReview = [
      ...failFadeOut,
      { type: "start-check" },
      { type: "audio-ended" },
      graded(result(["deck-basics.fade-out"]), { reviewTriggers: [{ criterionId: "deck-basics.fade-out", lessonId: "deck-basics" }] }),
    ] as const;
    const state = run(deckBasics, twiceThenReview, practising);
    expect(state.phase).toMatchObject({ kind: "result", tip: null, review: { criterionId: "deck-basics.fade-out", lessonId: "deck-basics" } });
    expect(run(deckBasics, [{ type: "review-declined" }], state).phase).toMatchObject({ kind: "result", review: null });
  });

  it("shows a recording failure as not counted, with the message, ready to go again", () => {
    const state = run(deckBasics, [{ type: "start-check" }, { type: "audio-ended" }, { type: "grading-failed", message: "No meters." }], practising);
    expect(state.phase).toEqual({ kind: "void", reason: "recordingFailed", message: "No meters." });
    expect(state.attempts).toBe(0);
    expect(run(deckBasics, [{ type: "start-check" }], state).phase).toEqual({ kind: "check", attempt: 2 });
  });

  it("tells a result the profile refused apart from a recording failure: the attempt was recorded and graded", () => {
    const state = run(deckBasics, [{ type: "start-check" }, { type: "audio-ended" }, { type: "profile-refused", message: "criteria.x: bad id" }], practising);
    expect(state.phase).toEqual({ kind: "void", reason: "profileRefused", message: "criteria.x: bad id" });
    expect(state.attempts).toBe(0);
    expect(run(deckBasics, [{ type: "profile-refused", message: "late" }], practising).phase).toEqual(practising.phase);
  });

  it("keeps the last 3 margins of each graded criterion this session, for the Coach line", () => {
    const passed = [{ type: "start-check" }, { type: "audio-ended" }, graded(result([]))] as const;
    const state = run(deckBasics, [...failFadeOut, ...failFadeOut, ...passed, ...passed], practising);
    expect(state.margins["deck-basics.fade-out"]).toEqual([-1, 0.5, 0.5]);
    expect(state.margins["deck-basics.fade-in"]).toEqual([0.5, 0.5, 0.5]);
  });

  it("keeps the Coach facts for the card it shows them on", () => {
    const facts = { focusHistory: [-1], bestMarginBefore: 0.2, retentionChange: "passed, next in 1 day" };
    const state = run(deckBasics, [{ type: "start-check" }, { type: "audio-ended" }, graded(result([]), { lineFacts: facts })], practising);
    expect(state.phase).toMatchObject({ kind: "result", lineFacts: facts });
  });

  it("says so when the Check cannot record, instead of waiting in the Check forever", () => {
    const checking = run(deckBasics, [{ type: "start-check" }], practising);
    const state = run(deckBasics, [{ type: "check-failed", message: "The recorder did not start." }], checking);
    expect(state.phase).toEqual({ kind: "void", reason: "recordingFailed", message: "The recorder did not start." });
    expect(run(deckBasics, [{ type: "check-failed", message: "late" }], practising).phase).toEqual(practising.phase);
  });

  it("goes back to practice on request", () => {
    const shown = run(deckBasics, failFadeOut, practising);
    expect(run(deckBasics, [{ type: "practice-again" }], shown).phase).toMatchObject({ kind: "practice", reps: [], ready: false });
  });
});

describe("loading", () => {
  it("says why when no track can be found", () => {
    const state = run(deckBasics, [{ type: "track-failed", message: "No track could load." }]);
    expect(state.phase).toEqual({ kind: "unavailable", message: "No track could load." });
  });
});
