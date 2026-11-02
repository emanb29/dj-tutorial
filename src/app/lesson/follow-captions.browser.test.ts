// Lessons 12–20 as the maintainer plays them: a Learner who does exactly what each live caption says, when
// they hear it, passes the Check, at 48 kHz with a wired output (40 ms) and Bluetooth headphones
// (250 ms). Real engine and recorder, rendered offline (never the speakers).
import { afterEach, describe, expect, it } from "vitest";
import { blendPositions, hotCuePadPhrases, phraseStart, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack, type BuiltLessonId, type CheckPlan } from "@lessons";
import { LESSON_IDS } from "@shared/catalogue.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import {
  follow,
  gradedAfterEnd,
  lessonHarness,
  matchTempoB,
  nudgeInLine,
  pairTrack,
  setUpThenReady,
  passedBefore,
  slide,
  startedCheck,
  summary,
  synthetic,
  until,
  type LessonHarness,
  type Move,
} from "./lesson-test-support.ts";

const SAMPLE_RATE = 48_000;
/** A real context's lookahead: baseLatency + 2 render quanta. */
const LOOKAHEAD_SEC = 0.0116 + 256 / SAMPLE_RATE;
const OUTPUTS = [
  { what: "wired output (40 ms)", latencySec: 0.04 },
  { what: "Bluetooth headphones (250 ms)", latencySec: 0.25 },
] as const;

let current: LessonHarness | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

/** The synthetic pair (A 124 BPM, B 121 BPM); `sameOnB`: the 124 BPM groove on both decks. */
async function pairHarness(lessonId: BuiltLessonId, latencySec: number, { renderSec = 120, sameOnB = false } = {}): Promise<LessonHarness> {
  current = await lessonHarness({
    sampleRate: SAMPLE_RATE,
    lessonId,
    track: sameOnB ? syntheticLessonTrack(SYNTHETIC_HOUSE) : pairTrack(),
    audio: (context) => synthetic(context, SYNTHETIC_HOUSE),
    partnerAudio: (context) => synthetic(context, sameOnB ? SYNTHETIC_HOUSE : SYNTHETIC_PARTNER),
    renderSec,
    latencySec,
    lookaheadSec: LOOKAHEAD_SEC,
  });
  return current;
}

/** Passed, and with no warning either: the captions lead to a clean mix. */
function expectClean(outcome: CheckResult | VoidAttempt, warningsAllowed: readonly string[] = []): void {
  expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
  const missed = "criteria" in outcome ? outcome.criteria.filter((criterion) => criterion.status === "notMet" && !warningsAllowed.includes(criterion.id)) : [];
  expect(missed.map(({ id, measured }) => ({ id, measured }))).toEqual([]);
}

