// LessonSession end to end on a real engine and recorder, rendered offline (never the speakers), as the
// owner runs a Lesson: hook and practice first (the deck plays the Check's sections already), then
// Checks in a row with every tap on a heard beat, at both common hardware sample rates.
import { afterEach, describe, expect, it } from "vitest";
import { createAudioEngine, type AudioEngine } from "@audio";
import { lessonDefinition, lessonTrackFromKnownGrid, SYNTHETIC_HOUSE, synthesizeHouse, syntheticLessonTrack, type BuiltLessonId, type CheckPlan, type LessonTrack } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { knownGridFromMeta } from "@tracks";
import { LessonSession } from "./lesson-session.ts";

/** "Lamplight Moths", the Original of the owner's report: 123 BPM, bar 1 at 0 s. */
const LAMPLIGHT_MOTHS = {
  bpm: 123,
  firstDownbeatSec: 0,
  bars: 176,
  phrases: [
    { startBar: 0, lengthBars: 32, section: "intro" },
    { startBar: 32, lengthBars: 16, section: "build" },
    { startBar: 48, lengthBars: 32, section: "drop" },
    { startBar: 80, lengthBars: 16, section: "breakdown" },
    { startBar: 96, lengthBars: 16, section: "build" },
    { startBar: 112, lengthBars: 32, section: "drop" },
    { startBar: 144, lengthBars: 32, section: "outro" },
  ],
} as const;
/** Enough of the Original for Lesson 2's Check, which ends at bar 25 (47 s in). */
const ORIGINAL_SEC = 60;

let engine: AudioEngine | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
});

function lamplightMoths(): LessonTrack {
  // `knownGridFromMeta` takes the full meta; only the fields it reads matter here.
  const meta = { ...LAMPLIGHT_MOTHS, durationSec: ORIGINAL_SEC } as unknown as Parameters<typeof knownGridFromMeta>[0];
  return lessonTrackFromKnownGrid({ id: "originals:001", title: "Lamplight Moths", attribution: { text: "an original", url: null } }, knownGridFromMeta(meta));
}

/** A steady tone: the meters hear music the whole time, so only the taps decide the Check. */
function toneBuffer(context: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.round(seconds * context.sampleRate);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  const samples = Float32Array.from({ length }, (_, index) => 0.25 * Math.sin((2 * Math.PI * 220 * index) / context.sampleRate));
  buffer.copyToChannel(samples, 0);
  buffer.copyToChannel(samples, 1);
  return buffer;
}

interface Harness {
  readonly session: LessonSession;
  readonly track: LessonTrack;
  readonly plan: CheckPlan;
  readonly engine: AudioEngine;
  /** Renders up to heard time `ctx` (rounded up to a render quantum) and stops there. */
  readonly renderTo: (ctx: number) => Promise<void>;
  readonly now: () => number;
  readonly audioEnded: () => number;
}

async function harness(options: {
  readonly sampleRate: number;
  readonly lessonId: BuiltLessonId;
  readonly track: LessonTrack;
  readonly audio: (context: BaseAudioContext) => AudioBuffer;
  readonly renderSec: number;
}): Promise<Harness> {
  const { sampleRate, track } = options;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(options.renderSec * sampleRate), sampleRate });
  const running = await createAudioEngine({ context, masterTempo: false });
  engine = running;
  const audio = options.audio(context);
  expect(await running.load("A", audio, { trackId: track.trackId, grid: track.grid })).toEqual({ ok: true });
  const definition = lessonDefinition(options.lessonId);
  let ended = 0;
  const listener = {
    observed: () => undefined,
    audioEnded: () => (ended += 1),
    checkFailed: (message: string) => {
      throw new Error(message);
    },
  };
  const session = new LessonSession(running, definition, track, audio, "learner-1", listener, false);
  const quantum = 128 / sampleRate;
  let started = false;
  const renderTo = async (ctx: number) => {
    const reached = context.suspend(Math.ceil(ctx / quantum - 1e-9) * quantum);
    if (started) await context.resume();
    else {
      started = true;
      void context.startRendering();
    }
    await reached;
    // Let the session's watch (a 25 ms interval) see the new position. Nothing graded depends on it
    // running in this time: the Check's end is waited for (`until`) and its start too (`startedCheck`).
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  return { session, track, plan: definition.planCheck(track), engine: running, renderTo, now: () => context.currentTime, audioEnded: () => ended };
}

/** Waits, on the wall clock, for something the session does on its own timers or promises. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Gave up after 10 s waiting for ${what}; is the machine badly overloaded, or did the session stop?`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Starts the Check and waits, with the render suspended, until the session has cued and played it.
 * The session plays the Check from a promise callback: rendering on before then lets the deck start
 * late by however long the main thread took to get there, which shifts every heard beat off the taps.
 */
async function startedCheck(run: Harness): Promise<void> {
  let played = false;
  const stop = run.engine.on("command", (event) => {
    if (event.command.control === "play" && event.command.deck === "A" && event.rejected === null) played = true;
  });
  try {
    run.session.startCheck();
    await until(() => played, "the session to play the Check");
  } finally {
    stop();
  }
}

/**
 * One Check: taps on each track `position` as it is heard, then lets the Check end by itself and grades.
 * Offline there is no lookahead: the Check's cue and Play take effect at the current render time.
 */
