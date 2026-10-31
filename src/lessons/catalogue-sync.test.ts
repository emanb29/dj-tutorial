// Lessons 8–11 as data: each plan sets the decks up as the Lesson needs, an attempt recorded on that
// plan grades as the Check should, and what the practice left in the recording before the Check's own
// cue (still heard for the output latency) never reaches the grade. Attempts are synthetic.
import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, deckState, event, frames, MUSIC, ramp, type FrameLevels } from "@checks/testing/synthetic.ts";
import type { Attempt, ControlEvent, CtxSpan, LessonId, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { checkSpecFor, LESSONS, lessonDefinition, readyUsedIn, unlocksAfter } from "./catalogue.ts";
import { pairProblems, tempoTargets, withoutMasterTempo } from "./catalogue-sync.ts";
import { partnerOrder } from "./plan.ts";
import { SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack } from "./synthetic-track.ts";
import { barStart, beatSec, phraseStart } from "./track.ts";
import type { CheckPlan, LessonDefinition, LessonTrack } from "./types.ts";

const partner: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_PARTNER), peakDbfs: -6 };
const track: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6, partner };
const BEAT = beatSec(track.grid);
const BAR = 4 * BEAT;
/** Every attempt below: the Check's own cue is heard at CUED; the recorder started 3 s (over a bar, past no-clip's grace) before. */
const CUED = 100;
const RECORDER_START = CUED - 3;
/** The practice, still heard until the cue, peaked at 0 dBFS: a clip that must not fail the Check. */
const PRACTICE_CLIP: FrameLevels = { peak: 0, momentary: -12 };
const FIRST_SEVEN: readonly LessonId[] = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase"];

const heardA = (plan: CheckPlan, pos: number) => CUED + (pos - plan.startPos);
const masterFrames = (to: number) => frames(RECORDER_START, to, (t) => (t < CUED ? PRACTICE_CLIP : MUSIC));

function recorded(overrides: Partial<Attempt>): Attempt {
  return attempt({
    grids: { [track.trackId]: track.grid, [partner.trackId]: partner.grid },
    phraseMarkers: { [track.trackId]: track.phraseStarts, [partner.trackId]: partner.phraseStarts },
    ...overrides,
  });
}

function grade(definition: LessonDefinition, plan: CheckPlan, graded: Attempt, to: number, passedLessons: readonly LessonId[] = FIRST_SEVEN): CheckResult {
  const spec = checkSpecFor(definition, track, plan, graded, { window: { from: RECORDER_START, to }, passedLessons });
  const result = runCheck(spec, graded);
  if (!("criteria" in result)) throw new Error(`expected a graded result, got ${JSON.stringify(result.outcome)}`);
  return result;
}

const failed = (result: CheckResult) => (result.outcome.kind === "failed" ? result.outcome.failedCriteria : []);
const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

/** The same Lesson graded from the recorder's start instead of its own cue: what the leak would do. */
function fromRecorderStart(definition: LessonDefinition): LessonDefinition {
  const copy: { -readonly [Key in keyof LessonDefinition]: LessonDefinition[Key] } = { ...definition };
  delete copy.gradeFromOwnCue;
  return copy;
}

