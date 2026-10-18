// Lessons 17–19 as data: each plan sets the decks up as the Lesson needs, an attempt recorded on that
// plan grades as the Check should, and what the hook and practice left in the recording (the same
// positions, the same pads) before the Check's own cue never reaches the grade. Attempts are synthetic.
import { describe, expect, it } from "vitest";
import { runCheck } from "@checks";
import { attempt, channel, frames, MUSIC, SILENT, type FrameLevels } from "@checks/testing/synthetic.ts";
import type { Attempt, ControlEvent, LessonId, LessonTask, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { checkSpecFor, LESSONS, lessonDefinition, readyUsedIn, unlocksAfter } from "./catalogue.ts";
import { hotCuePadPhrases } from "./catalogue-performance.ts";
import { SYNTHETIC_HOUSE, syntheticLessonTrack } from "./synthetic-track.ts";
import { beatSec, phraseStart } from "./track.ts";
import type { CheckPlan, LessonDefinition } from "./types.ts";

const track = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6 };
const BEAT = beatSec(track.grid);
const BAR = 4 * BEAT;
const PHRASE = 8 * BAR;
const RECORDER_START = 99;
const CUED = 100;
/** The practice, still heard until the cue, peaked at 0 dBFS: a clip that must not fail the Check. */
const PRACTICE_CLIP: FrameLevels = { peak: 0, momentary: -12 };
const BEFORE: readonly LessonId[] = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend"];

function recorded(overrides: Partial<Attempt>): Attempt {
  return attempt({ grids: { [track.trackId]: track.grid }, phraseMarkers: { [track.trackId]: track.phraseStarts }, ...overrides });
}

function grade(definition: LessonDefinition, plan: CheckPlan, graded: Attempt, to: number): { result: CheckResult; task: LessonTask } {
  const spec = checkSpecFor(definition, track, plan, graded, { window: { from: RECORDER_START, to }, passedLessons: BEFORE });
  const result = runCheck(spec, graded);
  if (!("criteria" in result)) throw new Error(`expected a graded result, got ${JSON.stringify(result.outcome)}`);
  return { result, task: spec.task };
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);
const failed = (result: CheckResult) => (result.outcome.kind === "failed" ? result.outcome.failedCriteria : []);
const masterFrames = (to: number) => frames(RECORDER_START, to, (t) => (t < CUED ? PRACTICE_CLIP : MUSIC));

describe("the Lesson catalogue for Lessons 17–19", () => {
  it("adds hot-cues, loop-transition and echo-out, in catalogue order", () => {
    const ids = LESSONS.map((lesson) => lesson.id);
    expect(ids.filter((id) => ["hot-cues", "loop-transition", "echo-out"].includes(id))).toEqual(["hot-cues", "loop-transition", "echo-out"]);
  });

  it("reveals the pads, the loop buttons and Beat FX, each with its Lesson", () => {
    expect(unlocksAfter(["hot-cues"]).has("A.hot-cue")).toBe(true);
    expect(unlocksAfter(["loop-transition"]).has("B.loop-exit")).toBe(true);
    // CUE/LOOP CALL ◀ / ▶ (½X / 2X) come with the loop buttons, not before.
    for (const control of ["A.loop-halve", "A.loop-double", "B.loop-halve", "B.loop-double"] as const) {
      expect(unlocksAfter(["hot-cues"]).has(control)).toBe(false);
      expect(unlocksAfter(["loop-transition"]).has(control)).toBe(true);
    }
    for (const control of ["beat-fx-select", "beat-fx-channel", "beat-fx-beat", "beat-fx-depth", "beat-fx-on"] as const) {
      expect(unlocksAfter(["hot-cues", "loop-transition"]).has(control)).toBe(false);
      expect(unlocksAfter(["echo-out"]).has(control)).toBe(true);
    }
  });

  it("runs on the synthetic groove", () => {
    for (const id of ["hot-cues", "loop-transition", "echo-out"] as const) expect(lessonDefinition(id).trackProblems(track)).toEqual([]);
  });
});

