// Lessons 4–7 as data: each plan sets the decks up as the Lesson needs, and an attempt recorded on
// that plan grades as the Check should. Attempts are synthetic (src/checks/testing/synthetic.ts).
import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, event, frames, MUSIC, SILENT, taps, type FrameLevels } from "@checks/testing/synthetic.ts";
import type { Attempt, ControlEvent, CuePointSet, LessonId, PlayheadSegment } from "@shared/attempt.ts";
import { checkSpecFor, LESSONS, lessonDefinition, readyUsedIn, unlocksAfter, withPlannedGrids } from "./catalogue.ts";
import { SYNTHETIC_HOUSE, syntheticLessonTrack } from "./synthetic-track.ts";
import { barStart, beatSec, phraseStart, sliceTrack } from "./track.ts";
import type { CheckPlan, LessonDefinition, LessonTrack } from "./types.ts";

const track: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6 };
const BEAT = beatSec(track.grid);
const BAR = 4 * BEAT;
const PLAY_AT = 100;

const heardA = (plan: CheckPlan, pos: number) => PLAY_AT + (pos - plan.startPos);

function recorded(plan: CheckPlan, overrides: Partial<Attempt>, deckB: readonly PlayheadSegment[] | null = null): Attempt {
  return attempt({
    decks: {
      A: { trackId: track.trackId, playhead: { segments: [{ fromCtx: PLAY_AT, pos: plan.startPos, rate: 1 }] } },
      ...(deckB === null ? {} : { B: { trackId: track.trackId, playhead: { segments: deckB } } }),
    },
    grids: { [track.trackId]: track.grid },
    phraseMarkers: { [track.trackId]: track.phraseStarts },
    initialMixer: {
      A: channel({ channelFader: plan.faderAtStart }),
      B: channel({ channelFader: plan.deckB?.fader ?? 0 }),
      crossfader: 0.5,
    },
    ...overrides,
  });
}

function grade(definition: LessonDefinition, plan: CheckPlan, recordedAttempt: Attempt, to: number, passedLessons: readonly LessonId[] = []) {
  const spec = checkSpecFor(definition, track, plan, recordedAttempt, { window: { from: PLAY_AT - 1, to }, passedLessons });
  return runCheck(spec, recordedAttempt);
}

const levels = (before: FrameLevels, after: FrameLevels, at: number) => (t: number) => (t < at ? before : after);

describe("the Lesson catalogue for Lessons 1–7", () => {
  it("adds gain-staging, headphone-cue, cue-point and cut-on-phrase after the first three, in catalogue order", () => {
    expect(LESSONS.map((lesson) => lesson.id).slice(0, 7)).toEqual(["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase"]);
  });

  it("grows the controller with each Lesson's controls", () => {
    const after = unlocksAfter(["deck-basics", "gain-staging", "headphone-cue", "cue-point"]);
    for (const control of ["A.trim", "B.trim", "A.level-meter", "B.level-meter", "B.play", "B.channel-fader", "B.headphone-cue", "cue-mix", "A.cue", "A.jog"] as const) {
      expect(after.has(control)).toBe(true);
    }
    // Pitch bend waits for nudge-phase: the cue-point jog only searches.
    expect(after.has("A.jog-bend")).toBe(false);
  });

  it("asks for headphones in the Lessons that use the headphone cue", () => {
    expect(LESSONS.slice(0, 7).filter((lesson) => lesson.headphones === true).map((lesson) => lesson.id)).toEqual(["headphone-cue", "cue-point", "cut-on-phrase"]);
  });

  it("has an authored tip for every Lesson criterion of Lessons 4–7", () => {
    const criteria = {
      "gain-staging": ["gain-staging.trim-A", "gain-staging.trim-B", "gain-staging.loud-match"],
      "headphone-cue": ["headphone-cue.cued-taps", "headphone-cue.b-off-master"],
      "cue-point": ["cue-point.cue-on-downbeat"],
      "cut-on-phrase": ["cut-on-phrase.cut-start", "cut-on-phrase.cut-tight", "cut-on-phrase.cued-before", "cut-on-phrase.loud-jump"],
    } as const;
    for (const [lessonId, ids] of Object.entries(criteria)) {
      const tips = lessonDefinition(lessonId as keyof typeof criteria).tips;
      for (const id of ids) expect(tips[id]?.length ?? 0, id).toBeGreaterThan(0);
    }
  });
});

