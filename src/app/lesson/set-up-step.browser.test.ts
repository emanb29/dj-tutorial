// The unclocked set-up step (owner, 2026-10-18: "Lesson 7 does not give enough prep time"): Lesson 7
// (Your first transition: the cut) opens its Check and its practice with "Set up: … — then R". Deck A
// loops its first phrase meanwhile, nothing is recorded and no timeout runs; R plays A from the phrase
// start, a whole phrase before the cut. In practice the 8-bar count shows, and fades after 2 cuts on
// the phrase in a row. Real engine and recorder, rendered offline (never the speakers).
import { afterEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@audio";
import { lessonDefinition, syntheticLessonTrack, SYNTHETIC_HOUSE } from "@lessons";
import { LESSON_IDS } from "@shared/catalogue.ts";
import { gradedAfterEnd, lessonHarness, passedBefore, summary, synthetic, until, type LessonHarness } from "./lesson-test-support.ts";

const SAMPLE_RATE = 48_000;
const LOOKAHEAD_SEC = 0.0116 + 256 / SAMPLE_RATE;

let current: LessonHarness | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function cutHarness(): Promise<LessonHarness> {
  current = await lessonHarness({
    sampleRate: SAMPLE_RATE,
    lessonId: "cut-on-phrase",
    track: syntheticLessonTrack(SYNTHETIC_HOUSE),
    audio: (context) => synthetic(context, SYNTHETIC_HOUSE),
    partnerAudio: (context) => synthetic(context, SYNTHETIC_HOUSE),
    renderSec: 200,
    latencySec: 0.04,
    lookaheadSec: LOOKAHEAD_SEC,
  });
  return current;
}

function send(run: LessonHarness, command: EngineCommand): void {
  const sent = run.engine.command(command, { device: "keyboard" });
  if (!sent.ok) throw new Error(`the engine refused ${JSON.stringify(command)}: ${JSON.stringify(sent.error)}`);
}

/** R, and the render time A's Play from the start takes effect (or its seek, when A plays on). */
function ready(run: LessonHarness): number {
  let at = Number.NaN;
  const stop = run.engine.on("command", (event) => {
    if ("deck" in event.command && event.command.deck === "A" && event.rejected === null && (event.command.control === "seek" || event.command.control === "play")) at = event.appliedCtx;
  });
  try {
    run.session.ready();
  } finally {
    stop();
  }
  return at;
}

describe("Lesson 7 (Your first transition: the cut): set up, then R", () => {
  it("waits for R off the clock, A looping its first phrase, then the Check runs a whole phrase to the cut and passes", { timeout: 120_000 }, async () => {
    const run = await cutHarness();
    const bar = (4 * 60) / run.track.grid.bpm;
    run.session.startCheck(passedBefore(LESSON_IDS, "cut-on-phrase"));
    await until(() => run.session.setUpPending() !== null, "the Check's set-up step");
    const plan = run.session.runningPlan();
    if (plan === null) throw new Error("no Check plan");
    const ended = run.audioEnded();
    expect(run.session.checkCue()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched — then R");

    // Well past the Check's own timeout, taking it slowly: nothing ends, and A stays in its first phrase.
    send(run, { control: "headphone-cue", deck: "B", value: true });
    const until8Bars = plan.startPos + 8 * bar;
    for (let step = 0; step < 40; step += 1) {
      await run.renderTo(run.now() + (plan.timeoutSec + 10) / 40);
      const pos = run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN;
      expect(pos).toBeGreaterThanOrEqual(plan.startPos - 1e-3);
      // It loops back once the jump is heard: a step of the render past the phrase at most.
      expect(pos).toBeLessThan(until8Bars + 1.5);
    }
    send(run, { control: "channel-fader", deck: "B", value: 1 });
    await run.renderTo(run.now() + 1);
    expect(run.audioEnded()).toBe(ended);
    expect(run.session.setUpPending()).not.toBeNull();
    // No count in a Check, set-up included.
    expect(run.session.phraseCount()).toBeNull();

    // R: A plays from the phrase start; the set-up is kept; a whole phrase, then the cut on the next 1.
    run.endsBeforeCheck = run.audioEnded();
    const playAt = ready(run);
    expect(run.session.setUpPending()).toBeNull();
    expect(run.engine.mixerState().channels.B["channel-fader"]).toBe(1);
    expect(run.engine.deckState("B").playing).toBe(false);
    const cutPos = plan.firstPhraseAction ?? Number.NaN;
    expect(cutPos - plan.startPos).toBeCloseTo(8 * bar, 6);
    await run.renderToHeard(playAt + 2 * bar);
    expect(run.session.checkCue()?.caption).toBe("Count this phrase: cut on the next 1");
    await run.renderToHeard(playAt + (cutPos - plan.startPos) - bar);
    expect(run.session.checkCue()?.caption).toBe("Next phrase: Press , and S on the 1");
    await run.renderToHeard(playAt + (cutPos - plan.startPos));
    send(run, { control: "play", deck: "B" });
    send(run, { control: "channel-fader", deck: "A", value: 0 });
    const outcome = await gradedAfterEnd(run, passedBefore(LESSON_IDS, "cut-on-phrase"));
    expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
  });

  it("practice waits for R after each set-up, and its 8-bar count fades after 2 cuts on the phrase in a row", { timeout: 120_000 }, async () => {
    const run = await cutHarness();
    const bar = (4 * 60) / run.track.grid.bpm;
    const start = lessonDefinition("cut-on-phrase").practiceStart(run.track);
    run.session.preparePractice("practice");
    await until(() => run.session.setUpPending() !== null && run.engine.deckState("A").playing, "practice's set-up step");
    for (const rep of [1, 2]) {
      // Practice's set-up resets fader B: CUE B stays as the Learner left it.
      send(run, { control: "headphone-cue", deck: "B", value: true });
      send(run, { control: "channel-fader", deck: "B", value: 1 });
      await run.renderTo(run.now() + 1);
      expect(run.session.phraseCount()?.shown, `rep ${String(rep)}`).toBe(true);
      const from = ready(run);
      await run.renderToHeard(from + 3 * bar);
      expect(run.session.phraseCount(), `rep ${String(rep)}`).toMatchObject({ bar: 4 });
      await run.renderToHeard(from + 8 * bar);
      send(run, { control: "play", deck: "B" });
      send(run, { control: "channel-fader", deck: "A", value: 0 });
      await run.renderTo(run.now() + 0.5);
      // Practice goes round 4 bars after the cut, back to the set-up, waiting for R again.
      for (let tries = 0; run.session.setUpPending() === null; tries += 1) {
        if (tries > 200) throw new Error(`Practice never went back to its set-up after rep ${String(rep)}.`);
        await run.renderTo(run.now() + 0.1);
      }
      await run.renderTo(run.now() + 0.5);
      const pos = run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN;
      expect(pos).toBeLessThan(start + 8 * bar + 0.2);
    }
    expect(run.observed.filter((observation) => observation.kind === "cut")).toEqual([
      expect.objectContaining({ kind: "cut", onPhrase: true }),
      expect.objectContaining({ kind: "cut", onPhrase: true }),
    ]);
    // Two right in a row: the count steps aside, so the Learner counts by ear.
    expect(run.session.phraseCount()?.shown).toBe(false);
  });
});
