// LessonSession end to end on a real engine and recorder, rendered offline (never the speakers), as the
// owner runs a Lesson: hook and practice first (the deck plays the Check's sections already), then
// Checks in a row with every tap on a heard beat, at both common hardware sample rates.
import { afterEach, describe, expect, it } from "vitest";
import { audioContextClock, createAudioEngine, type AudioEngine, type EngineCommand } from "@audio";
import {
  blendPositions,
  lessonDefinition,
  lessonTrackFromKnownGrid,
  practiceLoopFor,
  SYNTHETIC_HOUSE,
  SYNTHETIC_PARTNER,
  synthesizeHouse,
  syntheticLessonTrack,
  type BuiltLessonId,
  type CheckPlan,
  type LessonTrack,
  type Observation,
} from "@lessons";
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
  Reflect.deleteProperty(performance, "now");
});

/** The real wall clock, whatever a harness has done to `performance.now()`. */
const realNow = () => Performance.prototype.now.call(performance);

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
  /** Renders up to context time `ctx` (rounded up to a render quantum) and stops there. */
  readonly renderTo: (ctx: number) => Promise<void>;
  /** Renders until context time `ctx` is heard: the output latency later. */
  readonly renderToHeard: (ctx: number) => Promise<void>;
  /** Context (render) time now. */
  readonly now: () => number;
  /** When the Check's Play took effect on deck A, once it has. */
  readonly playedAt: () => number;
  readonly audioEnded: () => number;
}

async function harness(options: {
  readonly sampleRate: number;
  readonly lessonId: BuiltLessonId;
  readonly track: LessonTrack;
  readonly audio: (context: BaseAudioContext) => AudioBuffer;
  readonly renderSec: number;
  /** Deck B's audio, for a Lesson that mixes `track` with `track.partner`. */
  readonly partnerAudio?: (context: BaseAudioContext) => AudioBuffer;
  /** Every observation the session makes, in order. */
  readonly observed?: Observation[];
  /**
   * How far the output timestamp's contextTime trails what is rendered, as a real AudioContext reports
   * it (macOS Bluetooth: 150–300 ms). Negative: the timestamp runs ahead of the render (a stale one
   * extrapolated across a late callback, or the high side of an ISS-84 jump). Default 0: heard time is
   * render time, as offline.
   */
  readonly latencySec?: number;
  /** The engine's scheduling lookahead (a real context: baseLatency + 2 quanta). Default 0. */
  readonly lookaheadSec?: number;
}): Promise<Harness> {
  const { sampleRate, track } = options;
  const latencySec = options.latencySec ?? 0;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(options.renderSec * sampleRate), sampleRate });
  // The wall clock runs with the render, as a real context's clock runs with performance.now(): the
  // smoothed output clock (ISS-91) fits one against the other, and an offline render that stands still
  // while the wall clock runs would look like a clock that keeps jumping.
  const wallAtStart = realNow();
  Object.defineProperty(performance, "now", { configurable: true, value: () => wallAtStart + context.currentTime * 1000 });
  // The real clock, over an output that reports `latencySec` behind the render.
  const output = {
    state: "running",
    get currentTime() {
      return context.currentTime;
    },
    getOutputTimestamp: () => ({ contextTime: context.currentTime - latencySec, performanceTime: performance.now() }),
  } as unknown as AudioContext;
  const clock = latencySec === 0 ? undefined : audioContextClock(output);
  const running = await createAudioEngine({ context, masterTempo: false, ...(clock === undefined ? {} : { clock }), lookaheadSec: options.lookaheadSec ?? 0 });
  engine = running;
  const audio = options.audio(context);
  expect(await running.load("A", audio, { trackId: track.trackId, grid: track.grid })).toEqual({ ok: true });
  const partner = track.partner;
  if (options.partnerAudio !== undefined && partner !== undefined) {
    expect(await running.load("B", options.partnerAudio(context), { trackId: partner.trackId, grid: partner.grid })).toEqual({ ok: true });
  }
  const definition = lessonDefinition(options.lessonId);
  let ended = 0;
  const listener = {
    observed: (observation: Observation) => {
      options.observed?.push(observation);
    },
    audioEnded: () => (ended += 1),
    checkFailed: (message: string) => {
      throw new Error(message);
    },
  };
  const session = new LessonSession(running, definition, track, audio, "learner-1", listener, options.partnerAudio !== undefined);
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
  let playedAt = Number.NaN;
  running.on("command", (event) => {
    if (event.command.control === "play" && event.command.deck === "A" && event.rejected === null) playedAt = event.appliedCtx;
  });
  return {
    session,
    track,
    plan: definition.planCheck(track),
    engine: running,
    renderTo,
    // Nothing is heard before it is rendered, however far ahead the timestamp runs.
    renderToHeard: (ctx) => renderTo(ctx + Math.max(0, latencySec)),
    now: () => context.currentTime,
    playedAt: () => playedAt,
    audioEnded: () => ended,
  };
}

