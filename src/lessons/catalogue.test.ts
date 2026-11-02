import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, event, frames, MUSIC, SILENT, taps } from "@checks/testing/synthetic.ts";
import type { Attempt, ControlEvent } from "@shared/attempt.ts";
import { LESSONS, lessonDefinition, checkSpecFor, lessonUnlocks, unlocksAfter } from "./catalogue.ts";
import { SYNTHETIC_HOUSE, syntheticLessonTrack } from "./synthetic-track.ts";
import { phrasePreviewSpan, previewPhraseAt } from "./phrase-preview.ts";
import { barStart, beatSec, phraseStart } from "./track.ts";
import type { CheckPlan, LessonDefinition, LessonTrack } from "./types.ts";

const track = syntheticLessonTrack(SYNTHETIC_HOUSE);
const BEAT = beatSec(track.grid);
/** The deck starts playing at this heard time in every attempt below. */
const PLAY_AT = 100;

/** Heard time of track position `pos` when the deck plays from `plan.startPos` at PLAY_AT. */
const heard = (plan: CheckPlan, pos: number) => PLAY_AT + (pos - plan.startPos);

function recorded(lessonTrack: LessonTrack, plan: CheckPlan, overrides: Partial<Attempt>): Attempt {
  return attempt({
    decks: { A: { trackId: lessonTrack.trackId, playhead: { segments: [{ fromCtx: PLAY_AT, pos: plan.startPos, rate: 1 }] } } },
    grids: { [lessonTrack.trackId]: lessonTrack.grid },
    phraseMarkers: { [lessonTrack.trackId]: lessonTrack.phraseStarts },
    initialMixer: { A: channel({ channelFader: plan.faderAtStart }), B: channel(), crossfader: 0.5 },
    ...overrides,
  });
}

function grade(definition: LessonDefinition, plan: CheckPlan, recordedAttempt: Attempt, to: number) {
  const spec = checkSpecFor(definition, track, plan, recordedAttempt, { window: { from: PLAY_AT - 1, to }, passedLessons: [] });
  return runCheck(spec, recordedAttempt);
}

describe("the Lesson catalogue for Lessons 1–3", () => {
  it("has deck-basics, beats-and-bars and phrases, in order, each with a hook of hands-on steps", () => {
    expect(LESSONS.map((lesson) => lesson.id).slice(0, 3)).toEqual(["deck-basics", "beats-and-bars", "phrases"]);
    for (const lesson of LESSONS) expect(lesson.hook.length).toBeGreaterThan(0);
  });

  it("grows the controller: each Lesson's unlocks add to the ones before", () => {
    expect([...unlocksAfter(["deck-basics"])]).toEqual(["A.play", "A.channel-fader", "master-level", "master-meter"]);
    expect([...unlocksAfter(["deck-basics", "beats-and-bars"])]).toContain("tap");
  });

  it("keeps HEADPHONES LEVEL unlocked in every Lesson, hook included: it is a listening volume, not a skill", () => {
    for (const lesson of LESSONS) {
      expect(lessonUnlocks(lesson, [], 0).has("headphone-level")).toBe(true);
      expect(lessonUnlocks(lesson, [], null).has("headphone-level")).toBe(true);
    }
  });

  it("keeps the hook's controls unlocked after the hook, so Count phrases taps on the FLX4 before Beats and bars is passed", () => {
    const phrases = lessonDefinition("phrases");
    expect(lessonUnlocks(phrases, ["deck-basics"], null).has("tap")).toBe(true);
    expect(lessonUnlocks(phrases, ["deck-basics"], 0).has("tap")).toBe(true);
  });

  it("hands over a Lesson's controls step by step in the hook, and all of them after it", () => {
    for (const lesson of LESSONS) {
      const after = lessonUnlocks(lesson, [], null);
      for (const control of [...lesson.unlocks, ...lesson.hook.map((step) => step.control)]) expect(after.has(control)).toBe(true);
      const first = lessonUnlocks(lesson, [], 0);
      const later = lesson.hook.slice(1).map((step) => step.control).filter((control) => control !== lesson.hook[0]?.control && !(lesson.hook[0]?.reveals ?? []).includes(control));
      for (const control of later) expect(first.has(control)).toBe(false);
    }
  });
});

