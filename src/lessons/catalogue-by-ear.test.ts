// Lessons 14–16 as data: each plan sets the decks up as the Lesson needs, an attempt recorded on that
// plan grades as the Check should, and what the practice left in the recording before the Check's own
// cue (still heard for the output latency) never reaches the grade. Attempts are synthetic.
import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, deckState, event, frames, MUSIC } from "@checks/testing/synthetic.ts";
import type { Attempt, LessonId, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { COVERED_DISPLAYS, kickRun } from "./catalogue-by-ear.ts";
import { checkSpecFor, LESSONS, lessonDefinition, readyUsedIn, unlocksAfter } from "./catalogue.ts";
import { SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack } from "./synthetic-track.ts";
import { beatSec, phraseStart } from "./track.ts";
import type { CheckPlan, LessonDefinition, LessonTrack } from "./types.ts";

const partner: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_PARTNER), peakDbfs: -6 };
const single: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6 };
const paired: LessonTrack = { ...single, partner };
const BEAT = beatSec(single.grid);
const BAR = 4 * BEAT;
/** Every attempt below: the Check's own cue is heard at CUED; the recorder started a second before. */
const CUED = 100;
const RECORDER_START = CUED - 1;
const BEFORE_LESSONS: readonly LessonId[] = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "crossfader", "eq-basics"];

function recorded(track: LessonTrack, overrides: Partial<Attempt>, end: number): Attempt {
  const tracks = [track, track.partner ?? track];
  return attempt({
    grids: Object.fromEntries(tracks.map((each) => [each.trackId, each.grid])),
    phraseMarkers: Object.fromEntries(tracks.map((each) => [each.trackId, each.phraseStarts])),
    meters: { master: frames(RECORDER_START, end, () => MUSIC), A: frames(RECORDER_START, end, () => MUSIC), B: frames(RECORDER_START, end, () => MUSIC) },
    initialDecks: { A: deckState(), B: deckState() },
    ...overrides,
  });
}

function spec(definition: LessonDefinition, track: LessonTrack, plan: CheckPlan, graded: Attempt, to: number) {
  return checkSpecFor(definition, track, plan, graded, { window: { from: RECORDER_START, to }, passedLessons: BEFORE_LESSONS });
}