describe("hot-cues", () => {
  const definition = lessonDefinition("hot-cues");
  const plan = definition.planCheck(track);
  const pads = hotCuePadPhrases(track).map((phrase) => phraseStart(track.grid, phrase));
  const stops = plan.stops ?? [];

  it("parks A near the drop, the groove and the outro in turn, then plays from 4 bars before the groove", () => {
    expect(hotCuePadPhrases(track)).toEqual([7, 3, 9]);
    expect(stops).toHaveLength(3);
    stops.forEach((stop, index) => {
      expect(stop).toBeLessThan(pads[index] ?? 0);
      expect(stop).toBeGreaterThan((pads[index] ?? 0) - 3 * BEAT);
    });
    expect(plan.startPos).toBeCloseTo(phraseStart(track.grid, 3) - 4 * BAR, 9);
    expect(plan.deckA?.hotCues).toEqual(Array.from({ length: 8 }, () => null));
    expect(readyUsedIn(definition, track)).toEqual({ practice: false, check: true });
    // Practice: pad 1 holds the drop.
    expect(definition.practiceDecks?.(track).A.hotCues?.[0]).toBeCloseTo(pads[0] ?? 0, 9);
  });

  /** Placement on the paused deck from the Check's cue, then the trigger run from `runAt`. */
  function hotCueAttempt(options: { runAt: number | null; pressLateSec?: number }) {
    const { runAt, pressLateSec = 0 } = options;
    // The hook and practice: A played from the same start before the recorder, with a pad pressed.
    const segments: PlayheadSegment[] = [
      { fromCtx: 80, pos: plan.startPos, rate: 1 },
      { fromCtx: CUED, pos: stops[0] ?? 0, rate: 0 },
      { fromCtx: 105, pos: stops[1] ?? 0, rate: 0 },
      { fromCtx: 110, pos: stops[2] ?? 0, rate: 0 },
    ];
    const events: ControlEvent[] = [
      { ctx: 85, control: "hotCue", deck: "A", value: 1, pos: pads[0] ?? 0, appliedCtx: 85.05 },
      { ctx: 90, control: "hotCueSet", deck: "A", value: 3, pos: 3 },
      ...pads.map((pos, index): ControlEvent => ({ ctx: 102 + 5 * index, control: "hotCueSet", deck: "A", value: index + 1, pos })),
    ];
    if (runAt !== null) {
      segments.push({ fromCtx: runAt, pos: plan.startPos, rate: 1 });
      // A reaches the groove's phrase start 4 bars later; each pad jumps it to a phrase start, 8 bars before the next.
      let phraseAt = runAt + 4 * BAR;
      pads.forEach((pos, index) => {
        const press = phraseAt + pressLateSec;
        events.push({ ctx: press, control: "hotCue", deck: "A", value: index + 1, pos, appliedCtx: press + 0.05 });
        segments.push({ fromCtx: press + 0.05, pos, rate: 1 });
        phraseAt = press + 0.05 + PHRASE;
      });
    }
    return recorded({
      decks: { A: { trackId: track.trackId, playhead: { segments } } },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
      events: events.sort((a, b) => a.ctx - b.ctx),
      meters: { master: masterFrames(170), A: frames(RECORDER_START, 170, () => MUSIC) },
    });
  }

  it("passes three pads set at the stops and pressed on A's phrase starts", () => {
    const { result, task } = grade(definition, plan, hotCueAttempt({ runAt: 115 }), 170);
    expect(failed(result)).toEqual([]);
    // Graded from the Check's own cue to the first stop, split where it cued A to the start.
    expect(task).toMatchObject({ placeSection: { from: CUED, to: 115 }, triggerSection: { from: 115, to: 170 }, slots: [1, 2, 3] });
  });

  it("splits at the Check's own cue to the start, not the hook's or practice's (same position, before the window)", () => {
    const { result } = grade(definition, plan, hotCueAttempt({ runAt: 115 }), 170);
    // The practice press at 85 s and the practice set at 90 s are not this attempt's.
    expect(byId(result, "hot-cues.hc-trigger")).toMatchObject({ detail: { triggers: 3 } });
    expect(byId(result, "hot-cues.hc-place")).toMatchObject({ status: "met" });
  });

  it("fails, not voids, when the pads were never all set and A never played", () => {
    const { result, task } = grade(definition, plan, hotCueAttempt({ runAt: null }), 170);
    expect(task).toMatchObject({ triggerSection: { from: 170, to: 170 } });
    expect(result.outcome.kind).toBe("failed");
    expect(failed(result)).toContain("hot-cues.hc-trigger");
  });

  it("fails pad presses later than the Lesson's ±120 ms", () => {
    const { result } = grade(definition, plan, hotCueAttempt({ runAt: 115, pressLateSec: 0.15 }), 170);
    expect(failed(result)).toEqual(["hot-cues.hc-trigger"]);
  });
});