describe("the Lesson catalogue for Lessons 8–11", () => {
  it("adds tempo-fader, sync-blend, crossfader and eq-basics after cut-on-phrase, in catalogue order", () => {
    expect(LESSONS.map((lesson) => lesson.id).slice(7, 11)).toEqual(["tempo-fader", "sync-blend", "crossfader", "eq-basics"]);
  });

  it("reveals each Lesson's new parts on the controller", () => {
    const after = (lessons: readonly LessonId[]) => unlocksAfter([...FIRST_SEVEN, ...lessons]);
    for (const control of ["B.tempo", "B.bpm", "B.master-tempo", "B.tempo-range", "A.tempo"] as const) {
      expect(after([]).has(control)).toBe(false);
      expect(after(["tempo-fader"]).has(control)).toBe(true);
    }
    expect(after(["tempo-fader"]).has("B.sync")).toBe(false);
    expect(after(["tempo-fader", "sync-blend"]).has("B.sync")).toBe(true);
    expect(after(["tempo-fader", "sync-blend"]).has("crossfader")).toBe(false);
    expect(after(["tempo-fader", "sync-blend", "crossfader"]).has("crossfader")).toBe(true);
    for (const control of ["A.eq-low", "A.eq-mid", "A.eq-high", "B.eq-low"] as const) expect(after(["eq-basics"]).has(control)).toBe(true);
  });

  it("each hook step names one control, and Ready is a button where R does something", () => {
    for (const id of ["tempo-fader", "sync-blend", "crossfader", "eq-basics"] as const) {
      const lesson = lessonDefinition(id);
      expect(lesson.hook.length).toBeGreaterThan(0);
      expect(lesson.hook.length).toBeLessThanOrEqual(3);
    }
    expect(readyUsedIn(lessonDefinition("tempo-fader"), track)).toEqual({ practice: true, check: true });
    // sync-blend sets up (SYNC B, CUE B) off the clock, in practice and in the Check.
    expect(readyUsedIn(lessonDefinition("sync-blend"), track)).toEqual({ practice: true, check: true });
    expect(readyUsedIn(lessonDefinition("crossfader"), track)).toEqual({ practice: false, check: false });
  });

  it("grades from the Check's own cue, not the recorder's start", () => {
    for (const id of ["tempo-fader", "sync-blend", "crossfader", "eq-basics"] as const) {
      const definition = lessonDefinition(id);
      const plan = definition.planCheck(track);
      const segments = (pos: number): PlayheadSegment[] => [
        { fromCtx: RECORDER_START, pos: pos + 3, rate: 1 },
        { fromCtx: CUED, pos, rate: 1 },
      ];
      const graded = recorded({
        decks: {
          A: { trackId: track.trackId, playhead: { segments: segments(plan.startPos) } },
          ...(plan.deckB === undefined ? {} : { B: { trackId: partner.trackId, playhead: { segments: segments(plan.deckB.pos) } } }),
        },
      });
      const spec = checkSpecFor(definition, track, plan, graded, { window: { from: RECORDER_START, to: CUED + 60 }, passedLessons: [] });
      expect(spec.window, id).toEqual({ from: CUED, to: CUED + 60 });
    }
  });
});

describe("pairing two tracks", () => {
  it("takes a partner 0.5–3% apart in tempo, nearest 2% first", () => {
    const candidates = [{ id: "same", bpm: 124 }, { id: "far", bpm: 128 }, { id: "near", bpm: 123 }, { id: "best", bpm: 121.5 }, { id: "unknown", bpm: undefined }];
    expect(partnerOrder(124, candidates, { minApart: 0.005, maxApart: 0.03 }).map((candidate) => candidate.id)).toEqual(["best", "near"]);
  });

  it("refuses a partner too far apart, at the same tempo, or the same track", () => {
    expect(pairProblems(track, partner)).toEqual([]);
    expect(pairProblems(track, { ...partner, grid: { ...partner.grid, bpm: 128 } })[0]).toContain("3.2% apart");
    expect(pairProblems(track, { ...partner, grid: { ...partner.grid, bpm: 124 } })[0]).toContain("same");
    expect(pairProblems(track, track)).toContain("The partner is the same track.");
  });
});

