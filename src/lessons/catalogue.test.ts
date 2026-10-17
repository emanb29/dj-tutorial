import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, event, frames, MUSIC, SILENT, taps } from "@checks/testing/synthetic.ts";
import type { Attempt, ControlEvent } from "@shared/attempt.ts";
import { LESSONS, lessonDefinition, checkSpecFor, unlocksAfter } from "./catalogue.ts";
import { SYNTHETIC_HOUSE, syntheticLessonTrack } from "./synthetic-track.ts";
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
    expect(LESSONS.map((lesson) => lesson.id)).toEqual(["deck-basics", "beats-and-bars", "phrases"]);
    for (const lesson of LESSONS) expect(lesson.hook.length).toBeGreaterThan(0);
  });

  it("grows the controller: each Lesson's unlocks add to the ones before", () => {
    expect([...unlocksAfter(["deck-basics"])]).toEqual(["A.play", "A.channel-fader", "master-level", "master-meter"]);
    expect([...unlocksAfter(["deck-basics", "beats-and-bars"])]).toContain("tap");
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
    expect(plan.cues.map((cue) => cue.caption)).toEqual(["Count in: 1, 2, 3, 4", "Tap every beat (Space)", "Now only the 1"]);
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

  it("taps 64 bars from bar 9 after a 2-bar lead-in, then asks for the breakdown and the drop", () => {
    expect(plan.startPos).toBeCloseTo(barStart(track.grid, 7));
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

  it("grades both halves together as one Check: 5 of 8 phrase starts across the halves pass", () => {
    const starts = Array.from({ length: 8 }, (_, index) => heard(plan, firstPhrase + index * 32 * BEAT));
    const end = heard(plan, phraseStart(track.grid, 10) + BEAT);
    // 3 in the first half, 2 in the second: neither half alone has 5.
    const someTaps = [starts[0], starts[1], starts[2], starts[5], starts[6]].filter((t) => t !== undefined);
    const passed = grade(definition, plan, recorded(track, plan, { events: taps(someTaps), answers: { breakdown: 4, drop: 6 } }), end);
    expect(passed.outcome).toEqual({ kind: "passed" });
    // One false tap in each half is two in the Check: too many.
    const falseTaps = [heard(plan, firstPhrase + 16 * BEAT), heard(plan, firstPhrase + (4 * 32 + 16) * BEAT)];
    const failed = grade(definition, plan, recorded(track, plan, { events: taps([...starts, ...falseTaps].sort((a, b) => a - b)), answers: { breakdown: 4, drop: 6 } }), end);
    expect(failed.outcome).toEqual({ kind: "failed", failedCriteria: ["phrases.phrase-taps"] });
  });

  it("cannot run on a track with no named breakdown and drop", () => {
    expect(definition.trackProblems({ ...track, sections: [] })).not.toEqual([]);
    expect(definition.trackProblems(track)).toEqual([]);
  });
});
