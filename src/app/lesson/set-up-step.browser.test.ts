// The unclocked set-up step (maintainer, 2026-10-18: "Lesson 7 does not give enough prep time"; 2026-10-19:
// "Don't require a press of R after matching the controller"): Lesson 7 (Your first transition: the
// cut) opens its Check and its practice with "Set up: …". Deck A loops its first phrase meanwhile,
// nothing is recorded and no timeout runs. Once everything the caption asks is done, the step goes on
// by itself where A's phrase comes round: A plays from the phrase start, a whole phrase before the cut.
// R goes at once. In practice the 8-bar count shows, and fades after 2 cuts on the phrase in a row.
// Real engine and recorder, rendered offline (never the speakers).
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

/** How the set-up step went on: the render time A's Play from the start (or its seek, when A plays on) takes effect, and where A was heard then. */
interface Went {
  readonly at: number;
  readonly heardPos: number;
}

/**
 * Watches for the set-up step to go on while `go` runs: the session's first command to A once the step
 * has gone (its pause, seek and Play are sent together, so they take effect at the same render time).
 */
async function whenGone(run: LessonHarness, go: () => Promise<void> | void): Promise<Went> {
  const seen: { went: Went | null } = { went: null };
  const stop = run.engine.on("command", (event) => {
    if (seen.went !== null || run.session.setUpPending() !== null || event.device !== "keyboard" || event.rejected !== null) return;
    const { command } = event;
    if ("deck" in command && command.deck === "A" && (command.control === "pause" || command.control === "seek" || command.control === "play")) {
      const heard = run.engine.playhead("A");
      seen.went = { at: event.appliedCtx, heardPos: heard.ok ? heard.positionSec : Number.NaN };
    }
  });
  try {
    await go();
  } finally {
    stop();
  }
  if (seen.went === null) throw new Error("the set-up step never went on");
  return seen.went;
}

/** Renders, a little at a time, until the set-up step has gone on by itself. */
async function renderUntilGone(run: LessonHarness, withinSec: number): Promise<Went> {
  return whenGone(run, async () => {
    const until = run.now() + withinSec;
    while (run.session.setUpPending() !== null) {
      if (run.now() > until) throw new Error(`The set-up step did not go on within ${String(withinSec)} s`);
      await run.renderTo(run.now() + 0.1);
    }
  });
}