describe("Ready (R)", () => {
  it("is used in gain-staging's practice and Check, cue-point's Check, and where a set-up step waits for it", () => {
    const used = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, readyUsedIn(lesson, track)]));
    expect(used["gain-staging"]).toEqual({ practice: true, check: true });
    expect(used["cue-point"]).toEqual({ practice: false, check: true });
    // cut-on-phrase sets up off the clock, in practice and in the Check.
    expect(used["cut-on-phrase"]).toEqual({ practice: true, check: true });
    for (const id of ["deck-basics", "beats-and-bars", "phrases", "headphone-cue"]) expect(used[id]).toEqual({ practice: false, check: false });
  });
});

describe("gain-staging", () => {
  const definition = lessonDefinition("gain-staging");
  const plan = definition.planCheck(track);
  const readyA = PLAY_AT + 6;
  const readyB = PLAY_AT + 12;
  const end = readyB + 8 * BAR + 0.1;
  const bPlayhead = [{ fromCtx: PLAY_AT, pos: plan.deckB?.pos ?? 0, rate: 1 }];
  const readies: ControlEvent[] = [event(readyA, "ready", 1, "A"), event(readyB, "ready", 1, "B")];

  it("gives a full minute to set both trims on top of the 8-bar hold, so a slow trim never squeezes the hold", () => {
    expect(plan.timeoutSec).toBeCloseTo(60 + 8 * BAR);
  });

  it("starts both decks off the zone: A clipping, B too quiet, B's fader down, and loops one steady phrase", () => {
    // The synthetic groove peaks at −6 dBFS: +9 dB on A clips (+3), −9 dB on B is quiet (−15).
    expect(plan.deckA?.trim).toBe(1);
    expect(plan.deckB).toMatchObject({ fader: 0, play: true, trim: -0.375 });
    expect(plan).toMatchObject({ autoPlay: true, faderAtStart: 1, endWhen: { kind: "ready-windows", decks: ["A", "B"], bars: 8 } });
    expect(plan.loop).toEqual({ atPos: plan.startPos + 8 * BAR, reset: "positions" });
    expect(plan.readyCues).toHaveLength(3);
  });

  it("leaves B paused for the hook, so the first press of , plays it", () => {
    expect(definition.practiceDecks?.(track).B).toMatchObject({ play: false, fader: 0 });
  });

  it("passes both decks peaking in the zone after Ready, at the same loudness", () => {
    const inZone = { peak: -3, momentary: -14 };
    const result = grade(
      definition,
      plan,
      recorded(plan, { events: readies, meters: { master: frames(PLAY_AT - 1, end, () => inZone), A: frames(PLAY_AT - 1, end, () => inZone), B: frames(PLAY_AT - 1, end, () => inZone) } }, bPlayhead),
      end,
    );
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("fails a deck still clipping after Ready, and decks 3 dB apart", () => {
    const meters = {
      master: frames(PLAY_AT - 1, end, () => MUSIC),
      A: frames(PLAY_AT - 1, end, () => ({ peak: 0.5, momentary: -11 })),
      B: frames(PLAY_AT - 1, end, () => ({ peak: -3, momentary: -14 })),
    };
    const result = grade(definition, plan, recorded(plan, { events: readies, meters }, bPlayhead), end);
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["gain-staging.trim-A", "gain-staging.loud-match"] });
  });
});