describe("loop-transition", () => {
  const definition = lessonDefinition("loop-transition");
  const plan = definition.planCheck(track);
  const loopPos = phraseStart(track.grid, 9);
  const cueB = plan.deckB?.pos ?? 0;
  const LOOP = 4 * BAR;
  /** A's loop from its outro's phrase start; B on the loop's 1 after one pass; EXIT one pass later. */
  const heardLoop = CUED + 4 * BAR;

  it("brings B in at full EQ for a Learner who has not swapped the bass yet (the LOWs may be locked)", () => {
    const captions = [...plan.cues.map((cue) => cue.caption), ...(plan.stepCues ?? []).map((step) => step.caption)];
    expect(captions.some((caption) => caption.includes("LOW"))).toBe(false);
  });

  it("after bass-swap, cuts LOW B before B comes in and swaps the bass over A's loop, before EXIT", () => {
    const swapping = definition.planCheck(track, 1, ["eq-basics", "sync-blend", "bass-swap"]);
    expect(swapping.cues[0]?.caption).toBe("CUE 🎧 B on. LOW B all the way down");
    expect(swapping.cues.map((cue) => cue.caption)).toContain("Next phrase's 1: LOOP IN (D)");
    expect(swapping.stepCues).toEqual([
      { after: { kind: "loop-on" }, caption: "Looping. On the loop's 1: Press ," },
      { after: { kind: "play", deck: "B" }, caption: "Next loop's 1: swap the bass. LOW A down, LOW B up" },
      { after: { kind: "swap" }, caption: "Next loop's 1: EXIT (G)" },
      { after: { kind: "loop-exit" }, caption: "Fader A down (S), then LOW A to the middle" },
    ]);
    // One more loop to play: the swap's.
    expect(swapping.timeoutSec).toBeCloseTo(plan.timeoutSec + LOOP, 6);
  });

  function loopAttempt(options: { bInPasses?: number } = {}) {
    const bIn = heardLoop + (options.bInPasses ?? 2) * LOOP;
    const exitAt = bIn + LOOP;
    const closeAt = exitAt + BAR;
    const end = closeAt + 3 * BAR;
    const aSegments: PlayheadSegment[] = [
      // The hook and practice played A from the same start, and looped it, before the recorder.
      { fromCtx: 70, pos: plan.startPos, rate: 1 },
      { fromCtx: 85, pos: loopPos, rate: 1 },
      { fromCtx: CUED, pos: plan.startPos, rate: 1 },
      ...Array.from({ length: (options.bInPasses ?? 2) + 1 }, (_, pass) => ({ fromCtx: heardLoop + (pass + 1) * LOOP, pos: loopPos, rate: 1 })),
    ];
    const events: ControlEvent[] = [
      { ctx: 80, control: "loopIn", deck: "A", value: 1, pos: loopPos },
      { ctx: 80 + LOOP, control: "loopOut", deck: "A", value: LOOP, pos: loopPos },
      { ctx: CUED + 0.5, control: "cueMonitor", deck: "B", value: 1 },
      { ctx: heardLoop, control: "loopIn", deck: "A", value: 1, pos: loopPos },
      { ctx: heardLoop + LOOP, control: "loopOut", deck: "A", value: LOOP, pos: loopPos },
      { ctx: bIn, control: "play", deck: "B", value: 1, appliedCtx: bIn },
      { ctx: exitAt, control: "loopExit", deck: "A", value: 1 },
      { ctx: closeAt, control: "channelFader", deck: "A", value: 0 },
    ];
    return {
      end,
      attempt: recorded({
        decks: {
          A: { trackId: track.trackId, playhead: { segments: aSegments } },
          B: { trackId: track.trackId, playhead: { segments: [{ fromCtx: 70, pos: cueB, rate: 1 }, { fromCtx: CUED, pos: cueB, rate: 0 }, { fromCtx: bIn, pos: cueB, rate: 1 }] } },
        },
        initialMixer: { A: channel({ channelFader: 1 }), B: channel({ channelFader: 1 }), crossfader: 0.5 },
        events,
        meters: {
          master: masterFrames(end),
          A: frames(RECORDER_START, end, () => MUSIC),
          B: frames(RECORDER_START, end, (t) => (t < CUED || t >= bIn ? MUSIC : SILENT)),
        },
      }),
    };
  }

  it("loops A's outro from its phrase start; B is cued from the groove with its fader up", () => {
    expect(plan.startPos).toBeCloseTo(loopPos - 4 * BAR, 9);
    expect(plan.deckB).toMatchObject({ pos: phraseStart(track.grid, 3), fader: 1, play: false, cuePoint: true });
    expect(plan.stepCues?.map((step) => step.after.kind)).toEqual(["loop-on", "play", "loop-exit"]);
  });

  it("passes a 4-bar loop, B on the loop's 1, EXIT on the next, graded from the Check's own cue", () => {
    const { end, attempt: graded } = loopAttempt();
    const { result } = grade(definition, plan, graded, end);
    expect(failed(result)).toEqual([]);
    expect(byId(result, "loop-transition.loop-length")).toMatchObject({ status: "met", detail: { loopBeats: expect.closeTo(16, 6) as number } });
    // The practice's clip and its loop, before the cue, never count.
    expect(byId(result, "standing.no-clip")).toMatchObject({ status: "met" });
  });
});

