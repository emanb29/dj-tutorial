// The Placement tasks as data (placement-design §4.1): controls, setups, and that an attempt recorded
// on a task's plan grades as that Lesson's short-form Check in Placement mode.
import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, taps } from "@checks/testing/synthetic.ts";
import type { Attempt } from "@shared/attempt.ts";
import { checkSpecFor, unlocksAfter } from "./catalogue.ts";
import { PLACEMENT_TASK_IDS } from "./placement.ts";
import { placementControls, placementTask, placementTrackProblems } from "./placement-tasks.ts";
import { SYNTHETIC_HOUSE, syntheticLessonTrack } from "./synthetic-track.ts";
import { barStart, beatSec, phraseStart } from "./track.ts";
import type { CheckPlan, LessonTrack } from "./types.ts";

const track: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6 };
const BEAT = beatSec(track.grid);
const BAR = 4 * BEAT;
const PLAY_AT = 100;

function recorded(plan: CheckPlan, overrides: Partial<Attempt>): Attempt {
  return attempt({
    decks: { A: { trackId: track.trackId, playhead: { segments: [{ fromCtx: PLAY_AT, pos: plan.startPos, rate: 1 }] } } },
    grids: { [track.trackId]: track.grid },
    phraseMarkers: { [track.trackId]: track.phraseStarts },
    initialMixer: { A: channel({ channelFader: plan.faderAtStart }), B: channel(), crossfader: 0.5 },
    ...overrides,
  });
}

describe("Placement task controls", () => {
  it("are the union of the task's Lesson and its ancestors' controls", () => {
    expect(new Set(placementControls("cut-on-phrase", placementTask("cut-on-phrase").grading.aids))).toEqual(
      unlocksAfter(["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"]),
    );
    expect(placementTask("beats-and-bars").controls).toEqual(["A.play", "A.channel-fader", "master-level", "master-meter", "tap"]);
  });

  it("leave locked aids greyed: blend-by-ear has no SYNC, BPM display or phase meter, but jog bend, EQ and the tempo fader", () => {
    const controls = placementTask("blend-by-ear").controls;
    for (const control of ["A.jog-bend", "B.eq-low", "B.tempo", "B.headphone-cue"] as const) expect(controls).toContain(control);
    for (const control of ["A.sync", "B.sync", "A.bpm", "B.bpm", "phase-meter"] as const) expect(controls).not.toContain(control);
  });

  it("give bass-swap SYNC and the BPM display, and nudge-phase the phase meter without SYNC", () => {
    expect(placementTask("bass-swap").controls).toEqual(expect.arrayContaining(["B.sync", "B.bpm", "B.eq-low"]));
    expect(placementTask("bass-swap").controls).not.toContain("A.jog-bend");
    expect(placementTask("nudge-phase").controls).toEqual(expect.arrayContaining(["phase-meter", "B.jog-bend", "B.tempo"]));
    expect(placementTask("nudge-phase").controls).not.toContain("B.sync");
  });
});