/** Waits, on the wall clock, for something the session does on its own timers or promises. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = realNow() + 10_000;
  while (!done()) {
    if (realNow() > deadline) throw new Error(`Gave up after 10 s waiting for ${what}; is the machine badly overloaded, or did the session stop?`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Starts the Check and waits, with the render suspended, until the session has cued and played it.
 * The session plays the Check from a promise callback: rendering on before then lets the deck start
 * late by however long the main thread took to get there, which shifts every heard beat off the taps.
 */
/**
 * A set-up step off the clock ("Set up: … — then R"), in practice or the Check: the moves at the
 * Learner's pace while A loops its first phrase, then R. Returns once A plays from its start again.
 */
async function setUpThenReady(run: Harness, moves: readonly EngineCommand[] = []): Promise<void> {
  expect(run.session.setUpPending()).not.toBeNull();
  for (const command of moves) {
    expect(run.engine.command(command, { device: "keyboard" }), JSON.stringify(command)).toEqual({ ok: true });
    await run.renderTo(run.now() + 0.3);
  }
  await run.renderTo(run.now() + 2);
  let sought = false;
  const stop = run.engine.on("command", (event) => {
    if (event.command.control === "seek" && event.command.deck === "A" && event.rejected === null) sought = true;
  });
  try {
    run.session.ready();
    expect(sought).toBe(true);
  } finally {
    stop();
  }
  expect(run.session.setUpPending()).toBeNull();
}

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
  const playAt = run.playedAt();
  const heard = (pos: number) => playAt + (pos - run.plan.startPos);
  for (const pos of positions) {
    await run.renderToHeard(heard(pos));
    run.engine.command({ control: "tap" }, { device: "keyboard" });
  }
  if (run.plan.endWhen.kind !== "position") throw new Error("this Check ends at a position");
  const endedBefore = run.audioEnded();
  await run.renderToHeard(heard(run.plan.endWhen.pos) + 0.1);
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

  // The owner's report: every Lesson 2 Check on the MacBook voided (sectionNotHeard). Real outputs, with
  // the engine's real lookahead (baseLatency + 2 quanta ≈ 17 ms): Bluetooth and wired latencies, and an
  // output timestamp running 20 ms ahead of the render, which put the Check's start after its own cue.
  it.each([
    { what: "Bluetooth output (250 ms)", latencySec: 0.25 },
    { what: "wired output (40 ms)", latencySec: 0.04 },
    { what: "an output timestamp 20 ms ahead of the render", latencySec: -0.02 },
  ])("beats-and-bars after practice is graded, not voided, on $what", { timeout: 60_000 }, async ({ latencySec }) => {
    const lookaheadSec = 0.0116 + 256 / sampleRate;
    const run = await harness({ sampleRate, lessonId: "beats-and-bars", track: lamplightMoths(), audio: (context) => toneBuffer(context, ORIGINAL_SEC), renderSec: 40 + 2 * 40, latencySec, lookaheadSec });
    const beatSec = 60 / run.track.grid.bpm;
    run.session.preparePractice();
    await run.renderTo(36);
    const beats = [...Array.from({ length: 32 }, (_, index) => 32 + index), ...Array.from({ length: 8 }, (_, index) => 64 + 4 * index)];
    const outcomes = [];
    for (let attempt = 0; attempt < 2; attempt += 1) outcomes.push(await checkWithTaps(run, beats.map((beat) => beat * beatSec), {}, ["deck-basics"]));
    run.session.close();
    for (const outcome of outcomes) expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
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
    // Enough to diagnose an owner's report: which section, how far it got, and the clock.
    const diagnostics = graded.ok && "diagnostics" in graded.outcome ? graded.outcome.diagnostics : undefined;
    expect(diagnostics).toMatchObject({ section: "beatSection", to: null, checkStartPos: run.plan.startPos });
    expect([typeof diagnostics?.["recorderStartedCtx"], typeof diagnostics?.["recorderStoppedCtx"]]).toEqual(["number", "number"]);
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

  // Lessons 12–13 on the synthetic pair (A 124 BPM, B 121 BPM synced to it): a practice rep is seen as
  // good, then the Check passes, with every move made as A's position is heard.
  const pair = (context: BaseAudioContext, layout: typeof SYNTHETIC_HOUSE) => {
    const samples = synthesizeHouse(layout, context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  };
  const pairTrack = (): LessonTrack => ({ ...syntheticLessonTrack(SYNTHETIC_HOUSE), partner: syntheticLessonTrack(SYNTHETIC_PARTNER) });
  const EQ_FILTER_BEFORE: readonly LessonId[] = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "eq-basics"];

  interface Move {
    readonly pos: number;
    readonly command: EngineCommand;
  }

  /** Sends each command as A's track position `pos` is heard, A having started from `fromPos` at `playAt`. */
  async function movesAt(run: Harness, playAt: number, fromPos: number, timed: readonly { readonly pos: number; readonly command: EngineCommand }[]): Promise<void> {
    for (const { pos, command } of [...timed].sort((a, b) => a.pos - b.pos)) {
      await run.renderTo(playAt + (pos - fromPos));
      expect(run.engine.command(command, { device: "trackpad" }), JSON.stringify(command)).toEqual({ ok: true });
    }
  }

  /** Practice from its set-up: waits, with the render suspended, until the session has played deck A. */
  async function startedPractice(run: Harness): Promise<number> {
    run.session.preparePractice();
    await until(() => run.engine.deckState("A").playing, "the session to play the practice");
    return run.now();
  }

  /** Ends the Check by A's fader (the moves close it) and grades it. */
  async function gradedBlend(run: Harness, playAt: number, endPos: number): Promise<CheckResult | VoidAttempt> {
    await run.renderTo(playAt + (endPos - run.plan.startPos));
    // The Check ends 2 bars after A's fader closed, on the wall clock: keep the render suspended meanwhile.
    await until(() => run.audioEnded() === 1, "the Check to end 2 bars after A's fader closed");
    const graded = await run.session.grade({}, EQ_FILTER_BEFORE);
    run.session.close();
    if (!graded.ok) throw new Error(graded.message);
    return graded.outcome;
  }

  it("bass-swap: a swap on the phrase is a good practice rep, then the Check passes", { timeout: 90_000 }, async () => {
    const observed: Observation[] = [];
    const track = pairTrack();
    const run = await harness({ sampleRate, lessonId: "bass-swap", track, audio: (context) => pair(context, SYNTHETIC_HOUSE), partnerAudio: (context) => pair(context, SYNTHETIC_PARTNER), renderSec: 120, observed });
    const { leadPos, blendPos, handoverPos } = blendPositions(track);
    const beat = 60 / track.grid.bpm;
    const swap: { pos: number; command: EngineCommand }[] = [
      { pos: blendPos, command: { control: "play", deck: "B" } },
      ...Array.from({ length: 10 }, (_, step): Move => ({ pos: blendPos + (step + 1) * 0.4 * beat, command: { control: "channel-fader", deck: "B", value: (step + 1) / 10 } })),
      { pos: handoverPos - 0.1, command: { control: "eq-low", deck: "A", value: -1 } },
      { pos: handoverPos + 0.1, command: { control: "eq-low", deck: "B", value: 0 } },
    ];
    // Practice waits for R after its set-up (LOW B cut), A looping its first phrase meanwhile.
    await startedPractice(run);
    await setUpThenReady(run, [{ control: "eq-low", deck: "B", value: -1 }]);
    await movesAt(run, run.now(), leadPos, swap);
    expect(observed.filter((observation) => observation.kind === "swap")).toEqual([{ kind: "swap", onPhrase: true }]);

    await startedCheck(run);
    await setUpThenReady(run, [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "eq-low", deck: "B", value: -1 },
    ]);
    const playAt = run.now();
    const outPos = handoverPos + 8 * beat;
    await movesAt(run, playAt, leadPos, [
      ...swap,
      { pos: outPos, command: { control: "channel-fader", deck: "A", value: 0 } },
      { pos: outPos + 2 * beat, command: { control: "eq-low", deck: "A", value: 0 } },
    ]);
    const outcome = await gradedBlend(run, playAt, outPos + 9 * beat);
    expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
    expect(summary(outcome)).toContainEqual({ id: "bass-swap.clash-short", status: "met", detail: undefined });
  });

  it("filter-transition: a 10-bar high-pass out is a good practice rep, then the Check passes", { timeout: 90_000 }, async () => {
    const observed: Observation[] = [];
    const track = pairTrack();
    const run = await harness({ sampleRate, lessonId: "filter-transition", track, audio: (context) => pair(context, SYNTHETIC_HOUSE), partnerAudio: (context) => pair(context, SYNTHETIC_PARTNER), renderSec: 120, observed });
    const { leadPos, blendPos, handoverPos } = blendPositions(track);
    const beat = 60 / track.grid.bpm;
    const out: { pos: number; command: EngineCommand }[] = [
      ...Array.from({ length: 81 }, (_, step): Move => ({ pos: blendPos - 8 * beat + step * 0.4 * beat, command: { control: "filter", deck: "A", value: 0.06 + (0.79 * step) / 80 } })),
      { pos: blendPos, command: { control: "play", deck: "B" } },
      ...Array.from({ length: 10 }, (_, step): Move => ({ pos: blendPos + (step + 1) * 0.4 * beat, command: { control: "channel-fader", deck: "B", value: (step + 1) / 10 } })),
      { pos: handoverPos, command: { control: "channel-fader", deck: "A", value: 0 } },
    ];
    await startedPractice(run);
    await setUpThenReady(run);
    await movesAt(run, run.now(), leadPos, out);
    const reps = observed.filter((observation) => observation.kind === "filter-out");
    expect(reps).toHaveLength(1);
    expect(reps[0]?.kind === "filter-out" ? reps[0].depth : null).toBeCloseTo(0.85);
    expect(reps[0]?.kind === "filter-out" ? reps[0].bars : null).toBeCloseTo(10, 0);

    await startedCheck(run);
    await setUpThenReady(run, [{ control: "headphone-cue", deck: "B", value: true }]);
    const playAt = run.now();
    await movesAt(run, playAt, leadPos, [
      ...out,
      { pos: handoverPos + 2 * beat, command: { control: "filter", deck: "A", value: 0 } },
    ]);
    const outcome = await gradedBlend(run, playAt, handoverPos + 9 * beat);
    expect(outcome.outcome, JSON.stringify(summary(outcome))).toEqual({ kind: "passed" });
  });
});

