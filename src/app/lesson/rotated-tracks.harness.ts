// Test support for the rotated-tracks browser tests (rotated-tracks-*.browser.test.ts, split so they run
// in parallel). ISS-100: every Lesson grades on the Originals the rotation picks, not only on the first house one.
// Each Lesson runs its Check the way the captions say, on 3 Originals chosen by the real rotation
// (`deckAOrder`, `partnerCandidates`) with a fixed seed, on a real engine rendered offline at 48 kHz
// (never the speakers). The Originals are gitignored, so CI has none: their real meta.json grids and
// sections are committed (rotated-originals.json) and the audio is synthesised on those grids. Grading
// reads the grid, the sections and heard time, so that is what is tested; the Originals' own sound is not.
//
// Every move is taken from the Check's plan as the Learner sees it: a caption's position ("Next 1: …"),
// a phrase start the Learner counts to, or a deck's heard playhead (the ear in the by-ear Lessons).
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createAudioEngine, type AudioEngine, type EngineCommand } from "@audio";
import {
  barStart,
  beatSec,
  LESSONS,
  lessonTrackFromKnownGrid,
  peakDbfsOf,
  phraseStart,
  synthesizeHouse,
  withoutMasterTempo,
  type BuiltLesson,
  type BuiltLessonId,
  type CheckPlan,
  type DeckId,
  type LessonTrack,
  type SyntheticLayout,
} from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { OriginalMetaSchema, type OriginalMeta } from "@shared/originals.ts";
import { knownGridFromMeta, type Track } from "@tracks";
import fixture from "./rotated-originals.json";
import { LessonSession } from "./lesson-session.ts";
import { deckAOrder, historyId, NO_HISTORY, partnerCandidates, seededRandom } from "./track-rotation.ts";

const SAMPLE_RATE = 48_000;
/** Deck A tracks per Lesson. */
const TRACKS_PER_LESSON = 3;
const SEED = 100;
/** The longest render between two looks by the session's watch (a 25 ms interval). */
const MAX_STEP_SEC = 2;
/** The engine's scheduling lookahead on a real output (baseLatency + 2 quanta): changes take effect a little after the press. */
const LOOKAHEAD_SEC = 0.0116 + 256 / SAMPLE_RATE;

export const ORIGINALS: readonly OriginalMeta[] = z.array(OriginalMetaSchema).parse(fixture);

/** The Original as the index lists it (src/tracks/originals.ts `toTrack`): what the rotation reads. */
function indexTrack(meta: OriginalMeta): Track {
  return {
    id: meta.id,
    source: "original",
    title: meta.title,
    artist: "learn-to-dj original",
    bpmHint: meta.bpm,
    genre: meta.genre,
    ...(meta.subgenre === undefined ? {} : { subgenre: meta.subgenre }),
    licence: "Original, made for this app",
    attribution: { text: `"${meta.title}", an original made for learn-to-dj`, url: null },
    shareable: true,
    durationSec: meta.durationSec,
    analysisCacheKey: null,
    retention: "persistable",
  };
}

const INDEX = ORIGINALS.map(indexTrack);
const metaOf = (track: Track): OriginalMeta => {
  const meta = ORIGINALS.find((candidate) => candidate.id === track.id);
  if (meta === undefined) throw new Error(`No fixture meta for Original ${track.id}.`);
  return meta;
};

/** The Lesson track as the loader builds it from the Original's meta (track-loader.ts). */
export function lessonTrackOf(meta: OriginalMeta): LessonTrack {
  const track = indexTrack(meta);
  return lessonTrackFromKnownGrid({ id: historyId(track), title: track.title, attribution: track.attribution }, knownGridFromMeta(meta));
}

/** What each section plays in the synthesised stand-in: the kick leaves in the breakdown and the build. */
const LAYERS: Readonly<Record<string, SyntheticLayout["sections"][number]["layers"]>> = {
  intro: ["kick", "hat"],
  build: ["pad", "roll"],
  drop: ["kick", "hat", "bass", "pad"],
  breakdown: ["pad"],
  outro: ["kick", "hat"],
};

function layoutOf(meta: OriginalMeta): SyntheticLayout {
  const barSec = (4 * 60) / meta.bpm;
  return {
    bpm: meta.bpm,
    sections: meta.phrases.map((phrase) => {
      const layers = LAYERS[phrase.section];
      if (layers === undefined) throw new Error(`Original ${meta.id}: no stand-in layers for section "${phrase.section}"; add it to LAYERS.`);
      return { name: phrase.section, bars: phrase.lengthBars, layers };
    }),
    tailSec: Math.max(0, meta.durationSec - meta.firstDownbeatSec - meta.bars * barSec),
    peakDbfs: -6,
  };
}

/** Sections where the Originals' tops (hats, shakers, synths) play on every 16th. */
const WITH_TOPS: ReadonlySet<string> = new Set(["intro", "drop", "outro"]);

/**
 * The synthetic groove has almost nothing above the bass but a faint hat, so a high-pass empties it far
 * sooner than it does a real Original. A 16th-note top layer (noise, first-differenced: mostly highs)
 * stands in for the Originals' tops, so filter-transition's "A still audible under the high-pass" reads
 * the music, not the stand-in's lack of it.
 */