function grade(definition: LessonDefinition, track: LessonTrack, plan: CheckPlan, graded: Attempt, to: number): CheckResult {
  const result = runCheck(spec(definition, track, plan, graded, to), graded);
  if (!("criteria" in result)) throw new Error(`expected a graded result, got ${JSON.stringify(result.outcome)}`);
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("the Lesson catalogue for Lessons 14–16", () => {
  it("adds nudge-phase, tempo-by-ear and blend-by-ear, in catalogue order", () => {
    const ids = LESSONS.map((lesson) => lesson.id);
    expect(ids.filter((id) => ["nudge-phase", "tempo-by-ear", "blend-by-ear"].includes(id))).toEqual(["nudge-phase", "tempo-by-ear", "blend-by-ear"]);
    expect(ids.indexOf("nudge-phase")).toBeGreaterThan(ids.indexOf("eq-basics"));
  });

  it("nudge-phase unlocks the jog's pitch bend and the phase meter", () => {
    for (const control of ["A.jog-bend", "B.jog-bend", "phase-meter"] as const) {
      expect(unlocksAfter(BEFORE_LESSONS).has(control)).toBe(false);
      expect(unlocksAfter([...BEFORE_LESSONS, "nudge-phase"]).has(control)).toBe(true);
    }
  });

  it("locks SYNC off in all three, and covers the BPM display and phase meter from tempo-by-ear on", () => {
    expect(lessonDefinition("nudge-phase").locks).toEqual(["A.sync", "B.sync"]);
    for (const id of ["tempo-by-ear", "blend-by-ear"] as const) {
      expect(lessonDefinition(id).locks).toEqual(expect.arrayContaining(["A.sync", "B.sync", ...COVERED_DISPLAYS]));
      expect(lessonDefinition(id).aids ?? {}).toEqual({});
    }
    expect(lessonDefinition("nudge-phase").aids).toEqual({ bpmDisplay: true, phaseMeter: true });
  });

  it("Ready is a button in tempo-by-ear practice only; every hook is at most 2 steps", () => {
    expect(readyUsedIn(lessonDefinition("tempo-by-ear"), paired)).toEqual({ practice: true, check: false });
    expect(readyUsedIn(lessonDefinition("nudge-phase"), single)).toEqual({ practice: false, check: false });
    for (const id of ["nudge-phase", "tempo-by-ear", "blend-by-ear"] as const) expect(lessonDefinition(id).hook.length).toBeLessThanOrEqual(2);
  });

  it("starts where the kick plays: the synthetic intro and groove, not the breakdown", () => {
    expect(kickRun(single, 4)).toBe(1);
    expect(kickRun({ ...single, sections: [{ name: "breakdown", phrase: 1 }, { name: "groove", phrase: 2 }] }, 2)).toBe(2);
  });
});

describe("nudge-phase", () => {
  const definition = lessonDefinition("nudge-phase");

  it("plays the same track on both decks at the same tempo, B up to ¼ beat out, a different side each attempt", () => {
    const offsets = [1, 2, 3, 4].map((attemptNumber) => {
      const plan = definition.planCheck(single, attemptNumber);
      expect(plan.deckB).toMatchObject({ play: true, fader: 1, sync: false, tempoPercent: 0 });
      expect(plan.deckA).toMatchObject({ sync: false, tempoPercent: 0 });
      return ((plan.deckB?.pos ?? 0) - plan.startPos) / BEAT;
    });
    for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(offsets.some((offset) => offset > 0) && offsets.some((offset) => offset < 0)).toBe(true);
    expect(definition.partner).toBeUndefined();
  });

  const plan = definition.planCheck(single, 1);
  const offset = (plan.deckB?.pos ?? 0) - plan.startPos;

  /** A Check heard from CUED, B nudged back into line from `bendAt` at 10% faster or slower; the practice before the cue played in phase. */
  function nudged(bendAt: number, cuePresses: readonly number[] = []): { graded: Attempt; end: number } {
    const bendRate = offset > 0 ? 0.9 : 1.1;
    const lineAt = bendAt + Math.abs(offset) / 0.1;
    const end = CUED + 16 * BAR;
    const practice: PlayheadSegment = { fromCtx: RECORDER_START, pos: plan.startPos + 2 * BAR - 0.5, rate: 1 };
    const graded = recorded(
      single,
      {
        decks: {
          A: { trackId: single.trackId, playhead: { segments: [practice, { fromCtx: CUED, pos: plan.startPos, rate: 1 }] } },
          B: {
            trackId: single.trackId,
            playhead: {
              segments: [
                practice,
                { fromCtx: CUED, pos: plan.startPos + offset, rate: 1 },
                { fromCtx: bendAt, pos: plan.startPos + offset + (bendAt - CUED), rate: bendRate },
                { fromCtx: lineAt, pos: plan.startPos + (lineAt - CUED), rate: 1 },
              ],
            },
          },
        },
        events: [event(bendAt, "jogBend", bendRate - 1, "B"), event(lineAt, "jogBend", 0, "B"), ...cuePresses.map((at) => event(at, "deckCue", 1, "B"))].sort((a, b) => a.ctx - b.ctx),
      },
      end,
    );
    return { graded, end };
  }

  it("grades phase from the Check's own play-through, 2 bars after its cue, not the practice's", () => {
    const { graded, end } = nudged(CUED + 2 * BAR);
    const { task, window } = spec(definition, single, plan, graded, end);
    expect(window.from).toBeCloseTo(CUED);
    expect(task).toEqual({ lessonId: "nudge-phase", phaseFrom: expect.closeTo(CUED + 2 * BAR, 6) as number });
  });

  it("passes B nudged into line within 4 bars and held 8; CUE presses in the practice before the cue are not counted", () => {
    const { graded, end } = nudged(CUED + 2 * BAR, [CUED - 0.5, CUED - 0.2]);
    const result = grade(definition, single, plan, graded, end);
    expect(byId(result, "nudge-phase.converge")?.status).toBe("met");
    expect(byId(result, "nudge-phase.hold")?.status).toBe("met");
    expect(byId(result, "nudge-phase.cue-presses")).toMatchObject({ status: "met", measured: 0 });
  });

  it("counts CUE presses on B in the Check (re-cueing instead of nudging)", () => {
    const { graded, end } = nudged(CUED + 2 * BAR, [CUED + 1, CUED + 3]);
    expect(byId(grade(definition, single, plan, graded, end), "nudge-phase.cue-presses")).toMatchObject({ status: "notMet", measured: 2 });
  });

  it("fails a nudge that only starts 6 bars in", () => {
    const { graded, end } = nudged(CUED + 8 * BAR);
    expect(byId(grade(definition, single, plan, graded, end), "nudge-phase.converge")?.status).toBe("notMet");
  });

  it("voids an attempt whose own cue was never heard: only the practice is in the recording", () => {
    const { graded, end } = nudged(CUED + 2 * BAR);
    const practiceOnly: Attempt = {
      ...graded,
      decks: Object.fromEntries(Object.entries(graded.decks).map(([deck, recordedDeck]) => [deck, { ...recordedDeck, playhead: { segments: recordedDeck.playhead.segments.slice(0, 1) } }])),
    };
    expect(runCheck(spec(definition, single, plan, practiceOnly, end), practiceOnly).outcome).toEqual({ kind: "void", reason: "sectionNotHeard" });
  });

  it("ends live once B is held 8 bars, but never before the Check's own hold window is recorded", () => {
    expect(plan.endWhen).toMatchObject({ kind: "held", tempoBpm: null });
    if (plan.endWhen.kind !== "held") throw new Error("expected a held end");
    expect(plan.endWhen.phaseMs).toBeLessThan(15);
    expect(plan.endWhen.notBeforePos).toBeGreaterThanOrEqual(plan.startPos + 10 * BAR);
    expect(plan.endWhen.orPos).toBeCloseTo(plan.startPos + 15 * BAR);
  });
});

describe("tempo-by-ear", () => {
  const definition = lessonDefinition("tempo-by-ear");
  const bpmA = single.grid.bpm;

  it("plays the partner on B, 0.5–2% off A, faster or slower by attempt, SYNC off on the ±6% range", () => {
    const aparts = [1, 2, 3, 4, 5, 6].map((attemptNumber) => {
      const plan = definition.planCheck(paired, attemptNumber);
      expect(plan.deckB).toMatchObject({ play: true, fader: 1, sync: false, tempoRange: 6 });
      const bpmB = partner.grid.bpm * (1 + (plan.deckB?.tempoPercent ?? 0) / 100);
      return ((bpmB - bpmA) / bpmA) * 100;
    });
    for (const apart of aparts) expect(Math.abs(apart)).toBeGreaterThanOrEqual(0.5 - 1e-9);
    for (const apart of aparts) expect(Math.abs(apart)).toBeLessThanOrEqual(2 + 1e-9);
    expect(aparts.some((apart) => apart > 0) && aparts.some((apart) => apart < 0)).toBe(true);
    for (const attemptNumber of [1, 2, 3, 4, 5, 6]) expect(Math.abs(definition.planCheck(paired, attemptNumber).deckB?.tempoPercent ?? 0)).toBeLessThan(6);
  });

  const plan = definition.planCheck(paired, 1);
  const cueB = plan.deckB?.pos ?? 0;
  const startRateB = 1 + (plan.deckB?.tempoPercent ?? 0) / 100;
  const matchedRateB = bpmA / partner.grid.bpm;

  /** B matched at `matchAt` and lined up (on the nearest beat of A); the practice before the cue played in phase. */
  function matched(matchAt: number): { graded: Attempt; end: number } {
    const end = matchAt + 12 * BAR;
    const beatsA = ((plan.startPos + (matchAt - CUED)) * bpmA) / 60;
    const posB = cueB + (matchAt - CUED) * startRateB;
    const beatsB = (posB * partner.grid.bpm) / 60;
    const linedUpB = ((beatsB + (((beatsA - beatsB) % 1) + 1.5) % 1 - 0.5) * 60) / partner.grid.bpm;
    const graded = recorded(
      paired,
      {
        decks: {
          A: { trackId: single.trackId, playhead: { segments: [{ fromCtx: RECORDER_START, pos: plan.startPos + 2 * BAR - 0.5, rate: 1 }, { fromCtx: CUED, pos: plan.startPos, rate: 1 }] } },
          B: {
            trackId: partner.trackId,
            playhead: {
              segments: [
                { fromCtx: RECORDER_START, pos: cueB + 2 * BAR - 0.5, rate: matchedRateB },
                { fromCtx: CUED, pos: cueB, rate: startRateB },
                { fromCtx: matchAt, pos: linedUpB, rate: matchedRateB },
              ],
            },
          },
        },
        events: [{ ...event(matchAt, "tempo", (matchedRateB - 1) * 100, "B"), appliedCtx: matchAt }],
      },
      end,
    );
    return { graded, end };
  }

  it("matches from the Check's own play-through, 2 bars after its cue", () => {
    const { graded, end } = matched(CUED + 10 * BAR);
    expect(spec(definition, paired, plan, graded, end).task).toEqual({ lessonId: "tempo-by-ear", matchFrom: expect.closeTo(CUED + 2 * BAR, 6) as number });
    expect(spec(definition, paired, plan, graded, end).aids).toMatchObject({ sync: false, bpmDisplay: false, phaseMeter: false });
  });

  it("passes B matched and in line within 32 bars, held 8", () => {
    const { graded, end } = matched(CUED + 10 * BAR);
    expect(byId(grade(definition, paired, plan, graded, end), "tempo-by-ear.tempo-match")?.status).toBe("met");
  });

  it("fails B never matched", () => {
    const { graded, end } = matched(CUED + 10 * BAR);
    const unmatched: Attempt = { ...graded, decks: { ...graded.decks, B: { trackId: partner.trackId, playhead: { segments: [{ fromCtx: CUED, pos: cueB, rate: startRateB }] } } } };
    expect(byId(grade(definition, paired, plan, unmatched, end), "tempo-by-ear.tempo-match")?.status).toBe("notMet");
  });

  it("ends live on tempo and phase, tighter than the Check", () => {
    expect(plan.endWhen).toMatchObject({ kind: "held" });
    if (plan.endWhen.kind !== "held") throw new Error("expected a held end");
    expect(plan.endWhen.tempoBpm).toBeLessThan(0.1);
    expect(plan.endWhen.phaseMs).toBeLessThan(20);
  });
});

describe("blend-by-ear", () => {
  const definition = lessonDefinition("blend-by-ear");
  const plan = definition.planCheck(paired, 1);

  it("starts B with A in the headphones only, off A's tempo; ends 4 bars after A is out", () => {
    expect(plan.deckB).toMatchObject({ play: true, fader: 0, headphoneCue: true, eqCentred: true, sync: false });
    expect(Math.abs(plan.deckB?.tempoPercent ?? 0)).toBeGreaterThan(0);
    expect(plan.startPos).toBeCloseTo(phraseStart(single.grid, 1));
    expect(plan.endWhen).toEqual({ kind: "faded-out-then", deck: "A", bars: 4 });
    expect(definition.headphones).toBe(true);
  });

  it("leaves LOW B for the Learner to cut in the set-up, off the clock, so an FLX4 knob and the app agree", () => {
    expect(plan.deckB).not.toHaveProperty("lowCut");
    expect(plan.setUp).toEqual({ caption: "Set up: LOW B all the way down — then R" });
    expect(plan.cues[0]?.fromPos).toBe(plan.startPos);
    expect(plan.cues[0]?.caption).toContain("match B: TEMPO B, then jog B");
  });

  it("is graded with every aid off, on A and the partner on B", () => {
    const graded = recorded(paired, {}, CUED + 10);
    const gradedSpec = spec(definition, paired, plan, graded, CUED + 10);
    expect(gradedSpec.aids).toMatchObject({ sync: false, bpmDisplay: false, phaseMeter: false });
    expect(gradedSpec.tracks.map((track) => track.trackId)).toEqual([single.trackId, partner.trackId]);
  });
});