describe("headphone-cue", () => {
  const definition = lessonDefinition("headphone-cue");
  const plan = definition.planCheck(track);
  const offset = (plan.deckB?.pos ?? 0) - plan.startPos;
  const tapBar = 9;
  const bPlayhead = [{ fromCtx: PLAY_AT, pos: plan.deckB?.pos ?? 0, rate: 1 }];
  /** Heard time of B's beat `index` from bar 9 on B's own grid. */
  const bBeat = (index: number) => PLAY_AT + (barStart(track.grid, tapBar) + index * BEAT - (plan.deckB?.pos ?? 0));
  const end = heardA(plan, barStart(track.grid, tapBar + 8) + BEAT);
  const meters = { master: frames(PLAY_AT - 1, end, () => MUSIC), A: frames(PLAY_AT - 1, end, () => MUSIC), B: frames(PLAY_AT - 1, end, () => MUSIC) };

  it("plays B a third of a beat off A, fader down, CUE off: only the headphone ear can find its kick", () => {
    expect(offset).toBeCloseTo(BEAT / 3, 9);
    expect(plan.deckB).toMatchObject({ fader: 0, play: true, headphoneCue: false });
    expect(definition.tapDeck).toBe("B");
    expect(plan.startPos).toBeCloseTo(barStart(track.grid, tapBar - 4));
    expect(plan.endWhen).toEqual({ kind: "position", pos: barStart(track.grid, tapBar + 8) + BEAT });
  });

  it("passes taps on B's 32 beats with CUE B on and B's fader down", () => {
    const events = [event(PLAY_AT + 1, "cueMonitor", 1, "B"), ...taps(Array.from({ length: 32 }, (_, index) => bBeat(index) + 0.01))];
    expect(grade(definition, plan, recorded(plan, { events, meters }, bPlayhead), end).outcome).toEqual({ kind: "passed" });
  });

  it("grades only the Check's own play-through of B: practice that played the same bars first does not leak in", () => {
    const bPos = plan.deckB?.pos ?? 0;
    // Practice played B through the whole tap section a minute earlier (no taps then), then the Check
    // cued B back to its start and played it.
    const withPractice: PlayheadSegment[] = [
      { fromCtx: PLAY_AT - 60, pos: bPos, rate: 1 },
      { fromCtx: PLAY_AT - 20, pos: bPos + 40, rate: 0 },
      { fromCtx: PLAY_AT - 0.5, pos: bPos, rate: 0 },
      ...bPlayhead,
    ];
    const events = [event(PLAY_AT + 1, "cueMonitor", 1, "B"), ...taps(Array.from({ length: 32 }, (_, index) => bBeat(index) + 0.01))];
    const recordedAttempt = recorded(plan, { events, meters }, withPractice);
    const task = definition.taskFor(track, plan, recordedAttempt, { from: PLAY_AT - 1, to: end });
    const checkOnly = definition.taskFor(track, plan, recorded(plan, { events, meters }, bPlayhead), { from: PLAY_AT - 1, to: end });
    expect(task).toEqual(checkOnly);
    expect(task).toMatchObject({ tapSection: { from: expect.toSatisfy((from: number) => from > PLAY_AT) as unknown } });
    expect(grade(definition, plan, recordedAttempt, end).outcome).toEqual({ kind: "passed" });
  });

  it("fails taps on A's beats (the speakers), and fails without CUE on B", () => {
    const onA = taps(Array.from({ length: 32 }, (_, index) => heardA(plan, barStart(track.grid, tapBar) + index * BEAT)));
    const result = grade(definition, plan, recorded(plan, { events: onA, meters }, bPlayhead), end);
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["headphone-cue.cued-taps", "headphone-cue.b-off-master"] });
  });
});

describe("cue-point", () => {
  const definition = lessonDefinition("cue-point");
  const plan = definition.planCheck(track);
  const slices = (plan.slices ?? []).map((slice, index) => sliceTrack(track, slice, index));

  it("runs on three slices of the track, each starting between beats, and ends when all three are Ready", () => {
    expect(slices).toHaveLength(3);
    for (const slice of slices) {
      const firstBeatOffBy = slice.grid.firstBeat % BEAT;
      expect(firstBeatOffBy).toBeGreaterThan(0.05 * BEAT);
    }
    expect(plan.endWhen).toEqual({ kind: "slices-done" });
    expect(plan.readyCues).toEqual(["Cue 1 of 3: a 1, by ear. R when happy", "Cue 2 of 3: a 1, by ear. R when happy", "Cue 3 of 3: a 1, by ear. R when happy"]);
  });

  const cueOn = (offsetSec: number): CuePointSet[] =>
    slices.map((slice, index) => ({ ctx: PLAY_AT + index, deck: "A", trackId: slice.trackId, pos: barStart(slice.grid, 1) + offsetSec }));
  const withSlices = (cuePoints: readonly CuePointSet[]) =>
    attempt({ grids: Object.fromEntries(slices.map((slice) => [slice.trackId, slice.grid])), cuePoints, meters: { master: [] } });

  it("passes a cue point within 20 ms of a downbeat on each slice", () => {
    expect(grade(definition, plan, withSlices(cueOn(0.012)), PLAY_AT + 60).outcome).toEqual({ kind: "passed" });
  });

  it("fails, not voids, a Check that ended before every slice was loaded: the missing cue points count", () => {
    // Timed out on slice 1: slices 2 and 3 never reached the deck, so the recorder has only slice 1's grid.
    const first = slices[0];
    if (first === undefined) throw new Error("no slices");
    const timedOut = attempt({ grids: { [first.trackId]: first.grid }, cuePoints: cueOn(0.012).slice(0, 1), meters: { master: [] } });
    expect(grade(definition, plan, timedOut, PLAY_AT + 60).outcome).toEqual({ kind: "void", reason: "gridUntrusted" });

    const result = grade(definition, plan, withPlannedGrids(timedOut, track, plan), PLAY_AT + 60);
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["cue-point.cue-on-downbeat"] });
    if (!("criteria" in result)) throw new Error("expected a graded result");
    expect(result.criteria[0]?.detail).toMatchObject({ missing: 2 });
  });

  it("keeps a recorded grid over the planned one", () => {
    const recordedGrid = { ...track.grid, rmsResidualMs: 3 };
    const first = slices[0];
    if (first === undefined) throw new Error("no slices");
    expect(withPlannedGrids(attempt({ grids: { [first.trackId]: recordedGrid } }), track, plan).grids[first.trackId]).toEqual(recordedGrid);
  });

  it("fails a cue 30 ms off, or on a beat that is not the 1", () => {
    expect(grade(definition, plan, withSlices(cueOn(0.03)), PLAY_AT + 60).outcome.kind).toBe("failed");
    expect(grade(definition, plan, withSlices(cueOn(BEAT)), PLAY_AT + 60).outcome.kind).toBe("failed");
  });
});