async function checkWithTaps(
  run: Harness,
  positions: readonly number[],
  answers: Readonly<Record<string, number>>,
  passed: readonly LessonId[],
): Promise<CheckResult | VoidAttempt> {
  await startedCheck(run);
  const playAt = run.now();
  const heard = (pos: number) => playAt + (pos - run.plan.startPos);
  for (const pos of positions) {
    await run.renderTo(heard(pos));
    run.engine.command({ control: "tap" }, { device: "keyboard" });
  }
  if (run.plan.endWhen.kind !== "position") throw new Error("this Check ends at a position");
  const endedBefore = run.audioEnded();
  await run.renderTo(heard(run.plan.endWhen.pos) + 0.1);
  await until(() => run.audioEnded() === endedBefore + 1, "the session's watch to end the Check's audio part");
  const graded = await run.session.grade(answers, passed);
  if (!graded.ok) throw new Error(graded.message);
  return graded.outcome;
}

function summary(outcome: CheckResult | VoidAttempt) {
  return "criteria" in outcome ? outcome.criteria.map(({ id, status, detail }) => ({ id, status, detail })) : outcome.outcome;
}

describe.each([44_100, 48_000])("LessonSession at %i Hz", (sampleRate) => {
  it("beats-and-bars on Lamplight Moths: three Checks in a row after practice pass with every tap on a heard beat", { timeout: 60_000 }, async () => {
    const run = await harness({ sampleRate, lessonId: "beats-and-bars", track: lamplightMoths(), audio: (context) => toneBuffer(context, ORIGINAL_SEC), renderSec: 40 + 3 * 40 });
    const beatSec = 60 / run.track.grid.bpm;
    // Practice loops bars 8–23 from the start: it plays through both of the Check's sections.
    run.session.preparePractice();
    await run.renderTo(36);

    // Every beat of bars 9–16 (beats 32–63), then only the 1s of bars 17–24 (beats 64, 68 … 92).
    const beats = [...Array.from({ length: 32 }, (_, index) => 32 + index), ...Array.from({ length: 8 }, (_, index) => 64 + 4 * index)];
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) outcomes.push(await checkWithTaps(run, beats.map((beat) => beat * beatSec), {}, ["deck-basics"]));
    run.session.close();

    for (const outcome of outcomes) {
      expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
      expect(summary(outcome)).toEqual([
        { id: "beats-and-bars.beat-taps", status: "met", detail: { matched: 32, extras: 0, targets: 32 } },
        { id: "beats-and-bars.downbeat-taps", status: "met", detail: { matched: 8, extras: 0, targets: 8, wrongBeat: 0 } },
      ]);
    }
  });

  it("beats-and-bars: a deck stopped before the downbeat section voids the attempt instead of failing it", { timeout: 30_000 }, async () => {
    const run = await harness({ sampleRate, lessonId: "beats-and-bars", track: lamplightMoths(), audio: (context) => toneBuffer(context, ORIGINAL_SEC), renderSec: 30 });
    await startedCheck(run);
    await run.renderTo(run.now() + 10);
    run.engine.command({ control: "pause", deck: "A" }, { device: "keyboard" });
    await run.renderTo(run.now() + 1);
    const graded = await run.session.grade({}, ["deck-basics"]);
    run.session.close();
    expect(graded.ok && graded.outcome.outcome).toEqual({ kind: "void", reason: "sectionNotHeard" });
  });

  it("deck-basics: the Check ends when the fader reaches the bottom, not on the way down", { timeout: 30_000 }, async () => {
    const run = await harness({ sampleRate, lessonId: "deck-basics", track: lamplightMoths(), audio: (context) => toneBuffer(context, ORIGINAL_SEC), renderSec: 30 });
    // The Learner plays this Check (X): the session only cues it, with the deck stopped.
    let cued = false;
    const stop = run.engine.on("command", (event) => {
      if (event.command.control === "seek") cued = true;
    });
    run.session.startCheck();
    await until(() => cued, "the session to cue the Check");
    stop();
    expect(run.engine.command({ control: "play", deck: "A" }, { device: "touch" })).toEqual({ ok: true });
    const fader = (value: number) => run.engine.command({ control: "channel-fader", deck: "A", value }, { device: "touch" });
    await run.renderTo(run.now() + 1);
    fader(1);
    await run.renderTo(run.now() + 3);
    // A finger on its way down (or a move the main thread has not got to yet): the attempt goes on.
    fader(0.03);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(run.audioEnded()).toBe(0);
    await run.renderTo(run.now() + 0.2);
    fader(0);
    await run.renderTo(run.now() + 1);
    await until(() => run.audioEnded() === 1, "the Check to end once the fader is down");
    const graded = await run.session.grade({}, []);
    run.session.close();
    expect(graded.ok && summary(graded.outcome)).toContainEqual({ id: "deck-basics.fade-out", status: "met", detail: undefined });
  });

  it("phrases on the synthetic groove: a Check after practice passes with a tap on each phrase start", { timeout: 60_000 }, async () => {
    const track = syntheticLessonTrack(SYNTHETIC_HOUSE);
    const audio = (context: BaseAudioContext) => {
      const samples = synthesizeHouse(SYNTHETIC_HOUSE, context.sampleRate);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      return buffer;
    };
    const run = await harness({ sampleRate, lessonId: "phrases", track, audio, renderSec: 30 + 150 });
    // Practice loops 24 bars from bar 7: it plays the start of the Check's tap section (bar 9).
    run.session.preparePractice();
    await run.renderTo(25);

    // Phrases 2–9 start on beats 32, 64 … 256; the breakdown is the 4th tapped phrase, the drop the 6th.
    const phraseStarts = Array.from({ length: 8 }, (_, index) => (32 * (index + 1) * 60) / track.grid.bpm);
    const outcome = await checkWithTaps(run, phraseStarts, { breakdown: 4, drop: 6 }, ["deck-basics", "beats-and-bars"]);
    run.session.close();
    expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
    // Only this attempt's phrase starts are targets, not the ones practice played.
    expect(summary(outcome)).toContainEqual({ id: "phrases.phrase-taps", status: "met", detail: { matched: 8, extras: 0, targets: 8 } });
  });
});
