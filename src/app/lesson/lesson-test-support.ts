// Helpers for browser tests that run a LessonSession on a real engine and recorder, rendered offline
// (never the speakers), with the output latency a real AudioContext reports: a Learner who acts on what
// they hear presses `latencySec` after the audio was rendered. The wall clock (`performance.now()`)
// follows the render, as it does on a real output, so the session's timeouts, holds and "bars after"
// ends see the time the music took, not how fast the machine rendered it.
import { audioContextClock, createAudioEngine, type AudioEngine, type EngineCommand } from "@audio";
import { lessonDefinition, synthesizeHouse, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack, trackOnDeck, type BuiltLessonId, type CheckPlan, type LessonTrack, type Observation } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { LessonSession } from "./lesson-session.ts";

export interface LessonHarness {
  readonly session: LessonSession;
  readonly track: LessonTrack;
  readonly engine: AudioEngine;
  readonly latencySec: number;
  /** The plan of the session's next Check (the session counts Checks from a random start: read it after `startedCheck`). */
  plan: CheckPlan | null;
  /** `audioEnded()` when the running Check started: it has ended once the count is past this. */
  endsBeforeCheck: number;
  /** Renders up to context time `ctx` (rounded up to a render quantum) and stops there. */
  readonly renderTo: (ctx: number) => Promise<void>;
  /** Renders until context time `ctx` is heard: the output latency later. */
  readonly renderToHeard: (ctx: number) => Promise<void>;
  /** Context (render) time now. */
  readonly now: () => number;
  /** Heard time now: what the Learner hears is the render `latencySec` ago. */
  readonly heardNow: () => number;
  readonly audioEnded: () => number;
  readonly observed: Observation[];
  /** Closes the session and the engine, and gives `performance.now()` back. */
  readonly close: () => Promise<void>;
}

/** The real wall clock, whatever a harness has done to `performance.now()`. */
const realNow = () => Performance.prototype.now.call(performance);

/** The synthetic pair (A 124 BPM, B 121 BPM), one mono buffer each. */
export function synthetic(context: BaseAudioContext, layout: typeof SYNTHETIC_HOUSE): AudioBuffer {
  const samples = synthesizeHouse(layout, context.sampleRate);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

export const pairTrack = (): LessonTrack => ({ ...syntheticLessonTrack(SYNTHETIC_HOUSE), partner: syntheticLessonTrack(SYNTHETIC_PARTNER) });

/** An engine on an offline render that keeps the time a real output does (see the top of this file). */
export interface OfflineRun {
  readonly engine: AudioEngine;
  readonly context: OfflineAudioContext;
  readonly latencySec: number;
  readonly renderTo: (ctx: number) => Promise<void>;
  readonly renderToHeard: (ctx: number) => Promise<void>;
  readonly now: () => number;
  readonly heardNow: () => number;
  /** Closes the engine and gives `performance.now()` back. */
  readonly close: () => Promise<void>;
}

export async function offlineRun(options: {
  readonly sampleRate: number;
  readonly renderSec: number;
  /** How far the output timestamp trails the render (wired ≈ 40 ms, Bluetooth ≈ 250 ms). */
  readonly latencySec?: number;
  /** The engine's scheduling lookahead (a real context: baseLatency + 2 quanta). */
  readonly lookaheadSec?: number;
}): Promise<OfflineRun> {
  const { sampleRate } = options;
  const latencySec = options.latencySec ?? 0;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(options.renderSec * sampleRate), sampleRate });
  const wallAtStart = realNow();
  Object.defineProperty(performance, "now", { configurable: true, value: () => wallAtStart + context.currentTime * 1000 });
  const output = {
    state: "running",
    get currentTime() {
      return context.currentTime;
    },
    getOutputTimestamp: () => ({ contextTime: context.currentTime - latencySec, performanceTime: performance.now() }),
  } as unknown as AudioContext;
  const clock = latencySec === 0 ? undefined : audioContextClock(output);
  const engine = await createAudioEngine({ context, masterTempo: false, ...(clock === undefined ? {} : { clock }), lookaheadSec: options.lookaheadSec ?? 0 });
  const quantum = 128 / sampleRate;
  let started = false;
  const renderTo = async (ctx: number) => {
    if (ctx <= context.currentTime) return;
    const reached = context.suspend(Math.ceil(ctx / quantum - 1e-9) * quantum);
    if (started) await context.resume();
    else {
      started = true;
      void context.startRendering();
    }
    await reached;
    // Let the session's watches (25–250 ms intervals) see the new position.
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  return {
    engine,
    context,
    latencySec,
    renderTo,
    renderToHeard: (ctx) => renderTo(ctx + Math.max(0, latencySec)),
    now: () => context.currentTime,
    heardNow: () => context.currentTime - latencySec,
    close: async () => {
      await engine.close();
      Reflect.deleteProperty(performance, "now");
    },
  };
}