describe("tempo-fader", () => {
  const definition = lessonDefinition("tempo-fader");
  const plan = definition.planCheck(track, 1);
  const pos = plan.deckB?.pos ?? 0;
  const targets = tempoTargets(track);

  it("sets B playing at the track's tempo, Master Tempo off; three targets in the ±6% range; two clips", () => {
    expect(plan.deckB).toMatchObject({ play: true, fader: 1, tempoPercent: 0, tempoRange: 6, masterTempo: false, sync: false });
    expect(targets).toEqual([127, 121.5, 125.5]);
    expect(plan.endWhen).toEqual({ kind: "readies", deck: "B", count: 3 });
    expect(plan.readyCues).toEqual(["Set B to 127.0 BPM, then R", "Now 121.5 BPM, then R", "Last one: 125.5 BPM, then R", "Now listen: two clips"]);
    expect(definition.questions.map((question) => question.choices)).toEqual([
      [{ label: "On", value: 1 }, { label: "Off", value: 0 }],
      [{ label: "On", value: 1 }, { label: "Off", value: 0 }],
    ]);
    expect(definition.practiceCaptionFor?.(track)).toBe("Set B to 126.0 BPM, then R");
  });

  it("lets B be heard fast with Master Tempo off, then on, in the hook", () => {
    expect(definition.hook.map((step) => step.trigger)).toEqual([
      { kind: "tempo-up", deck: "B", percent: 4 },
      { kind: "touch", control: "B.master-tempo" },
      { kind: "touch", control: "B.tempo-range" },
    ]);
    expect(definition.hook[0]?.caption).toBe("Slide TEMPO B near +: faster");
    expect(definition.hook[1]?.named).toBe("Master Tempo on: still fast, back in key.");
  });

  it("plays the hook, the clips and the Check from the drop, where the chords are, not the drum-only intro", () => {
    // The synthetic groove's drop (bars 49–64) is its first 16 bars with the pad.
    expect(pos).toBe(phraseStart(track.grid, 7));
    expect(definition.practiceClip?.(track, false).pos).toBe(pos);
    expect(plan.loop).toEqual({ deck: "B", atPos: phraseStart(track.grid, 9), reset: "positions" });
    const noNames: LessonTrack = { ...track, sections: [] };
    expect(definition.planCheck(noNames, 1).deckB?.pos).toBe(phraseStart(track.grid, 2));
  });

  it("offers the Check's own clips, Off and On, to practise by ear before the Check", () => {
    const clips = definition.planCheck(track, 1).clips ?? {};
    const asked = Object.values(clips);
    for (const masterTempo of [false, true]) {
      const clip = definition.practiceClip?.(track, masterTempo);
      expect(clip).toEqual({ ...asked[0], masterTempo });
    }
  });

  it("changes which clip has Master Tempo on from one attempt to the next", () => {
    const patterns = [1, 2, 3, 4].map((attemptNumber) => {
      const clips = definition.planCheck(track, attemptNumber).clips ?? {};
      return [clips["clip-1"]?.masterTempo, clips["clip-2"]?.masterTempo];
    });
    expect(new Set(patterns.map((pattern) => JSON.stringify(pattern))).size).toBe(4);
  });

  /** B played from its cue at each target in turn, 10 s each; confirmed at the end of each. */
  function tempoAttempt(bpms: readonly number[], answers: Readonly<Record<string, number>>): Attempt {
    const segments: PlayheadSegment[] = [{ fromCtx: RECORDER_START, pos: pos + 4, rate: 126 / track.grid.bpm }];
    let at = pos;
    bpms.forEach((bpm, index) => {
      const rate = bpm / track.grid.bpm;
      segments.push({ fromCtx: CUED + index * 10, pos: at, rate });
      at += 10 * rate;
    });
    return recorded({
      decks: {
        A: { trackId: track.trackId, playhead: { segments: [{ fromCtx: CUED, pos, rate: 0 }] } },
        B: { trackId: track.trackId, playhead: { segments } },
      },
      // A Ready from the practice, heard before the cue at the practice target: not the Check's.
      events: [event(CUED - 0.4, "ready", 1, "B"), ...[1, 2, 3].map((index) => event(CUED + index * 10 - 1, "ready", 1, "B"))],
      meters: { master: masterFrames(CUED + 31), B: frames(RECORDER_START, CUED + 31, () => MUSIC) },
      initialMixer: { A: channel(), B: channel({ channelFader: 1 }), crossfader: 0.5 },
      answers,
    });
  }
  const rightAnswers = { "clip-1": plan.clips?.["clip-1"]?.masterTempo === true ? 1 : 0, "clip-2": plan.clips?.["clip-2"]?.masterTempo === true ? 1 : 0 };

  it("passes the three BPMs confirmed with Ready and both clips named, ignoring the practice before the cue", () => {
    const result = grade(definition, plan, tempoAttempt(targets, rightAnswers), CUED + 31);
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(byId(result, "tempo-fader.set-bpm")?.measured).toBeCloseTo(0, 6);
    // From the recorder's start, the practice's Ready (and its 0 dBFS peak) would be graded too.
    expect(failed(grade(fromRecorderStart(definition), plan, tempoAttempt(targets, rightAnswers), CUED + 31))).toEqual(
      expect.arrayContaining(["tempo-fader.set-bpm", "standing.no-clip"]),
    );
  });

  it("without Master Tempo (the time-stretcher failed to load): no clips, no questions, no MASTER TEMPO step; BPMs graded alone", () => {
    const missing = withoutMasterTempo(definition);
    const bare = missing.planCheck(track, 1);
    expect(bare.clips).toBeUndefined();
    expect(bare.readyCues).toEqual(["Set B to 127.0 BPM, then R", "Now 121.5 BPM, then R", "Last one: 125.5 BPM, then R"]);
    expect(missing.questions).toEqual([]);
    expect(missing.hook.map((step) => step.control)).toEqual(["B.tempo", "B.tempo-range"]);
    expect(missing.practiceClip).toBeUndefined();
    expect(missing.practiceCaptionFor?.(track)).toBe("Set B to 126.0 BPM, then R · Master Tempo can't load here, so no clips");
    // Never graded against a Master Tempo state the audio did not have: the ear part is not applicable.
    const result = grade(missing, bare, tempoAttempt(targets, {}), CUED + 31);
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(byId(result, "tempo-fader.master-tempo-ear")?.status).toBe("notApplicable");
    expect(withoutMasterTempo(lessonDefinition("sync-blend"))).toBe(lessonDefinition("sync-blend"));
  });

  it("fails a target 0.1 BPM off, and a clip named wrong", () => {
    expect(failed(grade(definition, plan, tempoAttempt([127, 121.6, 125.5], rightAnswers), CUED + 31))).toEqual(["tempo-fader.set-bpm"]);
    const wrong = { ...rightAnswers, "clip-2": 1 - rightAnswers["clip-2"] };
    expect(failed(grade(definition, plan, tempoAttempt(targets, wrong), CUED + 31))).toEqual(["tempo-fader.master-tempo-ear"]);
  });
});

