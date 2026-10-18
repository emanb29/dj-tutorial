// Lessons 12–13 as data: each plan sets two synced decks up for a handover, an attempt recorded on
// that plan grades as the Check should, and what the practice left in the recording before the
// Check's own cue (still heard for the output latency) never reaches the grade. Attempts are synthetic.
import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, deckState, event, frames, MUSIC, ramp, SILENT, type FrameLevels } from "@checks/testing/synthetic.ts";
import type { Attempt, ControlEvent, LessonId, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { checkSpecFor, LESSONS, lessonDefinition, unlocksAfter } from "./catalogue.ts";
import { blendPositions, eqPairProblems } from "./catalogue-eq-filter.ts";
import { SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack } from "./synthetic-track.ts";
import { barStart, beatSec, phraseStart } from "./track.ts";
import type { CheckPlan, LessonDefinition, LessonTrack } from "./types.ts";

const partner: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_PARTNER), peakDbfs: -6 };
const track: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6, partner };
const BEAT = beatSec(track.grid);
const BAR = 4 * BEAT;
/** Every attempt below: the Check's own cue is heard at CUED; the recorder started a second before. */
const CUED = 100;
const RECORDER_START = CUED - 1;
/** The practice, still heard until the cue, peaked at 0 dBFS: a clip that must not fail the Check. */
const PRACTICE_CLIP: FrameLevels = { peak: 0, momentary: -12 };
const BEFORE: readonly LessonId[] = [
  "deck-basics",
  "beats-and-bars",
  "phrases",
  "gain-staging",
  "headphone-cue",
  "cue-point",
  "cut-on-phrase",
  "tempo-fader",
  "sync-blend",
  "eq-basics",
];
/** B synced to A: 124 BPM played from a 121 BPM track. */
const SYNCED = track.grid.bpm / partner.grid.bpm;

const failed = (result: CheckResult) => (result.outcome.kind === "failed" ? result.outcome.failedCriteria : []);
const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

function grade(definition: LessonDefinition, plan: CheckPlan, graded: Attempt, to: number): CheckResult {
  const spec = checkSpecFor(definition, track, plan, graded, { window: { from: RECORDER_START, to }, passedLessons: BEFORE });
  const result = runCheck(spec, graded);
  if (!("criteria" in result)) throw new Error(`expected a graded result, got ${JSON.stringify(result.outcome)}`);
  return result;
}

/** The same Lesson graded from the recorder's start instead of its own cue: what the leak would do. */
function fromRecorderStart(definition: LessonDefinition): LessonDefinition {
  const copy: { -readonly [Key in keyof LessonDefinition]: LessonDefinition[Key] } = { ...definition };
  delete copy.gradeFromOwnCue;
  return copy;
}

interface Handover {
  /** The Learner's own moves, besides CUE B, Play B and fader B up on A's phrase start. */
  readonly moves: readonly ControlEvent[];
  /** When A's fader closes (it drops in one step: A is silent from here). */
  readonly outAt: number;
  /** The practice before the cue: A and B heard playing on, the master clipping, and these moves. */
  readonly practice?: readonly ControlEvent[];
}

/**
 * An attempt on `plan`: A plays from the plan's start at CUED; B, synced, waits on its cue point and
 * starts on A's phrase start with its fader up over a bar; A's fader closes at `outAt`.
 */