export async function lessonHarness(options: {
  readonly sampleRate: number;
  readonly lessonId: BuiltLessonId;
  readonly track: LessonTrack;
  readonly renderSec: number;
  readonly audio?: (context: BaseAudioContext) => AudioBuffer;
  /** Deck B's audio: `track.partner`, or `track` again without one. */
  readonly partnerAudio?: (context: BaseAudioContext) => AudioBuffer;
  readonly latencySec?: number;
  readonly lookaheadSec?: number;
}): Promise<LessonHarness> {
  const { track } = options;
  const run = await offlineRun(options);
  const { engine, context } = run;
  const audio = (options.audio ?? ((each) => synthetic(each, SYNTHETIC_HOUSE)))(context);
  const loadedA = await engine.load("A", audio, { trackId: track.trackId, grid: track.grid });
  if (!loadedA.ok) throw new Error(`deck A refused the track: ${JSON.stringify(loadedA.error)}`);
  if (options.partnerAudio !== undefined) {
    // The partner, or the Lesson track again for a Lesson that plays it on both decks (nudge-phase).
    const onB = trackOnDeck(track, "B");
    const loadedB = await engine.load("B", options.partnerAudio(context), { trackId: onB.trackId, grid: onB.grid });
    if (!loadedB.ok) throw new Error(`deck B refused its track: ${JSON.stringify(loadedB.error)}`);
  }
  const definition = lessonDefinition(options.lessonId);
  let ended = 0;
  const observed: Observation[] = [];
  const session = new LessonSession(
    engine,
    definition,
    track,
    audio,
    "learner-1",
    {
      observed: (observation) => observed.push(observation),
      audioEnded: () => (ended += 1),
      checkFailed: (message) => {
        throw new Error(message);
      },
    },
    options.partnerAudio !== undefined,
  );
  return {
    ...run,
    session,
    track,
    plan: null,
    endsBeforeCheck: 0,
    audioEnded: () => ended,
    observed,
    close: async () => {
      session.close();
      await run.close();
    },
  };
}