describe("Placement task setups", () => {
  it("all run on the synthetic groove, graded as short-form Placement Checks with no Lesson text", () => {
    expect(placementTrackProblems(track)).toEqual([]);
    for (const id of PLACEMENT_TASK_IDS) {
      expect(placementTask(id).grading).toMatchObject({ mode: "placement", variant: "short", aids: { lessonText: false, quantize: false } });
      // One caption line, at most 9 words (§4.1).
      expect(placementTask(id).caption.split(" ").length, id).toBeLessThanOrEqual(9);
    }
  });

  it("put the first phrase start a blend or cut needs at least 8 bars into the attempt (the hook)", () => {
    for (const id of ["blend-by-ear", "bass-swap", "sync-blend", "cut-on-phrase"] as const) {
      const plan = placementTask(id).planCheck(track);
      const firstNeeded = track.phraseStarts.find((start) => start > plan.startPos + 1e-6) ?? Number.POSITIVE_INFINITY;
      const entry = phraseStart(track.grid, 3);
      expect(entry - plan.startPos, id).toBeGreaterThanOrEqual(8 * BAR - 1e-6);
      expect(firstNeeded).toBeLessThanOrEqual(entry);
    }
  });

  it("start B the way each task needs it", () => {
    const blend = placementTask("blend-by-ear").planCheck(track).deckB;
    expect(blend).toMatchObject({ cuePoint: true, play: false, fader: 0, headphoneCue: false });
    expect(Math.abs(blend?.tempoPercent ?? 0)).toBeGreaterThanOrEqual(0.5);
    expect(Math.abs(blend?.tempoPercent ?? 0)).toBeLessThanOrEqual(2);
    const bass = placementTask("bass-swap").planCheck(track).deckB;
    expect(Math.abs(bass?.tempoPercent ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(bass?.tempoPercent ?? 0)).toBeLessThanOrEqual(3);
    // cut-on-phrase: no cue point, off the downbeat, 6 dB low, so cue-point and gain-staging are measured.
    const cut = placementTask("cut-on-phrase").planCheck(track).deckB;
    expect(cut?.cuePoint).toBeUndefined();
    expect(cut?.trim).toBeCloseTo(-0.25);
    expect(((cut?.pos ?? 0) / BEAT) % 1).not.toBeCloseTo(0);
    const nudge = placementTask("nudge-phase").planCheck(track);
    expect(((nudge.deckB?.pos ?? 0) - nudge.startPos) / BEAT).toBeLessThanOrEqual(0.25);
  });
});

describe("Placement tasks grade as the Lesson's short form", () => {
  it("phrases: three phrase starts tapped and the drop named (pad 4) pass; the drop named wrong fails", () => {
    const definition = placementTask("phrases");
    const plan = definition.planCheck(track);
    const heard = (pos: number) => PLAY_AT + (pos - plan.startPos);
    const starts = [5, 6, 7].map((phrase) => heard(phraseStart(track.grid, phrase)) + 0.02);
    const end = heard(phraseStart(track.grid, 8)) + BEAT;
    const grade = (answers: Record<string, number>) => {
      const recordedAttempt = recorded(plan, { events: taps(starts), answers });
      const spec = checkSpecFor(definition, track, plan, recordedAttempt, { window: { from: PLAY_AT - 1, to: end }, passedLessons: ["deck-basics", "beats-and-bars"], grading: definition.grading });
      return runCheck(spec, recordedAttempt);
    };
    const passed = grade({ drop: 4 });
    expect(passed).toMatchObject({ mode: "placement", variant: "short", outcome: { kind: "passed" } });
    expect(grade({ drop: 2 }).outcome).toMatchObject({ kind: "failed" });
  });

  it("beats-and-bars: 4 bars of beats and 4 of downbeats after a 4-bar count-in pass", () => {
    const definition = placementTask("beats-and-bars");
    const plan = definition.planCheck(track);
    const heard = (pos: number) => PLAY_AT + (pos - plan.startPos);
    const firstBar = 13;
    const beats = Array.from({ length: 16 }, (_, index) => heard(barStart(track.grid, firstBar) + index * BEAT) + 0.005);
    const downbeats = Array.from({ length: 4 }, (_, index) => heard(barStart(track.grid, firstBar + 4 + index)) + 0.005);
    const recordedAttempt = recorded(plan, { events: taps([...beats, ...downbeats]) });
    const end = heard(barStart(track.grid, firstBar + 8)) + BEAT;
    const spec = checkSpecFor(definition, track, plan, recordedAttempt, { window: { from: PLAY_AT - 1, to: end }, passedLessons: ["deck-basics"], grading: definition.grading });
    expect(plan.startPos).toBeCloseTo(barStart(track.grid, firstBar - 4));
    expect(runCheck(spec, recordedAttempt)).toMatchObject({ mode: "placement", outcome: { kind: "passed" } });
  });
});