describe("Lesson 7 (Your first transition: the cut): set up, and it goes on by itself", () => {
  it("waits off the clock, A looping its first phrase, until all is set; then goes at the phrase's end, and the Check passes", { timeout: 120_000 }, async () => {
    const run = await cutHarness();
    const bar = (4 * 60) / run.track.grid.bpm;
    run.session.startCheck(passedBefore(LESSON_IDS, "cut-on-phrase"));
    await until(() => run.session.setUpPending() !== null, "the Check's set-up step");
    const plan = run.session.runningPlan();
    if (plan === null) throw new Error("no Check plan");
    const ended = run.audioEnded();
    expect(run.session.checkCue()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");

    // Well past the Check's own timeout, half set up: nothing ends or goes, and A stays in its first phrase.
    send(run, { control: "headphone-cue", deck: "B", value: true });
    const phraseEnd = plan.startPos + 8 * bar;
    for (let step = 0; step < 40; step += 1) {
      await run.renderTo(run.now() + (plan.timeoutSec + 10) / 40);
      const pos = run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN;
      expect(pos).toBeGreaterThanOrEqual(plan.startPos - 1e-3);
      // It loops back once the jump is heard: a step of the render past the phrase at most.
      expect(pos).toBeLessThan(phraseEnd + 1.5);
    }
    expect(run.audioEnded()).toBe(ended);
    expect(run.session.setUpPending()).not.toBeNull();
    // No count in a Check, set-up included.
    expect(run.session.phraseCount()).toBeNull();

    // Fader B up: all set. It says so, and waits for A's phrase to come round (no R).
    send(run, { control: "channel-fader", deck: "B", value: 1 });
    await run.renderTo(run.now() + 0.2);
    expect(run.session.checkCue()?.caption).toBe("All set: starts on the next phrase");
    expect(run.session.setUpPending()).not.toBeNull();
    run.endsBeforeCheck = run.audioEnded();
    const went = await renderUntilGone(run, 8 * bar + 1);
    // At the end of A's phrase, where it would have looped: the Check starts from the phrase start.
    expect(went.heardPos).toBeGreaterThanOrEqual(phraseEnd - 1e-3);
    expect(went.heardPos).toBeLessThan(phraseEnd + 0.3);
    expect(run.engine.mixerState().channels.B["channel-fader"]).toBe(1);
    expect(run.engine.deckState("B").playing).toBe(false);
    await until(() => run.session.runningPlan() !== null && run.engine.deckState("A").playing, "the Check to play");
    const playAt = went.at;
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

  it("goes back to waiting if something is undone before the phrase ends", { timeout: 60_000 }, async () => {
    const run = await cutHarness();
    const bar = (4 * 60) / run.track.grid.bpm;
    run.session.startCheck(passedBefore(LESSON_IDS, "cut-on-phrase"));
    await until(() => run.session.setUpPending() !== null, "the Check's set-up step");
    send(run, { control: "headphone-cue", deck: "B", value: true });
    send(run, { control: "channel-fader", deck: "B", value: 1 });
    await run.renderTo(run.now() + 0.2);
    expect(run.session.checkCue()?.caption).toBe("All set: starts on the next phrase");
    // Trims apart: no longer set.
    send(run, { control: "trim", deck: "B", value: run.engine.mixerState().channels.A.trim - 0.4 });
    await run.renderTo(run.now() + 0.2);
    expect(run.session.checkCue()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");
    await run.renderTo(run.now() + 10 * bar);
    expect(run.session.setUpPending()).not.toBeNull();
    expect(run.session.runningPlan()?.setUp).toBeDefined();
  });

  it("practice goes on by itself after each set-up (R goes at once), and its 8-bar count fades after 2 cuts on the phrase in a row", { timeout: 120_000 }, async () => {
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
      expect(run.session.setUpPending()?.caption, `rep ${String(rep)}`).toBe("All set: starts on the next phrase");
      // Rep 1 waits for the phrase to come round; rep 2 presses R, the manual way, and goes at once.
      const went =
        rep === 1
          ? await renderUntilGone(run, 8 * bar + 1)
          : await whenGone(run, () => {
              run.session.ready();
            });
      const from = went.at;
      if (rep === 1) expect(went.heardPos).toBeGreaterThanOrEqual(start + 8 * bar - 1e-3);
      else expect(went.heardPos).toBeLessThan(start + 8 * bar - bar);
      await run.renderToHeard(from + 3 * bar);
      expect(run.session.phraseCount(), `rep ${String(rep)}`).toMatchObject({ bar: 4 });
      await run.renderToHeard(from + 8 * bar);
      send(run, { control: "play", deck: "B" });
      send(run, { control: "channel-fader", deck: "A", value: 0 });
      await run.renderTo(run.now() + 0.5);
      // Practice goes round 4 bars after the cut, back to the set-up.
      for (let tries = 0; run.session.setUpPending() === null; tries += 1) {
        if (tries > 200) throw new Error(`Practice never went back to its set-up after rep ${String(rep)}.`);
        await run.renderTo(run.now() + 0.1);
      }
      await run.renderTo(run.now() + 0.5);
      const pos = run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN;
      expect(pos).toBeLessThan(start + 8 * bar + 0.2);
      // Fader B is down again: the step waits.
      expect(run.session.setUpPending()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");
    }
    expect(run.observed.filter((observation) => observation.kind === "cut")).toEqual([
      expect.objectContaining({ kind: "cut", onPhrase: true }),
      expect.objectContaining({ kind: "cut", onPhrase: true }),
    ]);
    // Two right in a row: the count steps aside, so the Learner counts by ear.
    expect(run.session.phraseCount()?.shown).toBe(false);
  });
});