/** Waits, on the wall clock, for something the session does on its own timers or promises. */
export async function until(done: () => boolean, what: string, waitMs = 15_000): Promise<void> {
  const deadline = realNow() + waitMs;
  while (!done()) {
    if (realNow() > deadline) throw new Error(`Gave up waiting for ${what}; is the machine badly overloaded, or did the session stop?`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits, with the render suspended, until the session has sent a Play to deck A; returns its applied time. */
async function untilPlayedA(run: LessonHarness, start: () => void, what: string): Promise<number> {
  const played: { at: number | null } = { at: null };
  const stop = run.engine.on("command", (event) => {
    if (event.command.control === "play" && event.command.deck === "A" && event.rejected === null && event.device !== "engine") played.at = event.appliedCtx;
  });
  try {
    start();
    await until(() => played.at !== null, what);
  } finally {
    stop();
  }
  return played.at ?? Number.NaN;
}

/** Practice from its set-up; returns when deck A's Play takes effect (render time). */
export function startedPractice(run: LessonHarness): Promise<number> {
  return untilPlayedA(run, () => {
    run.session.preparePractice();
  }, "the session to play the practice");
}

/**
 * Starts the Check and waits, with the render suspended, until the session has cued and played deck A.
 * Returns when A's Play takes effect (render time = when A's start position is rendered, and heard
 * `latencySec` later). Sets `run.plan` to the plan the session used, for a Learner who has passed
 * `passed` (the plan's captions may build on them).
 */
export async function startedCheck(run: LessonHarness, passed: readonly LessonId[] = [], setUp: readonly EngineCommand[] = []): Promise<number> {
  const firstPlay = await untilPlayedA(run, () => {
    run.session.startCheck(passed);
  }, "the session to play the Check");
  run.plan = run.session.runningPlan();
  run.endsBeforeCheck = run.audioEnded();
  if (run.plan?.setUp === undefined) {
    if (setUp.length > 0) throw new Error("This Check has no set-up step for the set-up moves.");
    return firstPlay;
  }
  return setUpThenReady(run, setUp);
}

/**
 * A Check's set-up step, off the clock: the Learner reads "Set up: …", makes `moves` at their own pace
 * while A loops its first phrase, then presses R. Returns when A's Play from the Check's start takes
 * effect (render time).
 */
export async function setUpThenReady(run: LessonHarness, moves: readonly EngineCommand[]): Promise<number> {
  await run.renderTo(run.now() + 0.5);
  const caption = run.session.checkCue()?.caption ?? "";
  if (!caption.startsWith("Set up:")) throw new Error(`The Learner expects the set-up step, but the caption is ${JSON.stringify(caption)}`);
  for (const command of moves) {
    const sent = run.engine.command(command, { device: "keyboard" });
    if (!sent.ok) throw new Error(`the engine refused ${JSON.stringify(command)}: ${JSON.stringify(sent.error)}`);
    await run.renderTo(run.now() + 0.3);
  }
  // Taking a while over it: the clock does not run until R.
  await run.renderTo(run.now() + 3);
  return untilPlayedA(run, () => {
    run.session.ready();
  }, "the session to play the Check after R");
}

/** A Learner's move: `command` sent as deck A's track position `pos` is heard. */
export interface Move {
  readonly pos: number;
  readonly command: EngineCommand;
  /** Part of the live caption the Learner is following when they make this move. */
  readonly caption?: string;
}

/**
 * Sends each command as A's track position `pos` is heard, A having started from `fromPos` at render
 * time `playAt` at its own tempo (rate `rateA`, 1 = the track's): the render is `latencySec` past that.
 */
export async function follow(run: LessonHarness, playAt: number, fromPos: number, moves: readonly Move[], rateA = 1): Promise<void> {
  for (const { pos, command, caption } of [...moves].sort((a, b) => a.pos - b.pos)) {
    await run.renderToHeard(playAt + (pos - fromPos) / rateA);
    const showing = run.session.checkCue()?.caption ?? null;
    if (caption !== undefined && !(showing?.includes(caption) ?? false)) {
      throw new Error(`At A's position ${pos.toFixed(2)} s the Learner follows "${caption}", but the caption is ${JSON.stringify(showing)}`);
    }
    const sent = run.engine.command(command, { device: "keyboard" });
    if (!sent.ok) throw new Error(`the engine refused ${JSON.stringify(command)}: ${JSON.stringify(sent.error)}`);
  }
}

/** How far B's beat is ahead of A's as heard at `heardCtx`, in beats, wrapped to ±½. */
export function phaseOffBeats(run: LessonHarness, heardCtx: number): number {
  const a = run.engine.playheadAt("A", heardCtx);
  const b = run.engine.playheadAt("B", heardCtx);
  if (a?.beat == null || b?.beat == null) throw new Error("both decks need a grid to hear their phase");
  const off = b.beat - a.beat;
  return off - Math.round(off);
}

/**
 * What a Learner does on hearing two kicks: holds jog B (a `bend` of the rate, the keys' size) the way
 * that brings B back over A, for as long as that takes, then lets go. Starts as heard now.
 */
export async function nudgeInLine(run: LessonHarness, bend = 0.04): Promise<void> {
  const off = phaseOffBeats(run, run.heardNow());
  const deckB = run.engine.deckState("B");
  const bpmB = (run.track.partner ?? run.track).grid.bpm * deckB.tempoRate;
  const seconds = Math.abs(off) / (bend * (bpmB / 60));
  const send = (value: number) => {
    const sent = run.engine.command({ control: "jog-bend", deck: "B", value }, { device: "keyboard" });
    if (!sent.ok) throw new Error(`the engine refused a jog bend: ${JSON.stringify(sent.error)}`);
  };
  send(off > 0 ? -bend : bend);
  await run.renderTo(run.now() + seconds);
  send(0);
}

/** TEMPO B set so B plays at A's BPM, `offBpm` off (a Learner's ear is not exact). */
export function matchTempoB(run: LessonHarness, offBpm = 0): void {
  const bpmA = run.track.grid.bpm * run.engine.deckState("A").tempoRate;
  const gridB = (run.track.partner ?? run.track).grid.bpm;
  const range = run.engine.deckState("B").tempoRangePercent;
  const sent = run.engine.command({ control: "tempo", deck: "B", value: (((bpmA + offBpm) / gridB - 1) * 100) / range }, { device: "keyboard" });
  if (!sent.ok) throw new Error(`the engine refused TEMPO B: ${JSON.stringify(sent.error)}`);
}

/** A fader slid from `from` to `to` over `beats` beats of A, starting at A's position `pos`, in `steps` even steps. */
export function slide(control: "channel-fader" | "crossfader" | "filter", deck: "A" | "B", pos: number, beats: number, beatSec: number, from: number, to: number, steps = 10): Move[] {
  return Array.from({ length: steps }, (_, step): Move => {
    const value = from + ((to - from) * (step + 1)) / steps;
    const command: EngineCommand = control === "crossfader" ? { control, value } : { control, deck, value };
    return { pos: pos + (step + 1) * (beats / steps) * beatSec, command };
  });
}

/** Plays on, a few frames at a time, until the Check's audio part ends by itself (at most `maxSec` more), then grades. */
export async function gradedAfterEnd(run: LessonHarness, passed: readonly LessonId[], answers: Readonly<Record<string, number>> = {}, maxSec = 30): Promise<CheckResult | VoidAttempt> {
  const giveUpAt = run.now() + maxSec;
  while (run.audioEnded() <= run.endsBeforeCheck) {
    if (run.now() > giveUpAt) throw new Error(`The Check's audio part did not end within ${String(maxSec)} s more of music`);
    await run.renderTo(run.now() + 0.05);
  }
  const graded = await run.session.grade(answers, passed);
  if (!graded.ok) throw new Error(graded.message);
  return graded.outcome;
}

export function summary(outcome: CheckResult | VoidAttempt) {
  return "criteria" in outcome ? outcome.criteria.map(({ id, status, measured, detail }) => ({ id, status, measured, detail })) : outcome.outcome;
}

/** Every Lesson before `lessonId` in the catalogue's order, as passed. */
export function passedBefore(order: readonly LessonId[], lessonId: LessonId): LessonId[] {
  return order.slice(0, order.indexOf(lessonId));
}