function withTops(samples: Float32Array<ArrayBuffer>, meta: OriginalMeta, sampleRate: number): Float32Array<ArrayBuffer> {
  const sixteenth = 60 / meta.bpm / 4;
  let state = 0x7095;
  const noise = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 31 - 1;
  };
  let bar = 0;
  for (const phrase of meta.phrases) {
    const from = meta.firstDownbeatSec + bar * 16 * sixteenth;
    bar += phrase.lengthBars;
    if (!WITH_TOPS.has(phrase.section)) continue;
    for (let step = 0; step < phrase.lengthBars * 16; step += 1) {
      const start = Math.round((from + step * sixteenth) * sampleRate);
      let previous = 0;
      for (let index = 0; index < Math.round(0.04 * sampleRate) && start + index < samples.length; index += 1) {
        const value = noise();
        samples[start + index] = (samples[start + index] ?? 0) + 0.06 * (value - previous) * Math.exp(-index / sampleRate / 0.015);
        previous = value;
      }
    }
  }
  return samples;
}

const samplesCache = new Map<string, Float32Array<ArrayBuffer>>();
export function audioOf(meta: OriginalMeta, context: BaseAudioContext): AudioBuffer {
  if (meta.firstDownbeatSec !== 0) throw new Error(`Original ${meta.id}: the stand-in audio assumes bar 1 at 0 s.`);
  const samples = samplesCache.get(meta.id) ?? withTops(synthesizeHouse(layoutOf(meta), context.sampleRate), meta, context.sampleRate);
  samplesCache.set(meta.id, samples);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

interface Pick {
  readonly lesson: BuiltLesson;
  readonly main: OriginalMeta;
  readonly partner: OriginalMeta | null;
}

/** The rotation's first picks for a Lesson, as the loader tries them: deck A, then its first partner that fits. */
function picksFor(lesson: BuiltLesson, seed: number): Pick[] {
  const random = seededRandom(seed);
  return deckAOrder(INDEX, lesson.id, NO_HISTORY, random)
    .flatMap((candidate): Pick[] => {
      const main = metaOf(candidate);
      if (lesson.trackProblems(lessonTrackOf(main)).length > 0) return [];
      const pairing = lesson.partner;
      if (pairing === undefined) return [{ lesson, main, partner: null }];
      const partner = partnerCandidates(candidate, main.bpm, INDEX, lesson.id, NO_HISTORY, random)
        .map(metaOf)
        .find((other) => pairing.problems(lessonTrackOf(main), lessonTrackOf(other)).length === 0);
      return partner === undefined ? [] : [{ lesson, main, partner }];
    })
    .slice(0, TRACKS_PER_LESSON);
}

// ---------------------------------------------------------------------------------------------
// The harness: a real engine and LessonSession over an offline render
// ---------------------------------------------------------------------------------------------

const realNow = performance.now.bind(performance);
let engine: AudioEngine | null = null;
let restoreClock: (() => void) | null = null;
async function cleanUp(): Promise<void> {
  restoreClock?.();
  restoreClock = null;
  await engine?.close();
  engine = null;
}

/**
 * The session times some ends on the wall clock (cut-on-phrase's 11 bars, a blend's 2 bars after A's
 * fader closes). Offline, render time runs far ahead of it: so the page's clock runs at least as fast
 * as the render, as it would live, instead of each attempt waiting for the wall clock to catch up.
 */
function wallClockFollowing(context: BaseAudioContext): () => void {
  const fromMs = realNow();
  const fromCtx = context.currentTime;
  let skewMs = 0;
  const now = () => realNow() + skewMs;
  Object.defineProperty(performance, "now", { value: now, configurable: true, writable: true });
  restoreClock = () => {
    Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true });
  };
  return () => {
    skewMs = Math.max(skewMs, fromMs + (context.currentTime - fromCtx) * 1000 - realNow());
  };
}

/** Waits, on the real wall clock, for something the session does on its own timers or promises. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = realNow() + 10_000;
  while (!done()) {
    if (realNow() > deadline) throw new Error(`Gave up after 10 s waiting for ${what}; is the machine badly overloaded, or did the session stop?`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Run {
  readonly definition: BuiltLesson;
  readonly session: LessonSession;
  readonly engine: AudioEngine;
  readonly track: LessonTrack;
  /** The Check's plan (attempt 1; what varies by attempt is read live, not from here). */
  readonly plan: CheckPlan;
  /** The Lessons the Learner has passed before this Check. */
  readonly passed: readonly LessonId[];
  readonly now: () => number;
  /** Renders to context time `ctx`, a step at a time, letting the session's watch look after each. */
  readonly renderTo: (ctx: number) => Promise<void>;
  /** Renders until `deck`'s heard playhead reaches track position `pos`, playing straight on. */
  readonly toPos: (pos: number, deck?: DeckId) => Promise<void>;
  readonly send: (command: EngineCommand) => void;
  readonly audioEnded: () => number;
}