// ISS-99: on a high-latency output the heard playhead still shows the old position for the output's
// latency after the practice loop seeks back. Looping again on it seeks over and over and stutters, so
// practice loops wait, as a Check does, until the seek is heard plus CUE_SETTLE_SEC.
describe("practice loop at 48 kHz on Bluetooth output (250 ms)", () => {
  it("seeks back once per loop, not again while the seek is still on its way to the speakers", { timeout: 60_000 }, async () => {
    const sampleRate = 48_000;
    const latencySec = 0.25;
    const track = lamplightMoths();
    const loop = practiceLoopFor(lessonDefinition("beats-and-bars"), track);
    if (loop === null) throw new Error("Lesson 2 (Beats and bars) practice loops");
    const lookaheadSec = 0.0116 + 256 / sampleRate;
    const run = await harness({ sampleRate, lessonId: "beats-and-bars", track, audio: (context) => toneBuffer(context, ORIGINAL_SEC), renderSec: 60, latencySec, lookaheadSec });
    run.session.preparePractice();
    // Practice plays its deck from a promise callback: wait for it before rendering towards the loop.
    await until(() => run.engine.deckState("A").playing, "practice to play deck A");
    // Past the lookahead, where the practice cue and Play have taken effect.
    const probe = run.now() + 0.1;
    const loopAtCtx = probe + loop.atPos - (run.engine.playheadAt("A", probe)?.positionSec ?? Number.NaN);
    await run.renderTo(loopAtCtx - 0.5);
    const seeks: number[] = [];
    run.engine.on("command", (event) => {
      if (event.command.control === "seek" && event.command.deck === "A" && event.rejected === null) seeks.push(event.appliedCtx);
    });
    // Small steps through the loop point and the output's latency after it, so the session's watch
    // looks while the seek is still unheard.
    for (let at = loopAtCtx - 0.5; at <= loopAtCtx + latencySec + 1; at += 0.02) await run.renderTo(at);
    run.session.close();
    expect(seeks).toHaveLength(1);
  });
});