describe("sync-blend", () => {
  const definition = lessonDefinition("sync-blend");
  const plan = definition.planCheck(track);
  const blendPos = plan.startPos + 8 * BAR;
  const cueB = plan.deckB?.pos ?? 0;
  const synced = track.grid.bpm / partner.grid.bpm;

  it("plays A a whole phrase before a steady phrase, from its start, after an unclocked set-up; B, a 121 BPM partner, waits on its cue point, SYNC off, fader down", () => {
    expect(blendPos).toBeCloseTo(phraseStart(track.grid, 2));
    expect(plan.startPos).toBeCloseTo(phraseStart(track.grid, 1));
    expect(plan.firstPhraseAction).toBeCloseTo(blendPos);
    expect(plan.setUp).toMatchObject({ caption: "Set up: SYNC B on, CUE 🎧 B on" });
    expect(cueB).toBeCloseTo(phraseStart(partner.grid, 2));
    expect(plan.deckB).toMatchObject({ play: false, fader: 0, cuePoint: true, sync: false, tempoPercent: 0 });
    expect(plan.endWhen).toEqual({ kind: "faded-out-then", deck: "A", bars: 2 });
    expect(definition.aids).toMatchObject({ sync: true });
  });

  function blendAttempt(playBAt: number): { graded: Attempt; end: number } {
    const outA = playBAt + 9 * BAR;
    const end = outA + 4 * BAR;
    const faders: ControlEvent[] = [
      ...ramp("channelFader", "B", { from: playBAt, to: playBAt + BAR }, 0, 1),
      ...ramp("channelFader", "A", { from: outA, to: outA + BAR }, 1, 0),
    ];
    const graded = recorded({
      decks: {
        // The practice was heard playing A's phrase start just before the cue.
        A: { trackId: track.trackId, playhead: { segments: [{ fromCtx: RECORDER_START, pos: blendPos - 0.5, rate: 1 }, { fromCtx: CUED, pos: plan.startPos, rate: 1 }] } },
        B: { trackId: partner.trackId, playhead: { segments: [{ fromCtx: CUED, pos: cueB, rate: 0 }, { fromCtx: playBAt, pos: cueB, rate: synced }] } },
      },
      events: [event(CUED + 1, "cueMonitor", 1, "B"), { ...event(CUED + 2, "sync", 1, "B") }, { ...event(playBAt, "play", 1, "B"), appliedCtx: playBAt }, ...faders].sort((a, b) => a.ctx - b.ctx),
      meters: {
        master: masterFrames(end),
        A: frames(RECORDER_START, end, () => MUSIC),
        B: frames(RECORDER_START, end, (t) => (t >= playBAt ? MUSIC : { peak: -120, momentary: -120 })),
      },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
      initialDecks: { A: deckState(), B: deckState() },
    });
    return { graded, end };
  }

  it("passes B in on A's phrase start, blended over 9 bars, though the practice played that phrase start before the cue", () => {
    const { graded, end } = blendAttempt(heardA(plan, blendPos));
    const result = grade(definition, plan, graded, end, [...FIRST_SEVEN, "tempo-fader"]);
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(byId(result, "sync-blend.blend-length")?.measured).toBeGreaterThan(8);
    expect(failed(grade(fromRecorderStart(definition), plan, graded, end, [...FIRST_SEVEN, "tempo-fader"]))).toContain("standing.no-clip");
  });

  it("fails a blend started 2 beats late", () => {
    const { graded, end } = blendAttempt(heardA(plan, blendPos) + 2 * BEAT);
    expect(failed(grade(definition, plan, graded, end, [...FIRST_SEVEN, "tempo-fader"]))).toContain("sync-blend.blend-start");
  });
});