async function harness(pick: Pick, passed: readonly LessonId[]): Promise<Run> {
  const track0 = lessonTrackOf(pick.main);
  const partnerTrack0 = pick.partner === null ? undefined : lessonTrackOf(pick.partner);
  const definition0 = pick.lesson;
  const renderSec = 30 + definition0.planCheck(partnerTrack0 === undefined ? track0 : { ...track0, partner: partnerTrack0 }).timeoutSec + 30;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(renderSec * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  const running = await createAudioEngine({ context, masterTempo: definition0.masterTempo === true, lookaheadSec: LOOKAHEAD_SEC });
  engine = running;
  const audio = audioOf(pick.main, context);
  const partnerAudio = pick.partner === null ? undefined : audioOf(pick.partner, context);
  const peakOf = (buffer: AudioBuffer) => peakDbfsOf(Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)));
  // As LessonPlayer does: peaks measured on the audio, deck B loaded when the Lesson uses it.
  const partner = partnerTrack0 === undefined || partnerAudio === undefined ? undefined : { ...partnerTrack0, peakDbfs: peakOf(partnerAudio) };
  const track: LessonTrack = { ...track0, peakDbfs: peakOf(audio), ...(partner === undefined ? {} : { partner }) };
  const withDeckB = LessonSession.usesDeckB(definition0, track);
  expect(await running.load("A", audio, { trackId: track.trackId, grid: track.grid })).toEqual({ ok: true });
  if (withDeckB) {
    const onB = partner ?? track;
    expect(await running.load("B", partnerAudio ?? audio, { trackId: onB.trackId, grid: onB.grid })).toEqual({ ok: true });
  }
  const missingMasterTempo = definition0.masterTempo === true && !running.deckState("B").masterTempoAvailability.available;
  const definition = missingMasterTempo ? withoutMasterTempo(definition0) : definition0;
  let ended = 0;
  const session = new LessonSession(
    running,
    definition,
    track,
    audio,
    "learner-iss-100",
    {
      observed: () => undefined,
      audioEnded: () => (ended += 1),
      checkFailed: (message: string) => {
        throw new Error(message);
      },
    },
    withDeckB,
  );
  const followed = wallClockFollowing(context);
  const quantum = 128 / SAMPLE_RATE;
  let started = false;
  const renderStep = async (ctx: number) => {
    const at = Math.ceil(ctx / quantum - 1e-9) * quantum;
    if (at <= context.currentTime + 1e-9) return;
    const reached = context.suspend(at);
    if (started) await context.resume();
    else {
      started = true;
      void context.startRendering();
    }
    await reached;
    followed();
    // Let the session's watch (a 25 ms interval) see the new position.
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const renderTo = async (ctx: number) => {
    while (context.currentTime < ctx - quantum / 2) await renderStep(Math.min(ctx, context.currentTime + MAX_STEP_SEC));
  };
  const toPos = async (pos: number, deck: DeckId = "A") => {
    for (let tries = 0; tries < 50; tries += 1) {
      const reading = running.playheadAt(deck, context.currentTime);
      if (reading === null) throw new Error(`Deck ${deck} has no track.`);
      const state = running.deckState(deck);
      const rate = state.tempoRate;
      const left = (pos - reading.positionSec) / rate;
      if (left <= quantum / 2) return;
      if (!state.playing) throw new Error(`Deck ${deck} is stopped at ${reading.positionSec.toFixed(3)} s; it will never reach ${pos.toFixed(3)} s.`);
      await renderTo(context.currentTime + Math.min(left, MAX_STEP_SEC));
    }
    throw new Error(`Deck ${deck} did not reach ${pos.toFixed(3)} s.`);
  };
  return {
    definition,
    session,
    engine: running,
    track,
    plan: definition.planCheck(track, 1, passed),
    passed,
    now: () => context.currentTime,
    renderTo,
    toPos,
    send: (command) => {
      expect(running.command(command, { device: "keyboard" }), JSON.stringify(command)).toEqual({ ok: true });
    },
    audioEnded: () => ended,
  };
}

/** Starts the Check and waits, with the render suspended, until the session has cued (and, for a tap Lesson, played) it. */
async function startedCheck(run: Run): Promise<void> {
  let cued = false;
  let played = false;
  const stop = run.engine.on("command", (event) => {
    if (event.command.control === "seek" && event.command.deck === "A" && event.rejected === null) cued = true;
    if (event.command.control === "play" && event.command.deck === "A" && event.rejected === null) played = true;
  });
  const slices = run.plan.slices !== undefined;
  const plays = run.plan.autoPlay && run.plan.stops === undefined;
  try {
    run.session.startCheck(run.passed);
    await until(() => (slices ? run.session.deckTrack("A")?.trackId.endsWith("#cue-1") === true : cued) && (!plays || played), "the session to set up the Check");
  } finally {
    stop();
  }
}

/** Renders on until the session ends the Check's audio part by itself. */
async function untilEnded(run: Run, maxSec = 60): Promise<void> {
  const limit = run.now() + maxSec;
  while (run.audioEnded() === 0) {
    if (run.now() > limit) throw new Error(`The Check did not end within ${String(maxSec)} s of render.`);
    await run.renderTo(run.now() + 0.25);
  }
}

/** The position of the plan's live caption that says `caption`, as the Learner reads it. */
function cuePos(plan: CheckPlan, caption: string): number {
  const cue = plan.cues.find((candidate) => candidate.caption === caption);
  if (cue === undefined) throw new Error(`The Check has no caption "${caption}"; captions: ${plan.cues.map((candidate) => candidate.caption).join(" | ")}`);
  return cue.fromPos;
}

/** The plan's live caption starting with `prefix`: its position and full text (which may carry a number, "over 2 bars"). */
function cueStarting(plan: CheckPlan, prefix: string): { readonly pos: number; readonly caption: string } {
  const cue = plan.cues.find((candidate) => candidate.caption.startsWith(prefix));
  if (cue === undefined) throw new Error(`The Check has no caption starting "${prefix}"; captions: ${plan.cues.map((candidate) => candidate.caption).join(" | ")}`);
  return { pos: cue.fromPos, caption: cue.caption };
}

