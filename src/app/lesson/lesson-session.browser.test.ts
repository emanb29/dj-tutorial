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
    // Let the session's watch (a 25 ms interval) see the new position.
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  return { session, track, plan: definition.planCheck(track), engine: running, renderTo, now: () => context.currentTime, audioEnded: () => ended };
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
  run.session.startCheck();
  const playAt = run.now();
  const heard = (pos: number) => playAt + (pos - run.plan.startPos);
  for (const pos of positions) {
    await run.renderTo(heard(pos));
    run.engine.command({ control: "tap" }, { device: "keyboard" });
  }
  if (run.plan.endWhen.kind !== "position") throw new Error("this Check ends at a position");
  const endedBefore = run.audioEnded();
  await run.renderTo(heard(run.plan.endWhen.pos) + 0.1);
  expect(run.audioEnded()).toBe(endedBefore + 1);
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
    run.session.startCheck();
    await run.renderTo(run.now() + 10);
    run.engine.command({ control: "pause", deck: "A" }, { device: "keyboard" });
    await run.renderTo(run.now() + 1);
    const graded = await run.session.grade({}, ["deck-basics"]);
    run.session.close();
    expect(graded.ok && graded.outcome.outcome).toEqual({ kind: "void", reason: "sectionNotHeard" });
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