describe("crossfader", { timeout: 20_000 }, () => {
  const definition = lessonDefinition("crossfader");
  const plan = definition.planCheck(track);
  const blendPos = plan.startPos + 8 * BAR;
  const cutPos = blendPos + 16 * BAR;
  const cueB = plan.deckB?.pos ?? 0;
  const synced = track.grid.bpm / partner.grid.bpm;

  it("starts with the crossfader on A, both faders up, B synced on its cue point", () => {
    expect(plan.crossfader).toBe(0);
    expect(plan.deckB).toMatchObject({ fader: 1, sync: true, cuePoint: true, play: false });
    expect(plan.endWhen).toEqual({ kind: "position", pos: cutPos + 4 * BAR + BEAT });
  });

  function crossfaderAttempt(cutAt: number, practiceBefore: boolean): { graded: Attempt; end: number } {
    const playBAt = heardA(plan, blendPos);
    const end = heardA(plan, cutPos + 4 * BAR + BEAT);
    const practice: PlayheadSegment[] = practiceBefore ? [{ fromCtx: RECORDER_START, pos: blendPos + 14 * BAR - 0.3, rate: 1 }] : [];
    const graded = recorded({
      decks: {
        A: { trackId: track.trackId, playhead: { segments: [...practice, { fromCtx: CUED, pos: plan.startPos, rate: 1 }] } },
        B: { trackId: partner.trackId, playhead: { segments: [{ fromCtx: CUED, pos: cueB, rate: 0 }, { fromCtx: playBAt, pos: cueB, rate: synced }] } },
      },
      events: [
        event(CUED + 1, "cueMonitor", 1, "B"),
        { ...event(playBAt, "play", 1, "B"), appliedCtx: playBAt },
        ...ramp("crossfader", undefined, { from: playBAt, to: playBAt + 9 * BAR }, 0, 1),
        event(playBAt + 12 * BAR, "cueMonitor", 1, "A"),
        event(cutAt, "crossfader", 0),
      ].sort((a, b) => a.ctx - b.ctx),
      meters: { master: masterFrames(end), A: frames(RECORDER_START, end, () => MUSIC), B: frames(RECORDER_START, end, (t) => (t >= playBAt ? MUSIC : { peak: -120, momentary: -120 })) },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel({ channelFader: 1 }), crossfader: 0 },
      initialDecks: { A: deckState(), B: deckState({ sync: true }) },
    });
    return { graded, end };
  }
  const passed: readonly LessonId[] = [...FIRST_SEVEN, "tempo-fader", "sync-blend"];

  it("passes a 9-bar crossfader blend and a cut back to A on the phrase", () => {
    const { graded, end } = crossfaderAttempt(heardA(plan, cutPos), false);
    expect(grade(definition, plan, graded, end, passed).outcome).toEqual({ kind: "passed" });
  });

  it("finds the cut after the Check's own play-through of A, not the practice's, still heard as it starts", () => {
    const { graded, end } = crossfaderAttempt(heardA(plan, cutPos), true);
    expect(grade(definition, plan, graded, end, passed).outcome).toEqual({ kind: "passed" });
  });

  it("fails a cut 150 ms off the phrase start", () => {
    const { graded, end } = crossfaderAttempt(heardA(plan, cutPos) + 0.15, false);
    expect(failed(grade(definition, plan, graded, end, passed))).toEqual(["crossfader.xf-cut"]);
  });
});