describe.each(OUTPUTS)("following the captions on $what", ({ latencySec }) => {
  it("bass-swap passes", { timeout: 90_000 }, async () => {
    const run = await pairHarness("bass-swap", latencySec);
    const { track } = run;
    const { leadPos, playPos, blendPos, handoverPos } = blendPositions(track);
    const beat = 60 / track.grid.bpm;
    const bar = 4 * beat;
    // "Set up: CUE 🎧 B on, LOW B all the way down", off the clock.
    const playAt = await startedCheck(run, [], [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "eq-low", deck: "B", value: -1 },
    ]);
    const moves: Move[] = [
      { pos: playPos, command: { control: "play", deck: "B" }, caption: "Press ," },
      ...slide("channel-fader", "B", blendPos, 2, beat, 0, 1),
      { pos: handoverPos - 0.03, command: { control: "eq-low", deck: "A", value: -1 }, caption: "LOW A down, LOW B up" },
      { pos: handoverPos + 0.03, command: { control: "eq-low", deck: "B", value: 0 } },
      ...slide("channel-fader", "A", handoverPos + beat + 0.3, 1, beat, 1, 0).map((move, index) => (index === 0 ? { ...move, caption: "Fader A down" } : move)),
      { pos: handoverPos + 3 * beat, command: { control: "eq-low", deck: "A", value: 0 }, caption: "then LOW A to the middle" },
    ];
    await follow(run, playAt, leadPos, moves);
    await run.renderToHeard(playAt + (handoverPos + 2 * beat + 2 * bar + 0.5 - leadPos));
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "bass-swap"));
    expectClean(outcome);
  });

  it("filter-transition passes", { timeout: 90_000 }, async () => {
    const run = await pairHarness("filter-transition", latencySec);
    const { track } = run;
    const { leadPos, playPos, blendPos, handoverPos } = blendPositions(track);
    const beat = 60 / track.grid.bpm;
    const bar = 4 * beat;
    // "Set up: CUE 🎧 B on", off the clock.
    const playAt = await startedCheck(run, [], [{ control: "headphone-cue", deck: "B", value: true }]);
    // "Start CFX A right, slowly": from 10 bars before A's out, to most of the way right (0.85).
    const sweepFrom = handoverPos - 10 * bar + 0.3;
    const sweep: Move[] = Array.from({ length: 41 }, (_, step) => ({
      pos: sweepFrom + step * ((handoverPos - bar - sweepFrom) / 40),
      command: { control: "filter", deck: "A", value: 0.06 + (0.79 * step) / 40 },
      ...(step === 0 ? { caption: "CFX A right now" } : {}),
    }));
    const moves: Move[] = [
      ...sweep,
      { pos: playPos, command: { control: "play", deck: "B" }, caption: "Press ," },
      ...slide("channel-fader", "B", blendPos, 2, beat, 0, 1),
      { pos: handoverPos, command: { control: "channel-fader", deck: "A", value: 0 }, caption: "At Phrase 4, bar 1: A out" },
      { pos: handoverPos + beat + 0.4, command: { control: "filter", deck: "A", value: 0 }, caption: "CFX A back to the middle" },
    ];
    await follow(run, playAt, leadPos, moves);
    await run.renderToHeard(playAt + (handoverPos + 2 * bar + 0.5 - leadPos));
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "filter-transition"));
    expectClean(outcome);
  });
});

/** The plan the session is running (it varies by attempt). */
function planOf(run: LessonHarness): CheckPlan {
  if (run.plan === null) throw new Error("no Check is running");
  return run.plan;
}

/** Renders until A's position `pos` is heard (A from `fromPos` at render time `playAt`, at its own tempo). */
const hearPos = (run: LessonHarness, playAt: number, fromPos: number, pos: number) => run.renderToHeard(playAt + (pos - fromPos));

/** The caption the Learner reads now. */
const caption = (run: LessonHarness) => run.session.checkCue()?.caption ?? "";