const barLength = (track: LessonTrack) => 4 * beatSec(track.grid);
/** The first phrase start at or after `pos`: "the next phrase's 1", counted on the track's grid. */
function nextPhraseStart(track: LessonTrack, pos: number): number {
  for (let phrase = 1; ; phrase += 1) {
    const start = phraseStart(track.grid, phrase);
    if (start >= pos - 1e-6) return start;
  }
}

/** A fader or knob dragged from `from` to `to` over `beats`, starting at A's position `pos` (a trackpad drag, a step every 0.4 beats). */
function drag(track: LessonTrack, pos: number, beats: number, make: (value: number) => EngineCommand, from: number, to: number): { pos: number; command: EngineCommand }[] {
  const steps = Math.max(1, Math.round(beats / 0.4));
  const beat = beatSec(track.grid);
  return Array.from({ length: steps + 1 }, (_, step) => ({ pos: pos + (beats * beat * step) / steps, command: make(from + ((to - from) * step) / steps) }));
}

/** Sends each command as deck A's heard playhead reaches its position, A playing straight on. */
async function movesAt(run: Run, moves: readonly { readonly pos: number; readonly command: EngineCommand }[]): Promise<void> {
  for (const { pos, command } of [...moves].sort((a, b) => a.pos - b.pos)) {
    await run.toPos(pos);
    run.send(command);
  }
}

const fader = (deck: DeckId) => (value: number): EngineCommand => ({ control: "channel-fader", deck, value });

/** The phase error of B against A, in A's beats (positive: B behind), from the heard playheads. */
function phaseBeats(run: Run): number {
  const a = run.engine.playheadAt("A", run.now());
  const b = run.engine.playheadAt("B", run.now());
  if (a?.beat == null || b?.beat == null) throw new Error("A deck has no beat to compare.");
  const difference = a.beat - b.beat;
  return difference - Math.round(difference);
}

/** TEMPO B so B plays at A's BPM, on B's ±6% range (the ear's tempo match, done in one move). */
function matchTempo(run: Run): void {
  const bpmA = run.track.grid.bpm * run.engine.deckState("A").tempoRate;
  const bpmB = (run.session.deckTrack("B") ?? run.track).grid.bpm;
  run.send({ control: "tempo", deck: "B", value: ((bpmA / bpmB - 1) * 100) / 6 });
}

/** Nudges B into phase with the jog wheel, as an ear would: a bend for as long as the error needs, then a finer one. */
async function nudgeIntoPhase(run: Run): Promise<void> {
  const beatA = 60 / (run.track.grid.bpm * run.engine.deckState("A").tempoRate);
  for (const bend of [0.05, 0.01, 0.002]) {
    const error = phaseBeats(run);
    if (Math.abs(error * beatA) < 0.002) return;
    run.send({ control: "jog-bend", deck: "B", value: Math.sign(error) * bend });
    await run.renderTo(run.now() + (Math.abs(error) * beatA) / bend);
    run.send({ control: "jog-bend", deck: "B", value: 0 });
  }
}

/** Keeps B in phase with A until A reaches `pos` (or the Check ends: it was held long enough), a look every bar. */
async function rideTo(run: Run, pos: number): Promise<void> {
  while (run.audioEnded() === 0 && (run.engine.playheadAt("A", run.now())?.positionSec ?? pos) < pos - 1e-3) {
    await nudgeIntoPhase(run);
    await run.toPos(Math.min(pos, (run.engine.playheadAt("A", run.now())?.positionSec ?? pos) + barLength(run.track)));
  }
}

/**
 * The Check's set-up step ("Set up: …"), off the clock: the set-up moves at the Learner's pace
 * while A loops its first phrase, then R (the quick way; it would go by itself at the phrase's end).
 * A plays from the Check's start a lookahead later.
 */
async function setUpThenReady(run: Run, moves: readonly EngineCommand[]): Promise<void> {
  expect(run.session.checkCue()?.caption ?? "").toMatch(/^Set up: /);
  for (const command of moves) {
    run.send(command);
    await run.renderTo(run.now() + 0.3);
  }
  await run.renderTo(run.now() + 3);
  run.session.ready();
  await run.renderTo(run.now() + 0.1);
}

type Answers = Readonly<Record<string, number>>;