describe("echo-out", () => {
  const definition = lessonDefinition("echo-out");
  const plan = definition.planCheck(track);
  const nextPhrase = phraseStart(track.grid, 4);
  const heardA = (pos: number) => CUED + (pos - plan.startPos);

  function echoAttempt(options: { cutLateBeats?: number } = {}) {
    const cutAt = heardA(nextPhrase - BAR) + (options.cutLateBeats ?? 0) * BEAT;
    const bIn = heardA(nextPhrase);
    const offAt = bIn + BAR;
    const end = bIn + 6 * BAR;
    const events: ControlEvent[] = [
      { ctx: CUED + 0.5, control: "cueMonitor", deck: "B", value: 1 },
      { ctx: CUED + 1, control: "beatFx", value: 1 },
      { ctx: cutAt, control: "channelFader", deck: "A", value: 0 },
      { ctx: bIn, control: "play", deck: "B", value: 1, appliedCtx: bIn },
      { ctx: offAt, control: "beatFx", value: 0 },
    ];
    return {
      end,
      attempt: recorded({
        decks: {
          A: { trackId: track.trackId, playhead: { segments: [{ fromCtx: 70, pos: plan.startPos, rate: 1 }, { fromCtx: CUED, pos: plan.startPos, rate: 1 }] } },
          B: { trackId: track.trackId, playhead: { segments: [{ fromCtx: CUED, pos: plan.deckB?.pos ?? 0, rate: 0 }, { fromCtx: bIn, pos: plan.deckB?.pos ?? 0, rate: 1 }] } },
        },
        initialMixer: { A: channel({ channelFader: 1 }), B: channel({ channelFader: 1 }), crossfader: 0.5, beatFx: { on: false, channel: "A", beats: 1, depth: 0.7 } },
        events,
        meters: {
          master: masterFrames(end),
          A: frames(RECORDER_START, end, () => MUSIC),
          B: frames(RECORDER_START, end, (t) => (t >= bIn ? MUSIC : SILENT)),
          fxReturn: frames(RECORDER_START, end, (t) => (t > CUED + 1 && t < cutAt + 3 * BEAT ? { peak: -10, momentary: -22 } : SILENT)),
        },
      }),
    };
  }

  it("sets ECHO on CH 1, one beat, off; B waits at the drop with its fader up", () => {
    expect(plan.beatFx).toEqual({ channel: "A", beats: 1, depth: 0.7, on: false });
    expect(plan.deckB).toMatchObject({ pos: phraseStart(track.grid, 7), fader: 1, play: false });
  });

  it("passes an echo out cut on the last bar's 1, B on the phrase's 1, FX off as the echoes end", () => {
    const { end, attempt: graded } = echoAttempt();
    const { result } = grade(definition, plan, graded, end);
    expect(failed(result)).toEqual([]);
    expect(byId(result, "standing.no-dead-air")).toMatchObject({ status: "met" });
  });

  it("fails a cut 1.5 beats off the downbeat", () => {
    const { end, attempt: graded } = echoAttempt({ cutLateBeats: 1.5 });
    expect(failed(grade(definition, plan, graded, end).result)).toContain("echo-out.echo-cut");
  });
});