describe.each(OUTPUTS)("following the captions by ear on $what", ({ latencySec }) => {
  it("nudge-phase passes", { timeout: 90_000 }, async () => {
    const run = await pairHarness("nudge-phase", latencySec, { renderSec: 150, sameOnB: true });
    const beat = 60 / run.track.grid.bpm;
    const playAt = await startedCheck(run);
    const plan = planOf(run);
    await hearPos(run, playAt, plan.startPos, plan.startPos + beat);
    expect(caption(run)).toContain("Nudge it with jog B");
    await nudgeInLine(run);
    if (plan.endWhen.kind !== "held") throw new Error("nudge-phase ends on a hold");
    await hearPos(run, playAt, plan.startPos, plan.endWhen.orPos + 0.1);
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "nudge-phase"));
    expectClean(outcome);
  });

  it("tempo-by-ear passes", { timeout: 120_000 }, async () => {
    const run = await pairHarness("tempo-by-ear", latencySec, { renderSec: 170 });
    const bar = (4 * 60) / run.track.grid.bpm;
    const playAt = await startedCheck(run);
    const plan = planOf(run);
    const matchFrom = plan.startPos + 2 * bar;
    await hearPos(run, playAt, plan.startPos, plan.startPos + 2 * bar);
    expect(caption(run)).toContain("Match B with TEMPO B");
    matchTempoB(run, 0.03);
    await hearPos(run, playAt, plan.startPos, matchFrom + 8 * bar + 0.5);
    expect(caption(run)).toContain("Nudge it in line");
    await nudgeInLine(run);
    if (plan.endWhen.kind !== "held") throw new Error("tempo-by-ear ends on a hold");
    await hearPos(run, playAt, plan.startPos, plan.endWhen.orPos + 0.1);
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "tempo-by-ear"));
    expectClean(outcome);
  });

  it("blend-by-ear passes", { timeout: 150_000 }, async () => {
    const run = await pairHarness("blend-by-ear", latencySec, { renderSec: 170 });
    const beat = 60 / run.track.grid.bpm;
    const bar = 4 * beat;
    run.session.startCheck(passedBefore(LESSON_IDS, "blend-by-ear"));
    await until(() => run.session.runningPlan() !== null, "the session to start the Check's set-up");
    // The set-up leaves LOW B where it was (centred): the Learner cuts it, as on an FLX4, off the clock.
    await run.renderTo(run.now() + 0.2);
    expect(run.engine.mixerState().channels.B["eq-low"]).toBe(0);
    run.endsBeforeCheck = run.audioEnded();
    const playAt = await setUpThenReady(run, [{ control: "eq-low", deck: "B", value: -1 }]);
    run.plan = run.session.runningPlan();
    const plan = planOf(run);
    const inPos = plan.startPos + 8 * bar;
    const swapPos = inPos + 8 * bar;
    const outPos = inPos + 16 * bar;
    await hearPos(run, playAt, plan.startPos, plan.startPos + bar + 2 * beat);
    expect(caption(run)).toContain("match B: TEMPO B, then jog B");
    matchTempoB(run, 0.03);
    await hearPos(run, playAt, plan.startPos, plan.startPos + 2 * bar);
    await nudgeInLine(run);
    await follow(run, playAt, plan.startPos, [
      ...slide("channel-fader", "B", inPos, 1, beat, 0, 1).map((move, index) => (index === 0 ? { ...move, caption: "fader B up" } : move)),
      { pos: swapPos - 0.03, command: { control: "eq-low", deck: "A", value: -1 }, caption: "swap the bass" },
      { pos: swapPos + 0.03, command: { control: "eq-low", deck: "B", value: 0 } },
      // "Next 1: fader A down slowly, over 2 bars", from the 1 on.
      ...slide("channel-fader", "A", outPos, 8, beat, 1, 0, 32).map((move, index) => (index === 0 ? { ...move, caption: "fader A down slowly" } : move)),
      { pos: outPos + 2 * bar + 0.3, command: { control: "eq-low", deck: "A", value: 0 }, caption: "then LOW A to the middle" },
    ]);
    await hearPos(run, playAt, plan.startPos, outPos + 4.5 * bar);
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "blend-by-ear"));
    expectClean(outcome);
  });
});

/** Sends a Learner's command now; returns when it takes effect (render time). */
function press(run: LessonHarness, command: Parameters<LessonHarness["engine"]["command"]>[0]): number {
  let appliedAt = Number.NaN;
  const stop = run.engine.on("command", (event) => {
    if (event.command === command) appliedAt = event.appliedCtx;
  });
  try {
    const sent = run.engine.command(command, { device: "keyboard" });
    if (!sent.ok) throw new Error(`the engine refused ${JSON.stringify(command)}: ${JSON.stringify(sent.error)}`);
  } finally {
    stop();
  }
  return appliedAt;
}