/** Each Lesson's Check, done as its captions say. Returns the answers to its questions. */
const FOLLOW: Readonly<Record<BuiltLessonId, (run: Run) => Promise<Answers>>> = {
  "deck-basics": async (run) => {
    // "X, fade in within 4 bars, fade out."
    run.send({ control: "play", deck: "A" });
    await run.renderTo(run.now() + 1);
    run.send({ control: "channel-fader", deck: "A", value: 1 });
    await run.renderTo(run.now() + 3);
    run.send({ control: "channel-fader", deck: "A", value: 0 });
    await untilEnded(run);
    return {};
  },

  "beats-and-bars": async (run) => {
    const { plan, track } = run;
    const beat = beatSec(track.grid);
    const everyBeat = cuePos(plan, "Tap every beat (Space)") + beat / 2;
    const onlyTheOne = cuePos(plan, "Only the 1 now") + beat / 2;
    for (let pos = everyBeat; pos < onlyTheOne - beat / 2; pos += beat) {
      await run.toPos(pos);
      run.send({ control: "tap" });
    }
    for (let bar = 0; bar < 8; bar += 1) {
      await run.toPos(onlyTheOne + bar * barLength(track));
      run.send({ control: "tap" });
    }
    await untilEnded(run);
    return {};
  },

  phrases: async (run) => {
    const { plan, track } = run;
    // Counted in to phrase 1, then a tap on each phrase's 1, counting 8 bars from the last.
    const first = cuePos(plan, "TAP — phrase 1!") + beatSec(track.grid) / 2;
    for (let phrase = 0; phrase < 8; phrase += 1) {
      await run.toPos(first + phrase * 8 * barLength(track));
      run.send({ control: "tap" });
    }
    await untilEnded(run, 120);
    // The questions, by what was heard: the breakdown is where the kick left, the drop where it came back.
    const firstPhrase = Math.round(first / (8 * barLength(track))) + 1;
    const breakdown = track.sections.find((section) => section.name === "breakdown" && section.phrase >= firstPhrase)?.phrase;
    const drop = track.sections.find((section) => section.name === "drop" && section.phrase > (breakdown ?? Infinity))?.phrase;
    if (breakdown === undefined || drop === undefined) throw new Error("The tapped phrases hold no breakdown and later drop.");
    return { breakdown: breakdown - firstPhrase + 1, drop: drop - firstPhrase + 1 };
  },

  "gain-staging": async (run) => {
    // "Trim A into the zone, then R" · "Hands off A. Trim B to match, then R" · "Hold it: 8 bars".
    // Both decks play the same track: TRIM to put each channel's peak at −3 dBFS.
    const trimTo = (deck: DeckId) => {
      const peak = (deck === "A" ? run.track : (run.session.deckTrack("B") ?? run.track)).peakDbfs ?? -6;
      const db = -3 - peak;
      run.send({ control: "trim", deck, value: db >= 0 ? Math.min(1, db / 9) : Math.max(-0.95, db / 24) });
    };
    await run.renderTo(run.now() + 1);
    trimTo("A");
    await run.renderTo(run.now() + 1.5);
    run.session.ready();
    trimTo("B");
    await run.renderTo(run.now() + 1.5);
    run.session.ready();
    await untilEnded(run);
    return {};
  },

  "headphone-cue": async (run) => {
    const { plan, track } = run;
    const beat = beatSec(track.grid);
    run.send({ control: "headphone-cue", deck: "B", value: true });
    // "Tap B's kick (Space)": B's 32 beats from the bar the caption opens on, on B's own playhead.
    const tapFrom = cuePos(plan, "Tap B's kick (Space)") + beat;
    for (let index = 0; index < 32; index += 1) {
      await run.toPos(tapFrom + index * beat, "B");
      run.send({ control: "tap" });
    }
    await untilEnded(run);
    return {};
  },

  "cue-point": async (run) => {
    for (const slice of [1, 2, 3]) {
      await until(() => run.session.deckTrack("A")?.trackId.endsWith(`#cue-${String(slice)}`) === true, `slice ${String(slice)} on deck A`);
      await run.renderTo(run.now() + 0.1);
      const grid = run.session.deckTrack("A")?.grid;
      if (grid === undefined) throw new Error("No slice on deck A.");
      // Search to the slice's first 1 by ear (a hair late), set the cue point, Ready.
      const firstDownbeat = barStart(grid, 1);
      const at = run.engine.playheadAt("A", run.now())?.positionSec ?? 0;
      run.send({ control: "jog-search", deck: "A", value: firstDownbeat + 0.004 - at });
      await run.renderTo(run.now() + 0.05);
      run.send({ control: "deck-cue", deck: "A", value: true });
      await run.renderTo(run.now() + 0.05);
      run.send({ control: "deck-cue", deck: "A", value: false });
      await run.renderTo(run.now() + 0.05);
      run.session.ready();
    }
    await until(() => run.audioEnded() === 1, "the last Ready to end the Check");
    return {};
  },

  "cut-on-phrase": async (run) => {
    const { plan, track } = run;
    // "Set up: CUE 🎧 B on, fader B up, trims matched" (the set-up trims match already).
    await setUpThenReady(run, [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "channel-fader", deck: "B", value: 1 },
    ]);
    // "Next phrase: Press , and S on the 1."
    await run.toPos(cuePos(plan, "Next phrase: Press , and S on the 1") + 2 * barLength(track));
    run.send({ control: "play", deck: "B" });
    run.send({ control: "channel-fader", deck: "A", value: 0 });
    await untilEnded(run);
    return {};
  },

  "tempo-fader": async (run) => {
    // "Set B to … BPM, then R", three times; then the two clips, named by what they are.
    const bpm = (run.session.deckTrack("B") ?? run.track).grid.bpm;
    const targets = [3, -2.5, 1.5].map((offset) => Math.round((run.track.grid.bpm + offset) * 10) / 10);
    for (const target of targets) {
      // A couple of seconds per BPM, as a hand on the fader takes.
      await run.renderTo(run.now() + 1.5);
      run.send({ control: "tempo", deck: "B", value: ((target / bpm - 1) * 100) / 6 });
      await run.renderTo(run.now() + 0.5);
      run.session.ready();
    }
    await until(() => run.audioEnded() === 1, "the third Ready to end the Check");
    return Object.fromEntries(run.definition.questions.map((question) => [question.id, run.session.clipFor(question.id)?.masterTempo === true ? 1 : 0]));
  },

  "sync-blend": async (run) => {
    const { plan, track } = run;
    await setUpThenReady(run, [
      { control: "sync", deck: "B", value: true },
      { control: "headphone-cue", deck: "B", value: true },
    ]);
    // PLAY B on Phrase 2's 1, fader down; the blend on Phrase 3's 1.
    const playPos = cuePos(plan, "Press , now. Fader B stays down");
    const blendPos = cuePos(plan, "Fader B to ¾ now, then A to ¾");
    const upPos = cuePos(plan, "Fader B all the way up now, then A all the way down");
    const beat = beatSec(track.grid);
    await run.toPos(playPos);
    run.send({ control: "play", deck: "B" });
    await movesAt(run, [
      ...drag(track, blendPos, 0.5, fader("B"), 0, 0.75),
      ...drag(track, blendPos + beat, 0.5, fader("A"), 1, 0.75),
      ...drag(track, upPos, 0.5, fader("B"), 0.75, 1),
      ...drag(track, upPos + beat, 0.5, fader("A"), 0.75, 0),
    ]);
    await untilEnded(run);
    return {};
  },

  crossfader: async (run) => {
    const { plan, track } = run;
    // PLAY B on Phrase 2's 1 (crossfader on A: silent), the blend on Phrase 3's 1.
    const playPos = cuePos(plan, "Press , now. Crossfader stays on A");
    const blendPos = cuePos(plan, `Crossfader toward B now, slow and steady: 10 bars`);
    run.send({ control: "headphone-cue", deck: "B", value: true });
    await run.toPos(playPos);
    run.send({ control: "play", deck: "B" });
    await run.toPos(blendPos);
    // One slow, even move over the 10 bars asked.
    await movesAt(run, drag(track, blendPos, 40, (value) => ({ control: "crossfader", value }), 0, 1).slice(1));
    const cutCue = cuePos(plan, "CUE 🎧 A on. Cut back to A at Phrase 5, bar 1 (C)");
    await run.toPos(cutCue);
    run.send({ control: "headphone-cue", deck: "A", value: true });
    await run.toPos(nextPhraseStart(track, cutCue));
    run.send({ control: "crossfader", value: 0 });
    await untilEnded(run);
    return {};
  },

  "eq-basics": async (run) => {
    const { plan, track } = run;
    const cutPos = cuePos(plan, "LOW A down now") + beatSec(track.grid);
    const backPos = cuePos(plan, "Next 1: LOW back to the middle") + barLength(track);
    await movesAt(run, [
      { pos: cutPos - 0.1 * beatSec(track.grid), command: { control: "eq-low", deck: "A", value: -1 } },
      { pos: backPos, command: { control: "eq-low", deck: "A", value: 0 } },
    ]);
    await untilEnded(run);
    return {};
  },

  "bass-swap": async (run) => {
    const { plan, track } = run;
    const beat = beatSec(track.grid);
    // PLAY B on Phrase 2's 1, fader B on Phrase 3's 1, the swap on Phrase 4's 1.
    const playPos = cuePos(plan, "Press , now. Fader B stays down");
    const blendPos = cuePos(plan, "Fader B up now. LOW B stays down");
    const handoverPos = cuePos(plan, "At Phrase 4, bar 1: LOW A down, LOW B up") + barLength(track);
    const outPos = handoverPos + 8 * beat;
    await setUpThenReady(run, [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "eq-low", deck: "B", value: -1 },
    ]);
    await run.toPos(playPos);
    run.send({ control: "play", deck: "B" });
    await movesAt(run, [
      ...drag(track, blendPos, 4, fader("B"), 0, 1).slice(1),
      { pos: handoverPos - 0.1, command: { control: "eq-low", deck: "A", value: -1 } },
      { pos: handoverPos + 0.1, command: { control: "eq-low", deck: "B", value: 0 } },
      { pos: outPos, command: { control: "channel-fader", deck: "A", value: 0 } },
      { pos: outPos + 2 * beat, command: { control: "eq-low", deck: "A", value: 0 } },
    ]);
    await untilEnded(run);
    return {};
  },

  "filter-transition": async (run) => {
    const { plan, track } = run;
    const beat = beatSec(track.grid);
    const playPos = cuePos(plan, "Press , now. Fader B stays down");
    const sweepFrom = cuePos(plan, "CFX A right now, slowly. Fader B up at Phrase 3, bar 1");
    const blendPos = cuePos(plan, "Fader B up now. Keep turning CFX A right, slowly");
    const handoverPos = cuePos(plan, "At Phrase 4, bar 1: A out (S)") + barLength(track);
    await setUpThenReady(run, [{ control: "headphone-cue", deck: "B", value: true }]);
    const sweepBeats = (handoverPos - sweepFrom) / beat;
    await movesAt(run, [
      ...drag(track, sweepFrom, sweepBeats - 1, (value) => ({ control: "filter", deck: "A", value }), 0.06, 0.85),
      { pos: playPos, command: { control: "play", deck: "B" } },
      ...drag(track, blendPos, 4, fader("B"), 0, 1).slice(1),
      { pos: handoverPos, command: { control: "channel-fader", deck: "A", value: 0 } },
      { pos: handoverPos + 2 * beat, command: { control: "filter", deck: "A", value: 0 } },
    ]);
    await untilEnded(run);
    return {};
  },

  "nudge-phase": async (run) => {
    // "Two kicks: B's out. Nudge it with jog B", then hold it in line.
    await run.renderTo(run.now() + 0.5);
    const end = run.plan.endWhen;
    if (end.kind !== "held") throw new Error("nudge-phase ends once held");
    await rideTo(run, end.orPos);
    await untilEnded(run);
    return {};
  },

  "tempo-by-ear": async (run) => {
    // "Faster or slower? Match B with TEMPO B", then "Nudge it in line: jog B".
    await run.renderTo(run.now() + 1.5);
    matchTempo(run);
    await run.renderTo(run.now() + 0.5);
    const end = run.plan.endWhen;
    if (end.kind !== "held") throw new Error("tempo-by-ear ends once held");
    await rideTo(run, end.orPos);
    await untilEnded(run);
    return {};
  },

  "blend-by-ear": async (run) => {
    const { plan, track } = run;
    const beat = beatSec(track.grid);
    const inPos = cuePos(plan, "Next 1: fader B up") + barLength(track);
    const swapPos = cuePos(plan, "Next 1: swap the bass. LOW A down, LOW B up") + barLength(track);
    // "Next 1: fader A down slowly, over N bars", then "All the way down, then LOW A to the middle".
    const fade = cueStarting(plan, "Next 1: fader A down");
    const fadeBars = Number(/over (\d+(?:\.\d+)?) bars/.exec(fade.caption)?.[1]);
    if (!Number.isFinite(fadeBars)) throw new Error(`The fade caption names no length: "${fade.caption}"`);
    const outPos = fade.pos + barLength(track);
    const lowBack = cueStarting(plan, "All the way down, then LOW A").pos;
    // "Set up: LOW B all the way down", off the clock, then "Now match B".
    await setUpThenReady(run, plan.setUp?.caption.includes("LOW B all the way down") === true ? [{ control: "eq-low", deck: "B", value: -1 }] : []);
    const match = plan.cues.find((cue) => cue.caption.includes("Now match B"));
    if (match !== undefined) await run.toPos(match.fromPos);
    // Matched in the headphones first, then kept in line through the blend.
    await run.renderTo(run.now() + 1);
    matchTempo(run);
    await run.renderTo(run.now() + 0.5);
    await rideTo(run, inPos - barLength(track));
    const fadeEnd = outPos + fadeBars * barLength(track);
    const moves = [
      ...drag(track, inPos, 4, fader("B"), 0, 1),
      { pos: swapPos, command: { control: "eq-low", deck: "A", value: -1 } as EngineCommand },
      { pos: swapPos, command: { control: "eq-low", deck: "B", value: 0 } as EngineCommand },
      ...drag(track, outPos, 4 * fadeBars, fader("A"), 1, 0),
      // Once the caption says so and the fader is at the bottom.
      { pos: Math.max(lowBack, fadeEnd) + 0.5 * beat, command: { control: "eq-low", deck: "A", value: 0 } as EngineCommand },
    ].sort((a, b) => a.pos - b.pos);
    for (const move of moves) {
      // A look at the phase every bar or so between moves, as the ear keeps B in line.
      await rideTo(run, move.pos - beat);
      await run.toPos(move.pos);
      run.send(move.command);
    }
    await untilEnded(run);
    return {};
  },

  "hot-cues": async (run) => {
    const { plan, track } = run;
    const stops = plan.stops ?? [];
    // "Pad N: jog to this phrase's 1, Press N, then R": each stop is a little before a phrase start.
    for (const [slot, stop] of stops.entries()) {
      // The session parks A there itself, a lookahead after its Ready: render on until it is heard.
      for (let tries = 0; !(!run.engine.deckState("A").playing && Math.abs((run.engine.playheadAt("A", run.now())?.positionSec ?? -1) - stop) < 0.01); tries += 1) {
        if (tries > 50) throw new Error(`Deck A never paused at stop ${String(slot + 1)} (${stop.toFixed(3)} s).`);
        await run.renderTo(run.now() + 0.02);
      }
      await run.renderTo(run.now() + 0.05);
      run.send({ control: "jog-search", deck: "A", value: nextPhraseStart(track, stop) - stop });
      await run.renderTo(run.now() + 0.05);
      run.send({ control: "hot-cue-set", deck: "A", slot });
      run.session.ready();
      await run.renderTo(run.now() + 0.05);
    }
    // "Count the bars. Next phrase's 1: Press 1", then 8 bars on from each landing: Press 2, Press 3.
    await until(() => run.engine.deckState("A").playing, "deck A to play from the Check's start");
    let pressAt = nextPhraseStart(track, plan.startPos + 1e-3);
    for (const slot of stops.keys()) {
      await run.toPos(pressAt);
      run.send({ control: "hot-cue", deck: "A", slot });
      await run.renderTo(run.now() + 0.05);
      const landed = run.engine.playheadAt("A", run.now())?.positionSec ?? 0;
      pressAt = nextPhraseStart(track, landed - 0.1) + 8 * barLength(track);
    }
    await untilEnded(run);
    return {};
  },

  "loop-transition": async (run) => {
    const { plan, track } = run;
    // "Set up: CUE 🎧 B on", with "LOW B all the way down" when the Check swaps the bass (Lesson 12 passed).
    const swaps = (plan.stepCues ?? []).some((step) => step.caption.includes("swap the bass"));
    await setUpThenReady(run, [
      { control: "headphone-cue", deck: "B", value: true },
      ...(plan.setUp?.caption.includes("LOW B all the way down") === true ? [{ control: "eq-low", deck: "B", value: -1 } as const] : []),
    ]);
    const loopPos = nextPhraseStart(track, cueStarting(plan, "Next phrase's 1: LOOP IN").pos + 1e-3);
    const loopOut = cuePos(plan, "Count 4 bars: LOOP OUT on the 1 (F)") - beatSec(track.grid) + 4 * barLength(track);
    await run.toPos(loopPos);
    run.send({ control: "loop-in", deck: "A" });
    await run.toPos(loopOut);
    run.send({ control: "loop-out", deck: "A" });
    // "On the loop's 1: Press ,", ["Next loop's 1: swap the bass"], "Next loop's 1: EXIT (G)", "Fader A down (S)".
    const loopSec = loopOut - loopPos;
    const wrapped = run.now();
    let loops = 1;
    await run.renderTo(wrapped + loops * loopSec);
    run.send({ control: "play", deck: "B" });
    if (swaps) {
      loops += 1;
      await run.renderTo(wrapped + loops * loopSec - 0.1);
      run.send({ control: "eq-low", deck: "A", value: -1 });
      await run.renderTo(wrapped + loops * loopSec + 0.1);
      run.send({ control: "eq-low", deck: "B", value: 0 });
    }
    loops += 1;
    await run.renderTo(wrapped + loops * loopSec);
    run.send({ control: "loop-exit", deck: "A" });
    await run.renderTo(run.now() + 1);
    run.send({ control: "channel-fader", deck: "A", value: 0 });
    // "… then LOW A to the middle".
    if (swaps) {
      await run.renderTo(run.now() + 0.5);
      run.send({ control: "eq-low", deck: "A", value: 0 });
    }
    await untilEnded(run);
    return {};
  },

  "echo-out": async (run) => {
    const { plan, track } = run;
    await setUpThenReady(run, [
      { control: "headphone-cue", deck: "B", value: true },
      { control: "beat-fx", value: true },
    ]);
    const cutPos = cuePos(plan, "Next bar is the last: cut A on its 1 (S)") + barLength(track);
    const next = cuePos(plan, "Phrase's 1: Press ,") - beatSec(track.grid) + barLength(track);
    await run.toPos(cutPos);
    run.send({ control: "channel-fader", deck: "A", value: 0 });
    await run.toPos(next);
    run.send({ control: "play", deck: "B" });
    await run.renderTo(run.now() + 7 * beatSec(track.grid));
    run.send({ control: "beat-fx", value: false });
    await untilEnded(run);
    return {};
  },
};