function handoverAttempt(plan: CheckPlan, { moves, outAt, practice }: Handover): { graded: Attempt; end: number } {
  const { blendPos } = blendPositions(track);
  const heardA = (pos: number) => CUED + (pos - plan.startPos);
  const playBAt = heardA(blendPos);
  const cueB = plan.deckB?.pos ?? 0;
  const end = outAt + 2 * BAR;
  const before = practice !== undefined;
  const segmentsA: PlayheadSegment[] = [...(before ? [{ fromCtx: RECORDER_START, pos: blendPos + 8 * BAR - 0.5, rate: 1 }] : []), { fromCtx: CUED, pos: plan.startPos, rate: 1 }];
  const segmentsB: PlayheadSegment[] = [
    ...(before ? [{ fromCtx: RECORDER_START, pos: cueB + 8 * BAR, rate: SYNCED }] : []),
    { fromCtx: CUED, pos: cueB, rate: 0 },
    { fromCtx: playBAt, pos: cueB, rate: SYNCED },
  ];
  const events: ControlEvent[] = [
    ...(practice ?? []),
    event(CUED + 1, "cueMonitor", 1, "B"),
    { ...event(playBAt, "play", 1, "B"), appliedCtx: playBAt },
    ...ramp("channelFader", "B", { from: playBAt, to: playBAt + BAR }, 0, 1),
    ...moves,
    event(outAt, "channelFader", 0, "A"),
  ].sort((a, b) => a.ctx - b.ctx);
  const graded = attempt({
    grids: { [track.trackId]: track.grid, [partner.trackId]: partner.grid },
    phraseMarkers: { [track.trackId]: track.phraseStarts, [partner.trackId]: partner.phraseStarts },
    decks: {
      A: { trackId: track.trackId, playhead: { segments: segmentsA } },
      B: { trackId: partner.trackId, playhead: { segments: segmentsB } },
    },
    events,
    meters: {
      master: frames(RECORDER_START, end, (t) => (t < CUED && before ? PRACTICE_CLIP : MUSIC)),
      A: frames(RECORDER_START, end, () => MUSIC),
      B: frames(RECORDER_START, end, (t) => (t >= playBAt || (before && t < CUED) ? MUSIC : SILENT)),
    },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    initialDecks: { A: deckState(), B: deckState({ sync: true }) },
  });
  return { graded, end };
}

describe("the Lesson catalogue for Lessons 12–13", () => {
  it("adds bass-swap and filter-transition after eq-basics, in catalogue order", () => {
    expect(LESSONS.map((lesson) => lesson.id).slice(11, 13)).toEqual(["bass-swap", "filter-transition"]);
  });

  it("reveals only the CFX knobs: bass-swap adds nothing, filter-transition adds CFX A and B", () => {
    const before = unlocksAfter(BEFORE);
    expect([...unlocksAfter([...BEFORE, "bass-swap"])]).toEqual([...before]);
    const added = [...unlocksAfter([...BEFORE, "filter-transition"])].filter((control) => !before.has(control));
    expect(added).toEqual(["A.filter", "B.filter"]);
    // Each hook step touches a part the Learner has by then.
    for (const id of ["bass-swap", "filter-transition"] as const) {
      const lesson = lessonDefinition(id);
      expect(lesson.hook.length).toBeGreaterThan(0);
      expect(lesson.hook.length).toBeLessThanOrEqual(3);
      const has = new Set([...before, ...lesson.unlocks]);
      for (const step of lesson.hook) expect(has.has(step.control), `${id}: ${step.control}`).toBe(true);
    }
  });

  it("grades from the Check's own cue, not the recorder's start", () => {
    for (const id of ["bass-swap", "filter-transition"] as const) {
      const definition = lessonDefinition(id);
      const plan = definition.planCheck(track);
      const segments = (pos: number): PlayheadSegment[] => [
        { fromCtx: RECORDER_START, pos: pos + 3, rate: 1 },
        { fromCtx: CUED, pos, rate: 1 },
      ];
      const graded = attempt({
        decks: {
          A: { trackId: track.trackId, playhead: { segments: segments(plan.startPos) } },
          B: { trackId: partner.trackId, playhead: { segments: segments(plan.deckB?.pos ?? 0) } },
        },
      });
      const spec = checkSpecFor(definition, track, plan, graded, { window: { from: RECORDER_START, to: CUED + 60 }, passedLessons: [] });
      expect(spec.window, id).toEqual({ from: CUED, to: CUED + 60 });
      expect(spec.tracks.map((each) => each.trackId), id).toEqual([track.trackId, partner.trackId]);
      expect(spec.aids, id).toMatchObject({ sync: true });
    }
  });

  it("sets both Lessons up the same way: A in the groove with its bass, B synced on its cue point, every EQ and CFX centred", () => {
    const { leadPos, blendPos, handoverPos, cueB } = blendPositions(track);
    // The groove (bars 17–32) has the kick and the bass; B's groove starts on its phrase 3.
    expect(blendPos).toBeCloseTo(barStart(track.grid, 17));
    expect(handoverPos).toBeCloseTo(barStart(track.grid, 25));
    // A whole phrase to count, from its start, after the set-up off the clock.
    expect(leadPos).toBeCloseTo(blendPos - 8 * BAR);
    expect(cueB).toBeCloseTo(phraseStart(partner.grid, 2));
    for (const id of ["bass-swap", "filter-transition"] as const) {
      const plan = lessonDefinition(id).planCheck(track);
      expect(plan.startPos, id).toBeCloseTo(leadPos);
      expect(plan.firstPhraseAction, id).toBeCloseTo(blendPos);
      expect(plan.setUp?.caption, id).toMatch(/^Set up: CUE 🎧 B on/);
      expect(plan.deckA, id).toMatchObject({ sync: false, eqCentred: true, filterCentred: true, headphoneCue: false });
      expect(plan.deckB, id).toMatchObject({ pos: cueB, play: false, fader: 0, cuePoint: true, sync: true, eqCentred: true, filterCentred: true });
      expect(plan.crossfader, id).toBe(0.5);
      expect(plan.endWhen, id).toEqual({ kind: "faded-out-then", deck: "A", bars: 2 });
      expect(lessonDefinition(id).trackProblems(track), id).toEqual([]);
    }
  });

  it("takes a house partner 0.5–3% apart in tempo, with two phrases of groove", () => {
    expect(eqPairProblems(track, partner)).toEqual([]);
    expect(eqPairProblems(track, { ...partner, grid: { ...partner.grid, bpm: 128 } })[0]).toContain("3.2% apart");
    expect(eqPairProblems(track, track)).toContain("The partner is the same track.");
    const noBass = { ...partner, sections: partner.sections.map((section) => ({ ...section, name: "intro" })) };
    expect(eqPairProblems(track, noBass)).toEqual(["Deck B: The track needs two phrases in a row with the kick and the bass."]);
  });
});