describe.each(OUTPUTS)("following the captions with pads, loops and FX on $what", ({ latencySec }) => {
  it.each([
    { how: "", checkPad: false },
    { how: ", pressing pad 1 again to hear it", checkPad: true },
  ])("hot-cues passes with the pads set at a Learner's pace (25 s each)$how", { timeout: 120_000 }, async ({ checkPad }) => {
    current = await lessonHarness({ sampleRate: SAMPLE_RATE, lessonId: "hot-cues", track: syntheticLessonTrack(SYNTHETIC_HOUSE), renderSec: 200, latencySec, lookaheadSec: LOOKAHEAD_SEC });
    const run = current;
    const { grid } = run.track;
    const bar = (4 * 60) / grid.bpm;
    const padStarts = hotCuePadPhrases(run.track).map((phrase) => phraseStart(grid, phrase));
    run.session.startCheck();
    await until(() => run.session.runningPlan() !== null, "the session to start the Check");
    run.endsBeforeCheck = run.audioEnded();
    // "Pad n: jog to this phrase's 1 …, Press n, then R": each takes the Learner 25 s.
    let playAt = Number.NaN;
    for (const [index, padStart] of padStarts.entries()) {
      await run.renderTo(run.now() + 25);
      expect(caption(run)).toContain(`Pad ${String(index + 1)}`);
      const here = run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN;
      press(run, { control: "jog-search", deck: "A", value: padStart - here });
      await run.renderTo(run.now() + 0.5);
      press(run, { control: "hot-cue-set", deck: "A", slot: index });
      await run.renderTo(run.now() + 0.5);
      if (checkPad && index === 0) {
        // The hook taught "Press 1 again": it jumps there and plays, until R moves on.
        press(run, { control: "hot-cue", deck: "A", slot: index });
        await run.renderTo(run.now() + 2);
        expect(caption(run)).toContain("Pad 1");
      }
      const stop = run.engine.on("command", (event) => {
        if (event.command.control === "play" && event.command.deck === "A") playAt = event.appliedCtx;
      });
      run.session.ready();
      stop();
    }
    // "Count the bars. Next phrase's 1: Press 1", then each next phrase's 1 after a jump.
    let heardAt = playAt + 8 * bar;
    for (const slot of [0, 1, 2]) {
      await run.renderToHeard(heardAt);
      expect(caption(run)).toContain(`Press ${String(slot + 1)}`);
      const jumpAt = press(run, { control: "hot-cue", deck: "A", slot });
      heardAt = jumpAt + 8 * bar;
    }
    await run.renderToHeard(heardAt - 7 * bar);
    expect({ ended: run.audioEnded() > run.endsBeforeCheck, caption: caption(run) }).toEqual({ ended: false, caption: "Let it ride" });
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "hot-cues"));
    expectClean(outcome);
  });
  it("loop-transition passes with no warning after the whole course: LOW B cut, the bass swapped over A's loop", { timeout: 120_000 }, async () => {
    const run = await pairHarness("loop-transition", latencySec, { renderSec: 170, sameOnB: true });
    const beat = 60 / run.track.grid.bpm;
    const bar = 4 * beat;
    // bass-swap and blend-by-ear passed: the captions swap the bass, and one-bass (warn) is graded.
    const passed = passedBefore(LESSON_IDS, "loop-transition");
    // "Set up: CUE 🎧 B on, LOW B all the way down", off the clock.
    const playAt = await startedCheck(run, passed, [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "eq-low", deck: "B", value: -1 },
    ]);
    const plan = planOf(run);
    // The loop is A's last phrase: it starts a phrase after the Check's.
    const loopPos = plan.startPos + 8 * bar;
    await follow(run, playAt, plan.startPos, [
      { pos: loopPos, command: { control: "loop-in", deck: "A" }, caption: "LOOP IN (D)" },
      { pos: loopPos + 4 * bar, command: { control: "loop-out", deck: "A" }, caption: "LOOP OUT on the 1" },
    ]);
    // A wraps back to the loop's 1 every 4 bars from where LOOP OUT was pressed.
    const loopOneAt = playAt + (loopPos + 4 * bar - plan.startPos);
    await run.renderToHeard(loopOneAt + 4 * bar);
    expect(caption(run)).toContain("On the loop's 1: Press ,");
    press(run, { control: "play", deck: "B" });
    await run.renderToHeard(loopOneAt + 8 * bar);
    expect(caption(run)).toContain("swap the bass. LOW A down, LOW B up");
    press(run, { control: "eq-low", deck: "A", value: -1 });
    press(run, { control: "eq-low", deck: "B", value: 0 });
    await run.renderToHeard(loopOneAt + 12 * bar);
    expect(caption(run)).toContain("EXIT");
    press(run, { control: "loop-exit", deck: "A" });
    await run.renderToHeard(loopOneAt + 12 * bar + 0.5);
    expect(caption(run)).toContain("Fader A down (S), then LOW A to the middle");
    press(run, { control: "channel-fader", deck: "A", value: 0 });
    await run.renderToHeard(loopOneAt + 12 * bar + 0.5 + beat);
    press(run, { control: "eq-low", deck: "A", value: 0 });
    const outcome = await gradedAfterEnd(run, passed);
    expectClean(outcome);
  });

  it("loop-transition passes straight after sync-blend: B in at full EQ, no LOW asked for", { timeout: 120_000 }, async () => {
    const run = await pairHarness("loop-transition", latencySec, { renderSec: 170, sameOnB: true });
    const beat = 60 / run.track.grid.bpm;
    const bar = 4 * beat;
    // An elective: sync-blend and phrases are all it needs. The LOW knobs may be locked, one-bass is not graded.
    const passed = passedBefore(LESSON_IDS, "crossfader");
    // "Set up: CUE 🎧 B on", off the clock.
    const playAt = await startedCheck(run, passed, [{ control: "headphone-cue", deck: "B", value: true }]);
    const plan = planOf(run);
    const loopPos = plan.startPos + 8 * bar;
    await follow(run, playAt, plan.startPos, [
      { pos: loopPos, command: { control: "loop-in", deck: "A" }, caption: "LOOP IN (D)" },
      { pos: loopPos + 4 * bar, command: { control: "loop-out", deck: "A" }, caption: "LOOP OUT on the 1" },
    ]);
    const loopOneAt = playAt + (loopPos + 4 * bar - plan.startPos);
    await run.renderToHeard(loopOneAt + 4 * bar);
    expect(caption(run)).toContain("On the loop's 1: Press ,");
    press(run, { control: "play", deck: "B" });
    await run.renderToHeard(loopOneAt + 8 * bar);
    expect(caption(run)).toContain("EXIT");
    press(run, { control: "loop-exit", deck: "A" });
    await run.renderToHeard(loopOneAt + 8 * bar + 0.5);
    expect(caption(run)).toBe("Fader A down (S)");
    press(run, { control: "channel-fader", deck: "A", value: 0 });
    const outcome = await gradedAfterEnd(run, passed);
    expectClean(outcome);
  });

  it("echo-out passes", { timeout: 120_000 }, async () => {
    const run = await pairHarness("echo-out", latencySec, { renderSec: 170, sameOnB: true });
    const beat = 60 / run.track.grid.bpm;
    const bar = 4 * beat;
    // "Set up: CUE 🎧 B on, ECHO on (V)", off the clock.
    const playAt = await startedCheck(run, [], [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "beat-fx", value: true },
    ]);
    const plan = planOf(run);
    // A plays a whole phrase from its start, then the groove phrase; B comes in on the one after.
    const next = plan.startPos + 16 * bar;
    await follow(run, playAt, plan.startPos, [
      { pos: next - bar, command: { control: "channel-fader", deck: "A", value: 0 }, caption: "At Phrase 2, bar 8: cut A" },
      { pos: next, command: { control: "play", deck: "B" }, caption: "Press , at Phrase 3" },
      { pos: next + beat + 0.5, command: { control: "beat-fx", value: false }, caption: "FX off (V)" },
    ]);
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "echo-out"));
    expectClean(outcome);
  });
});