function summary(outcome: CheckResult | VoidAttempt) {
  return "criteria" in outcome ? outcome.criteria.map(({ id, status, measured, detail }) => ({ id, status, measured, detail })) : outcome;
}

const runs = LESSONS.flatMap((lesson, index) => picksFor(lesson, SEED + index).map((pick) => ({ pick, index })));

/** The rotation picks 3 Originals for every Lesson, and a partner for each pair Lesson. */
export function describePicks(): void {
  it("picks 3 Originals for every Lesson, and a partner for each pair Lesson", () => {
    for (const lesson of LESSONS) {
      const picks = runs.filter(({ pick }) => pick.lesson.id === lesson.id).map(({ pick }) => pick);
      expect(picks.map((pick) => pick.main.id), lesson.id).toHaveLength(TRACKS_PER_LESSON);
      expect(new Set(picks.map((pick) => pick.main.id)).size, lesson.id).toBe(TRACKS_PER_LESSON);
      for (const pick of picks) expect(pick.partner !== null, `${lesson.id} on ${pick.main.id}`).toBe(lesson.partner !== undefined);
    }
  });
}

/** Lessons `first`…`last` (1-based, catalogue order), each on its picks, following the captions. */
export function describeLessons(first: number, last: number): void {
  afterEach(cleanUp);
  const picked = runs.filter(({ index }) => index + 1 >= first && index + 1 <= last);
  it.each(picked.map(({ pick, index }) => ({ name: `Lesson ${String(index + 1)} (${pick.lesson.title}) on ${pick.main.id} ${pick.main.title}${pick.partner === null ? "" : ` with ${pick.partner.id} ${pick.partner.title}`}`, pick, index })))(
    "$name passes",
    { timeout: 120_000 },
    async ({ pick, index }) => {
      // Every earlier Lesson passed: the plan's captions may build on them (Lesson 18's bass swap after Lesson 12).
      const passed = LESSONS.slice(0, index).map((lesson) => lesson.id);
      const run = await harness(pick, passed);
      // A moment of practice first, as the Learner has: the recorded playheads hold it too.
      run.session.preparePractice();
      await run.renderTo(2);
      await startedCheck(run);
      const answers = await FOLLOW[pick.lesson.id](run);
      const graded = await run.session.grade(answers, passed);
      run.session.close();
      if (!graded.ok) throw new Error(graded.message);
      expect(graded.outcome.outcome, JSON.stringify(summary(graded.outcome))).toEqual({ kind: "passed" });
    },
  );
}