describe("bass-swap", () => {
  const definition = lessonDefinition("bass-swap");
  const plan = definition.planCheck(track);
  const { handoverPos } = blendPositions(track);
  const heardA = (pos: number) => CUED + (pos - plan.startPos);
  const swapAt = heardA(handoverPos);

  /** LOW B cut before B comes in; LOW A down at `aDown`, LOW B up at `bUp`; A out 2 bars after the swap, its LOW back. */
  function swapAttempt(options: { aDown?: number; bUp?: number; cutB?: boolean; practice?: readonly ControlEvent[] } = {}) {
    const { aDown = swapAt - 0.1, bUp = swapAt + 0.1, cutB = true } = options;
    const outAt = swapAt + 2 * BAR;
    const moves = [
      ...(cutB ? [event(CUED + 2, "eqLow", -120, "B")] : []),
      event(aDown, "eqLow", -120, "A"),
      ...(cutB ? [event(bUp, "eqLow", 0, "B")] : []),
      event(outAt + 0.5 * BAR, "eqLow", 0, "A"),
    ];
    return handoverAttempt(plan, { moves, outAt, ...(options.practice === undefined ? {} : { practice: options.practice }) });
  }

  it("passes LOW B cut as B comes in and the LOWs swapped on A's next phrase start", () => {
    const { graded, end } = swapAttempt();
    const result = grade(definition, plan, graded, end);
    expect(result.outcome, JSON.stringify(result.criteria.filter((criterion) => criterion.status !== "met"))).toEqual({ kind: "passed" });
    expect(byId(result, "bass-swap.swap-time")?.measured).toBeCloseTo(0, 1);
    expect(byId(result, "bass-swap.clash-short")?.measured).toBe(0);
  });

  it("does not take the practice's swap or its clip before the Check's own cue", () => {
    // In the practice, heard until the cue: A and B played on, both LOWs up (two basslines), a swap.
    const practice = [event(CUED - 0.6, "eqLow", 0, "B"), event(CUED - 0.4, "eqLow", -120, "A"), event(CUED - 0.2, "eqLow", 0, "A")];
    const { graded, end } = swapAttempt({ practice });
    expect(grade(definition, plan, graded, end).outcome).toEqual({ kind: "passed" });
    expect(failed(grade(fromRecorderStart(definition), plan, graded, end))).toContain("standing.no-clip");
  });

  it("fails a swap 2 beats after the phrase start", () => {
    const { graded, end } = swapAttempt({ aDown: swapAt + 2 * BEAT - 0.1, bUp: swapAt + 2 * BEAT + 0.1 });
    expect(failed(grade(definition, plan, graded, end))).toEqual(["bass-swap.swap-time"]);
  });

  it("fails B brought in with its LOW up", () => {
    const { graded, end } = swapAttempt({ cutB: false });
    expect(failed(grade(definition, plan, graded, end))).toContain("bass-swap.enter-low-cut");
  });

  it("fails two basslines for 3 beats, though the swap's middle is on the 1", () => {
    const { graded, end } = swapAttempt({ bUp: swapAt - 1.5 * BEAT, aDown: swapAt + 1.5 * BEAT });
    expect(failed(grade(definition, plan, graded, end))).toEqual(["bass-swap.clash-short"]);
  });
});