describe("cut-on-phrase", () => {
  const definition = lessonDefinition("cut-on-phrase");
  const plan = definition.planCheck(track);
  const cutPos = phraseStart(track.grid, 3);
  const cutAt = heardA(plan, cutPos);
  const end = cutAt + 5 * BAR;

  function cut(playB: number, extra: readonly ControlEvent[] = []) {
    const bPlayhead = [
      { fromCtx: PLAY_AT - 1, pos: plan.deckB?.pos ?? 0, rate: 0 },
      { fromCtx: playB, pos: plan.deckB?.pos ?? 0, rate: 1 },
    ];
    const events = [event(PLAY_AT + 1, "cueMonitor", 1, "B"), event(PLAY_AT + 2, "channelFader", 1, "B"), event(playB + 0.02, "channelFader", 0, "A"), ...extra].sort(
      (a, b) => a.ctx - b.ctx,
    );
    const meters = {
      master: frames(PLAY_AT - 1, end, () => MUSIC),
      A: frames(PLAY_AT - 1, end, () => MUSIC),
      B: frames(PLAY_AT - 1, end, levels(SILENT, MUSIC, playB)),
    };
    return grade(definition, plan, recorded(plan, { events, meters }, bPlayhead), end, ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"]);
  }

  it("leads in a whole phrase on A from its start, after an unclocked set-up, with B paused on its cue point at a phrase start, fader down", () => {
    expect(plan.startPos).toBeCloseTo(cutPos - 8 * BAR);
    expect(plan.startPos).toBeCloseTo(phraseStart(track.grid, 2));
    expect(plan.firstPhraseAction).toBeCloseTo(cutPos);
    expect(plan.setUp).toMatchObject({ caption: "Set up: CUE 🎧 B on, fader B up, trims matched" });
    expect(plan.deckB).toMatchObject({ pos: phraseStart(track.grid, 2), fader: 0, play: false, cuePoint: true, headphoneCue: false });
    expect(plan.endWhen).toEqual({ kind: "after", sec: 13 * BAR });
  });

  it("passes B started on A's phrase start with A cut out, CUE B on first and level steady", () => {
    expect(cut(cutAt + 0.03).outcome).toEqual({ kind: "passed" });
  });

  it("grades the Check's cut, not a practice cut that played B from the same cue point before it", () => {
    const bPos = plan.deckB?.pos ?? 0;
    // Practice: B played from its cue point 300 ms late, then was cued back. The Check's cut is on time.
    const practiceB: PlayheadSegment[] = [
      { fromCtx: PLAY_AT - 30, pos: bPos, rate: 0 },
      { fromCtx: PLAY_AT - 25.7, pos: bPos, rate: 1 },
      { fromCtx: PLAY_AT - 15, pos: bPos + 10.7, rate: 0 },
      { fromCtx: PLAY_AT - 1, pos: bPos, rate: 0 },
      { fromCtx: cutAt + 0.03, pos: bPos, rate: 1 },
    ];
    const events = [event(PLAY_AT + 1, "cueMonitor", 1, "B"), event(PLAY_AT + 2, "channelFader", 1, "B"), event(cutAt + 0.05, "channelFader", 0, "A")];
    const meters = { master: frames(PLAY_AT - 1, end, () => MUSIC), A: frames(PLAY_AT - 1, end, () => MUSIC), B: frames(PLAY_AT - 1, end, levels(SILENT, MUSIC, cutAt + 0.03)) };
    const result = grade(definition, plan, recorded(plan, { events, meters }, practiceB), end, ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"]);
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("fails B started 300 ms late", () => {
    expect(cut(cutAt + 0.3).outcome).toMatchObject({ kind: "failed", failedCriteria: expect.arrayContaining(["cut-on-phrase.cut-start"]) as unknown });
  });
});