describe("eq-basics", () => {
  const definition = lessonDefinition("eq-basics");
  const plan = definition.planCheck(track);
  const cutPos = barStart(track.grid, 17);
  const backPos = barStart(track.grid, 25);

  it("cuts on the groove (bar 17, with the bass), after a whole phrase from its start, every EQ centred", () => {
    expect(plan.startPos).toBeCloseTo(cutPos - 8 * BAR);
    expect(plan.firstPhraseAction).toBeCloseTo(cutPos);
    expect(plan.deckA).toMatchObject({ eqCentred: true });
    expect(plan.endWhen).toEqual({ kind: "position", pos: backPos + 2 * BAR + BEAT });
    expect(definition.trackProblems(track)).toEqual([]);
  });

  function eqAttempt(returnAt: number, extra: readonly ControlEvent[] = []): { graded: Attempt; end: number } {
    const end = heardA(plan, backPos + 2 * BAR + BEAT);
    const span: CtxSpan = { from: RECORDER_START, to: end };
    const graded = recorded({
      decks: { A: { trackId: track.trackId, playhead: { segments: [{ fromCtx: RECORDER_START, pos: backPos - 0.3, rate: 1 }, { fromCtx: CUED, pos: plan.startPos, rate: 1 }] } } },
      events: [...extra, event(heardA(plan, cutPos) - 0.1, "eqLow", -120, "A"), event(returnAt, "eqLow", 0, "A")].sort((a, b) => a.ctx - b.ctx),
      meters: { master: masterFrames(span.to), A: frames(span.from, span.to, () => MUSIC) },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    });
    return { graded, end };
  }

  it("passes LOW cut for the phrase and back on the next 1; a cut and return in the practice before the cue is not the Check's", () => {
    const practiceCut = [event(CUED - 0.5, "eqLow", -120, "A"), event(CUED - 0.3, "eqLow", 0, "A")];
    const { graded, end } = eqAttempt(heardA(plan, backPos) + 0.05, practiceCut);
    const result = grade(definition, plan, graded, end);
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(byId(result, "eq-basics.low-return")?.evidence[0]?.from).toBeCloseTo(heardA(plan, backPos) + 0.05);
  });

  it("fails a LOW brought back 2 beats late", () => {
    const { graded, end } = eqAttempt(heardA(plan, backPos) + 2 * BEAT);
    expect(failed(grade(definition, plan, graded, end))).toEqual(["eq-basics.low-return"]);
  });
});