describe("deck-basics", () => {
  const definition = lessonDefinition("deck-basics");
  const plan = definition.planCheck(track);

  it("cues the deck at the groove (bar 17), stopped, fader down, and ends when the Learner fades out", () => {
    expect(plan.startPos).toBeCloseTo(barStart(track.grid, 17));
    expect(plan).toMatchObject({ autoPlay: false, faderAtStart: 0, endWhen: { kind: "faded-out" } });
  });

  it("passes a fade in within 4 bars of Play and a fade out to silence", () => {
    const fadeIn = PLAY_AT + 1;
    const fadeOut = PLAY_AT + 5;
    const levels = (t: number) => (t >= PLAY_AT ? MUSIC : SILENT);
    const result = grade(
      definition,
      plan,
      recorded(track, plan, {
        events: [event(fadeIn, "channelFader", 1, "A"), event(fadeOut, "channelFader", 0, "A")],
        meters: { master: frames(PLAY_AT - 1, PLAY_AT + 6, (t) => (t >= fadeIn && t < fadeOut ? MUSIC : SILENT)), A: frames(PLAY_AT - 1, PLAY_AT + 6, levels) },
      }),
      PLAY_AT + 6,
    );
    expect(result.outcome).toEqual({ kind: "passed" });
  });
});

describe("beats-and-bars", () => {
  const definition = lessonDefinition("beats-and-bars");
  const plan = definition.planCheck(track);
  const beatsFrom = barStart(track.grid, 9);
  const downbeatsFrom = barStart(track.grid, 17);

  it("counts in for one bar, then 8 bars of every beat and 8 bars of downbeats, then stops by itself", () => {
    expect(plan.startPos).toBeCloseTo(barStart(track.grid, 8));
    expect(plan).toMatchObject({ autoPlay: true, faderAtStart: 1 });
    expect(plan.endWhen).toEqual({ kind: "position", pos: barStart(track.grid, 25) + BEAT });
    expect(plan.cues.map((cue) => cue.caption)).toEqual([
      "Count in: 1, 2, 3, 4",
      "Tap every beat (Space)",
      "Every beat · switch in 2 bars",
      "Switch in 1 bar: 4",
      "Switch in 1 bar: 4 · 3",
      "Switch in 1 bar: 4 · 3 · 2",
      "Switch in 1 bar: 4 · 3 · 2 · 1",
      "Only the 1 now",
    ]);
  });

  // Maintainer feedback: the switch from every beat to only the 1 came without enough warning.
  it("warns of the switch two bars ahead, then counts the last bar down on its beats", () => {
    const switchPos = barStart(track.grid, 17);
    const warnings = plan.cues.slice(2);
    const beatsBefore = [8, 4, 3, 2, 1, 0.5];
    expect(warnings).toHaveLength(beatsBefore.length);
    warnings.forEach((cue, index) => {
      expect(cue.fromPos).toBeCloseTo(switchPos - (beatsBefore[index] ?? Number.NaN) * BEAT, 9);
    });
    expect(warnings.map((cue) => cue.countdown === true)).toEqual([false, true, true, true, true, true]);
  });

  const everyBeat = Array.from({ length: 32 }, (_, index) => heard(plan, beatsFrom + index * BEAT));
  const everyOne = Array.from({ length: 8 }, (_, index) => heard(plan, downbeatsFrom + index * 4 * BEAT));
  const end = heard(plan, barStart(track.grid, 25) + BEAT);

  it("passes taps on every beat, then on every 1, a little late", () => {
    const tapEvents: ControlEvent[] = taps([...everyBeat, ...everyOne].map((t) => t + 0.015));
    const result = grade(definition, plan, recorded(track, plan, { events: tapEvents }), end);
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("fails the downbeats when the Learner keeps tapping every beat", () => {
    const everyBeatAgain = Array.from({ length: 32 }, (_, index) => heard(plan, downbeatsFrom + index * BEAT));
    const result = grade(definition, plan, recorded(track, plan, { events: taps([...everyBeat, ...everyBeatAgain]) }), end);
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["beats-and-bars.downbeat-taps"] });
  });

  it("finds the sections after the Check's own cue, not in the practice still heard as the attempt starts", () => {
    // The attempt starts while practice is heard just before bar 9; the Check's cue lands 50 ms later.
    const practice = { fromCtx: PLAY_AT - 0.05, pos: beatsFrom - BEAT / 2 - 0.01, rate: 1 };
    const segments = [practice, { fromCtx: PLAY_AT, pos: plan.startPos, rate: 1 }];
    const tapEvents = taps([...everyBeat, ...everyOne]);
    const result = grade(definition, plan, recorded(track, plan, { events: tapEvents, decks: { A: { trackId: track.trackId, playhead: { segments } } } }), end);
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("voids an attempt whose deck stopped before the downbeat section, rather than failing every target", () => {
    const segments = [
      { fromCtx: PLAY_AT, pos: plan.startPos, rate: 1 },
      { fromCtx: heard(plan, downbeatsFrom - 4 * BEAT), pos: downbeatsFrom - 4 * BEAT, rate: 0 },
    ];
    const result = grade(definition, plan, recorded(track, plan, { events: taps(everyBeat), decks: { A: { trackId: track.trackId, playhead: { segments } } } }), end);
    expect(result.outcome).toEqual({ kind: "void", reason: "sectionNotHeard" });
  });
});

describe("phrases", () => {
  const definition = lessonDefinition("phrases");
  const plan = definition.planCheck(track);
  // Phrase 2 (bar 9) to phrase 9 (bar 65): the breakdown is phrase 5 of the track, the 4th tapped.
  const firstPhrase = phraseStart(track.grid, 2);

  it("taps 64 bars from bar 9 after a whole phrase from its start, then asks for the breakdown and the drop", () => {
    expect(plan.startPos).toBeCloseTo(barStart(track.grid, 1));
    expect(plan.firstPhraseAction).toBeCloseTo(firstPhrase, 9);
    expect(plan.endWhen).toEqual({ kind: "position", pos: phraseStart(track.grid, 10) + BEAT });
    expect(definition.questions.map((question) => [question.id, question.options])).toEqual([
      ["breakdown", 8],
      ["drop", 8],
    ]);
  });

  it("passes taps on each phrase start and the right sections named", () => {
    const starts = Array.from({ length: 8 }, (_, index) => heard(plan, firstPhrase + index * 32 * BEAT));
    const end = heard(plan, phraseStart(track.grid, 10) + BEAT);
    const result = grade(definition, plan, recorded(track, plan, { events: taps(starts), answers: { breakdown: 4, drop: 6 } }), end);
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("splits the 64 bars into two 32-bar halves with a halfway checkpoint, and the music never stops", () => {
    const halfway = phraseStart(track.grid, 6);
    const checkpoints = plan.cues.filter((cue) => cue.checkpoint === true);
    expect(checkpoints).toEqual([{ fromPos: halfway + BEAT, caption: "Halfway: keep tapping each phrase", checkpoint: true }]);
    // After a few bars the caption goes back to the task; the attempt itself runs on to the end.
    const afterCheckpoint = plan.cues.find((cue) => cue.fromPos > halfway + BEAT);
    expect(afterCheckpoint).toEqual({ fromPos: halfway + 4 * 4 * BEAT, caption: "Tap each new phrase (Space)" });
    expect(plan.endWhen).toEqual({ kind: "position", pos: phraseStart(track.grid, 10) + BEAT });
    // Under a minute per half: the Learner gets a tick about every 62 s of a 124 s attempt.
    expect(halfway - firstPhrase).toBeCloseTo(32 * 4 * BEAT);
  });

  it("grades both halves together as one Check: 6 of 8 phrase starts across the halves pass", () => {
    const starts = Array.from({ length: 8 }, (_, index) => heard(plan, firstPhrase + index * 32 * BEAT));
    const end = heard(plan, phraseStart(track.grid, 10) + BEAT);
    // 3 in each half: neither half alone has 6.
    const someTaps = [starts[0], starts[1], starts[2], starts[5], starts[6], starts[7]].filter((t) => t !== undefined);
    const passed = grade(definition, plan, recorded(track, plan, { events: taps(someTaps), answers: { breakdown: 4, drop: 6 } }), end);
    expect(passed.outcome).toEqual({ kind: "passed" });
    // One false tap in each half is two in the Check: too many.
    const falseTaps = [heard(plan, firstPhrase + 16 * BEAT), heard(plan, firstPhrase + (4 * 32 + 16) * BEAT)];
    const failed = grade(definition, plan, recorded(track, plan, { events: taps([...starts, ...falseTaps].sort((a, b) => a - b)), answers: { breakdown: 4, drop: 6 } }), end);
    expect(failed.outcome).toEqual({ kind: "failed", failedCriteria: ["phrases.phrase-taps"] });
  });

  // Maintainer feedback: no clear start to the first phrase, so one early miscount ruined the rest.
  it("counts in to phrase 1 like Lesson 2's switch: 2 bars ahead, the last bar on its beats, then TAP", () => {
    // A phrase to count along with first, from its start.
    expect(plan.cues[0]).toEqual({ fromPos: plan.startPos, caption: "Count along: 8 bars, then phrase 1" });
    expect(plan.cues.slice(1, 8).map((cue) => [cue.caption, cue.countdown === true])).toEqual([
      ["Phrase 1 starts in 2 bars", false],
      ["1 bar: 4", true],
      ["1 bar: 4 · 3", true],
      ["1 bar: 4 · 3 · 2", true],
      ["1 bar: 4 · 3 · 2 · 1", true],
      ["TAP — phrase 1!", true],
      ["Tap each new phrase (Space)", false],
    ]);
    const beatsBefore = [8, 4, 3, 2, 1, 0.5, -4];
    plan.cues.slice(1, 8).forEach((cue, index) => {
      expect(cue.fromPos).toBeCloseTo(firstPhrase - (beatsBefore[index] ?? Number.NaN) * BEAT, 9);
    });
  });

  it("after phrase 1 shows no count, only a nudge for a tap 2 beats or more off every phrase start", () => {
    expect(plan.cues.filter((cue) => cue.fromPos > firstPhrase).map((cue) => cue.caption)).toEqual([
      "Tap each new phrase (Space)",
      "Halfway: keep tapping each phrase",
      "Tap each new phrase (Space)",
    ]);
    expect(plan.farTapCue).toEqual({ fromPos: firstPhrase + BEAT, beats: 2, bars: 2, caption: "Count from the last change" });
  });

  it("starts phrase 1 on a change in the music where the track has one: an Original's breakdown", () => {
    // Lamplight Moths' layout: intro 1–4, build 5–6, drop 7–10, breakdown 11–12, build 13–14, drop 15–18, outro 19–22.
    const original: LessonTrack = {
      ...track,
      phraseStarts: Array.from({ length: 22 }, (_, index) => phraseStart(track.grid, index + 1)),
      sections: [
        { name: "intro", phrase: 1 },
        { name: "build", phrase: 5 },
        { name: "drop", phrase: 7 },
        { name: "breakdown", phrase: 11 },
        { name: "build", phrase: 13 },
        { name: "drop", phrase: 15 },
        { name: "outro", phrase: 19 },
      ],
    };
    const originalPlan = definition.planCheck(original);
    // Not phrase 8, mid-drop with nothing to hear: phrase 11, where the kick leaves.
    expect(originalPlan.startPos).toBeCloseTo(phraseStart(track.grid, 10), 9);
    const window = { from: 0, to: 1e6 };
    const task = definition.taskFor(original, originalPlan, recorded(original, originalPlan, {}), window);
    expect(task).toMatchObject({ lessonId: "phrases", sections: { breakdown: 1, drop: 5 } });
    expect(definition.practiceStart(original)).toBeCloseTo(phraseStart(track.grid, 10), 9);
  });

  // Maintainer feedback: naming the sections from memory of the count, after 64 bars, tested memory, not ears.
  it("asks for the breakdown and the drop in plain words, each phrase playable before choosing it", () => {
    expect(definition.questions).toEqual([
      { id: "breakdown", caption: "Which phrase was the breakdown? (the kick drops out)", options: 8, previews: "phrases" },
      { id: "drop", caption: "Which phrase was the drop? (the kick slams back)", options: 8, previews: "phrases" },
    ]);
    // The chips are the tapped window's phrases.
    expect(plan.phrasePreviews?.starts).toHaveLength(8);
    plan.phrasePreviews?.starts.forEach((start, index) => {
      expect(start).toBeCloseTo(phraseStart(track.grid, 2 + index), 9);
    });
    expect(plan.phrasePreviews?.end).toBeCloseTo(phraseStart(track.grid, 10), 9);
  });

  // Maintainer feedback: 2 bars of a phrase alone are unfair; a breakdown or a drop is a change, heard
  // only against what came before it.
  it("plays each phrase's ▶ from 2 bars before it, phrase 1 from its count-in, on to a bar past the window", () => {
    const previews = plan.phrasePreviews;
    if (previews === undefined) throw new Error("phrases previews its phrases");
    const bar = 4 * BEAT;
    // Phrase 1: its count-in, 2 bars before the first tapped phrase.
    expect(phrasePreviewSpan(previews, 1)?.fromPos).toBeCloseTo(firstPhrase - 2 * bar, 9);
    for (let phrase = 2; phrase <= 8; phrase += 1) {
      expect(phrasePreviewSpan(previews, phrase)?.fromPos).toBeCloseTo(phraseStart(track.grid, phrase + 1) - 2 * bar, 9);
    }
    // Every preview runs on to the window's end plus a bar, unless stopped.
    for (let phrase = 1; phrase <= 8; phrase += 1) {
      expect(phrasePreviewSpan(previews, phrase)?.untilPos).toBeCloseTo(phraseStart(track.grid, 10) + bar, 9);
    }
    expect(phrasePreviewSpan(previews, 9)).toBeNull();
    expect(phrasePreviewSpan(previews, 0)).toBeNull();
  });

  it("starts phrase 1's ▶ as far back as the track allows, and caps at the track's end", () => {
    const bar = 4 * BEAT;
    // A grid whose phrase 2 starts a bar in: its count-in would start before the track does.
    const early = { ...track, grid: { ...track.grid, firstBeat: bar - phraseStart(track.grid, 2) + track.grid.firstBeat } };
    const earlyPreviews = definition.planCheck(early).phrasePreviews;
    expect(earlyPreviews?.from[0]).toBe(0);
    // A track that ends half a bar past the window: the cap is its end.
    const end = plan.phrasePreviews?.end ?? 0;
    expect(definition.planCheck({ ...track, durationSec: end + bar / 2 }).phrasePreviews?.until).toBeCloseTo(end + bar / 2, 9);
  });

  it("names the phrase and bar a preview plays at, none before phrase 1 or past the window", () => {
    const previews = plan.phrasePreviews;
    if (previews === undefined) throw new Error("phrases previews its phrases");
    const bar = 4 * BEAT;
    expect(previewPhraseAt(previews, firstPhrase - bar)).toBeNull();
    expect(previewPhraseAt(previews, firstPhrase)).toEqual({ phrase: 1, bar: 1 });
    expect(previewPhraseAt(previews, firstPhrase + 2.5 * bar)).toEqual({ phrase: 1, bar: 3 });
    expect(previewPhraseAt(previews, phraseStart(track.grid, 4) - 0.01)).toEqual({ phrase: 2, bar: 8 });
    expect(previewPhraseAt(previews, phraseStart(track.grid, 4))).toEqual({ phrase: 3, bar: 1 });
    expect(previewPhraseAt(previews, phraseStart(track.grid, 10) - 0.01)).toEqual({ phrase: 8, bar: 8 });
    expect(previewPhraseAt(previews, phraseStart(track.grid, 10))).toBeNull();
  });

  it("cannot run on a track with no named breakdown and drop", () => {
    expect(definition.trackProblems({ ...track, sections: [] })).not.toEqual([]);
    expect(definition.trackProblems(track)).toEqual([]);
  });
});