describe("filter-transition", () => {
  const definition = lessonDefinition("filter-transition");
  const plan = definition.planCheck(track);
  const { blendPos, handoverPos } = blendPositions(track);
  const heardA = (pos: number) => CUED + (pos - plan.startPos);
  const outAt = heardA(handoverPos);

  /** CFX A turned right from 2 bars before B's entry to `depth` over 8 bars; A out a phrase after B; CFX A back at `backAt`. */
  function filterAttempt(options: { depth?: number; backAt?: number; practice?: readonly ControlEvent[] } = {}) {
    const { depth = 0.85, backAt = outAt + 0.5 * BAR } = options;
    const from = heardA(blendPos) - 2 * BAR + 0.25 * BEAT;
    const moves = [...ramp("filter", "A", { from, to: from + 8 * BAR }, 0.06, depth), event(backAt, "filter", 0, "A")];
    return handoverAttempt(plan, { moves, outAt, ...(options.practice === undefined ? {} : { practice: options.practice }) });
  }

  it("passes a 10-bar high-pass sweep on A begun 2 bars before B, deep enough, A out on the next phrase, CFX A back at once", () => {
    const { graded, end } = filterAttempt();
    const result = grade(definition, plan, graded, end);
    expect(result.outcome, JSON.stringify(result.criteria.filter((criterion) => criterion.status !== "met"))).toEqual({ kind: "passed" });
    expect(byId(result, "filter-transition.filter-length")?.measured).toBeCloseTo(10 - 1 / 16, 1);
  });

  it("does not take the practice's sweep or its clip before the Check's own cue", () => {
    // The practice's own sweep, still on as the cue is heard; the Check's set-up centred CFX A.
    const practice = [event(CUED - 0.8, "filter", 0.9, "A"), event(CUED - 0.1, "filter", 0, "A")];
    const { graded, end } = filterAttempt({ practice });
    expect(grade(definition, plan, graded, end).outcome).toEqual({ kind: "passed" });
    expect(failed(grade(fromRecorderStart(definition), plan, graded, end))).toContain("standing.no-clip");
  });

  it("fails a sweep that stops at 60%", () => {
    const { graded, end } = filterAttempt({ depth: 0.6 });
    expect(failed(grade(definition, plan, graded, end))).toEqual(["filter-transition.hpf-depth"]);
  });

  it("fails CFX A left on for 1½ bars after A went out", () => {
    const { graded, end } = filterAttempt({ backAt: outAt + 1.5 * BAR });
    expect(failed(grade(definition, plan, graded, end))).toEqual(["filter-transition.cfx-back"]);
  });
});