// Owner feedback: Lesson 3 had no clear start to the first phrase. A Learner who does exactly what the
// captions say passes: the practice count shows the bars, then steps aside once they tap by ear; the
// Check counts in to phrase 1 and says TAP on its downbeat; a tap well off gets a nudge, not a hint.
describe.each([
  { what: "wired output (40 ms)", latencySec: 0.04 },
  { what: "Bluetooth output (250 ms)", latencySec: 0.25 },
])("phrases at 48 kHz on $what, following the captions", ({ latencySec }) => {
  const sampleRate = 48_000;
  const groove = (context: BaseAudioContext) => {
    const samples = synthesizeHouse(SYNTHETIC_HOUSE, context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  };

  it("practice counts the bars and fades by ear, then the counted-in Check passes", { timeout: 120_000 }, async () => {
    const track = syntheticLessonTrack(SYNTHETIC_HOUSE);
    const lookaheadSec = 0.0116 + 256 / sampleRate;
    const run = await harness({ sampleRate, lessonId: "phrases", track, audio: groove, renderSec: 60 + 200, latencySec, lookaheadSec });
    const definition = lessonDefinition("phrases");
    const beat = 60 / track.grid.bpm;
    const bar = 4 * beat;
    const phrase = (n: number) => (n - 1) * 8 * bar;
    const tap = () => run.engine.command({ control: "tap" }, { device: "keyboard" });

    // Practice: a whole phrase before phrase 2, from its start, looping 24 bars. Walk it a bar at a time, as the count does.
    run.session.preparePractice();
    await until(() => run.engine.deckState("A").playing, "the session to play the practice");
    const practiceAt = run.playedAt();
    const practiceStart = definition.practiceStart(track);
    const heardInPractice = (pos: number) => practiceAt + (pos - practiceStart);
    // Half a bar at a time: the session's watch looks at the deck between renders, as it would live.
    const walkHeard = async (target: number) => {
      let at = run.now() - Math.max(0, latencySec);
      while (target - at > 0.005) {
        at = Math.min(target, at + bar / 2);
        await run.renderToHeard(at);
      }
    };
    const walkTo = (pos: number) => walkHeard(heardInPractice(pos));
    expect(practiceStart).toBeCloseTo(phrase(1) + track.grid.firstBeat, 9);
    await walkTo(practiceStart + 2 * bar + 1.5 * beat);
    expect(run.session.phraseCount()).toEqual({ phrase: 1, bar: 3, beat: 2, shown: true });
    // Two phrase starts tapped right in a row: the count steps aside.
    await walkTo(practiceStart + phrase(2));
    tap();
    await walkTo(practiceStart + phrase(2) + 2 * bar);
    expect(run.session.phraseCount()?.shown).toBe(true);
    await walkTo(practiceStart + phrase(3));
    tap();
    await walkTo(practiceStart + phrase(3) + 2 * bar);
    expect(run.session.phraseCount()?.shown).toBe(false);
    // Two misses in a row (a tap off the phrase, then a phrase start untapped): it comes back.
    tap();
    await walkTo(practiceStart + 24 * bar - bar);
    expect(run.session.phraseCount()?.shown).toBe(false);
    // The loop is 3 phrases long; the jump back to phrase 1 is not judged, phrase 2's start, untapped, is.
    await walkHeard(run.now() - Math.max(0, latencySec) + 10 * bar + beat);
    expect(run.session.phraseCount()).toMatchObject({ phrase: 2, shown: true });

    // The Check: the captions count in, then say TAP on phrase 1's downbeat.
    await startedCheck(run);
    const playAt = run.playedAt();
    const { plan } = run;
    const heard = (pos: number) => playAt + (pos - plan.startPos);
    const first = phrase(2);
    const captionAt = async (pos: number) => {
      await run.renderToHeard(heard(pos));
      return run.session.checkCue()?.caption;
    };
    expect(run.session.phraseCount()).toBeNull();
    expect(await captionAt(first - 2 * bar + beat)).toBe("Phrase 1 starts in 2 bars");
    for (const [count, shows] of [[4, "1 bar: 4"], [3, "1 bar: 4 · 3"], [2, "1 bar: 4 · 3 · 2"], [1, "1 bar: 4 · 3 · 2 · 1"]] as const) {
      expect(await captionAt(first - count * beat + 0.01)).toBe(shows);
    }
    expect(await captionAt(first)).toBe("TAP — phrase 1!");
    tap();
    // Then 8 bars counted on from it, each phrase; one tap well off the phrase gets a nudge, no position.
    expect(await captionAt(first + 2 * bar)).toBe("Tap each new phrase (Space)");
    for (let k = 1; k < 8; k += 1) {
      if (k === 2) {
        await run.renderToHeard(heard(first + (k - 1) * 8 * bar + 4 * bar));
        tap();
        expect(await captionAt(first + (k - 1) * 8 * bar + 5 * bar)).toBe("Count from the last change");
        expect(await captionAt(first + (k - 1) * 8 * bar + 6 * bar + beat)).toBe("Tap each new phrase (Space)");
      }
      await run.renderToHeard(heard(first + k * 8 * bar));
      tap();
    }
    if (plan.endWhen.kind !== "position") throw new Error("this Check ends at a position");
    await run.renderToHeard(heard(plan.endWhen.pos) + 0.1);
    await until(() => run.audioEnded() === 1, "the session's watch to end the Check's audio part");
    // The questions: ▶ on "Phrase 4" plays from 2 bars before it, across the change, and keeps going.
    const seeks: number[] = [];
    const stopSeeks = run.engine.on("command", (event) => {
      if (event.command.control === "seek" && event.command.deck === "A") seeks.push(event.command.value);
    });
    expect(run.session.previewPhrase(4)).toBe(true);
    stopSeeks();
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toBeCloseTo(phrase(5) - 2 * bar, 9);
    expect(run.engine.deckState("A").playing).toBe(true);
    const previewAt = run.playedAt();
    const heardInPreview = (pos: number) => previewAt + (pos - (phrase(5) - 2 * bar));
    // The marker follows heard time, not applied: just before the change is heard, the deck already
    // plays phrase 4 (by the output's latency), but the Learner still hears phrase 3's last bar.
    for (let at = previewAt + bar / 2; at < heardInPreview(phrase(5)) - 0.1; at += bar / 2) await run.renderToHeard(at);
    await run.renderToHeard(heardInPreview(phrase(5)) - 0.1);
    expect(run.session.previewHeard()).toEqual({ phrase: 3, bar: 8 });
    const applied = run.engine.playheadAt("A", run.now())?.positionSec ?? 0;
    expect(applied >= phrase(5)).toBe(latencySec > 0.1);
    await run.renderToHeard(heardInPreview(phrase(5)) + 0.05);
    expect(run.session.previewHeard()).toEqual({ phrase: 4, bar: 1 });
    // One continuous listen: on through the next phrases until stopped.
    for (let at = heardInPreview(phrase(5)) + bar / 2; at <= heardInPreview(phrase(6) + bar / 2); at += bar / 2) await run.renderToHeard(at);
    expect(run.session.previewHeard()).toEqual({ phrase: 5, bar: 1 });
    expect(run.session.previewingPhrase()).toBe(4);
    run.session.stopPreview();
    expect(run.engine.deckState("A").playing).toBe(false);
    expect(run.session.previewHeard()).toBeNull();
    // Previews are not taps, and are not graded.
    const graded = await run.session.grade({ breakdown: 4, drop: 6 }, ["deck-basics", "beats-and-bars"]);
    // The result card's ▶ replays a phrase of the graded Check, until the next Check or practice.
    expect(run.session.previewPhrase(4)).toBe(true);
    expect(run.engine.deckState("A").playing).toBe(true);
    run.session.stopPreview();
    run.session.close();
    if (!graded.ok) throw new Error(graded.message);
    expect(graded.outcome.outcome, JSON.stringify(summary(graded.outcome))).toEqual({ kind: "passed" });
    // Grading is as before: every phrase start matched, the one far tap an allowed extra.
    expect(summary(graded.outcome)).toContainEqual({ id: "phrases.phrase-taps", status: "met", detail: { matched: 8, extras: 1, targets: 8 } });
  });
});
