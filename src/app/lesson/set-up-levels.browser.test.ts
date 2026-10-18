// Every Lesson's and Placement task's Check set-up starts out of the red on hot tracks: rendered offline
// through the real engine at 48 kHz (never the speakers), the master and every playing channel's meter
// peak under the clip level for the first bars, before the Learner touches anything. gain-staging is
// the one exception: its deck A starts in the red on purpose.
import { afterEach, describe, expect, it } from "vitest";
import { createAudioEngine, type AudioEngine } from "@audio";
import { CLIP_DBFS } from "@checks/lessons/deck-basics.ts";
import {
  LESSONS,
  PLACEMENT_TASK_IDS,
  peakDbfsOf,
  placementTask,
  SYNTHETIC_HOUSE,
  SYNTHETIC_PARTNER,
  synthesizeHouse,
  syntheticLessonTrack,
  trackOnDeck,
  type LessonDefinition,
  type LessonTrack,
  type SyntheticLayout,
} from "@lessons";
import type { DeckId } from "@shared/attempt.ts";
import { decoderAt } from "@tracks";
import drop014Url from "../../tracks/fixtures/original-drop-014.mp3?url";
import drop038Url from "../../tracks/fixtures/original-drop-038.mp3?url";
import { LessonSession } from "./lesson-session.ts";

const SAMPLE_RATE = 48_000;
/** Bars listened to from the Check's start: the set-up's level, before any move. */
const LISTEN_BARS = 2;
const SETTLE_SEC = 0.1;
const DECKS: readonly DeckId[] = ["A", "B"];
/** Lessons whose set-up starts a deck in the red on purpose. */
const STARTS_IN_THE_RED: ReadonlySet<string> = new Set(["gain-staging"]);

interface TrackSet {
  readonly name: string;
  /** Deck A's track, with its partner (deck B in a two-track Lesson); peaks measured as the app does. */
  readonly track: LessonTrack;
  readonly audio: AudioBuffer;
  readonly partnerAudio: AudioBuffer;
}

let engine: AudioEngine | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
});

function bufferOf(channels: readonly Float32Array[]): AudioBuffer {
  const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0]?.length ?? 1, sampleRate: SAMPLE_RATE });
  channels.forEach((channel, index) => {
    buffer.copyToChannel(Float32Array.from(channel), index);
  });
  return buffer;
}

const channelsOf = (buffer: AudioBuffer) => Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));

/** The layout's track with `audio` as its audio, its peak measured from it (as LessonPlayer does). */
function measured(layout: SyntheticLayout, audio: AudioBuffer): LessonTrack {
  return { ...syntheticLessonTrack(layout), peakDbfs: peakDbfsOf(channelsOf(audio)) };
}

function trackSet(name: string, audio: AudioBuffer, partnerAudio: AudioBuffer): TrackSet {
  const partner = measured(SYNTHETIC_PARTNER, partnerAudio);
  return { name, track: { ...measured(SYNTHETIC_HOUSE, audio), partner }, audio, partnerAudio };
}

/** The synthetic groove mastered to full scale, as hot as a track can be without clipping itself. */
function hotSynthetic(): TrackSet {
  const hot = (layout: SyntheticLayout) => bufferOf([synthesizeHouse({ ...layout, peakDbfs: 0 }, SAMPLE_RATE)]);
  return trackSet("synthetic groove at 0 dBFS", hot(SYNTHETIC_HOUSE), hot(SYNTHETIC_PARTNER));
}

/**
 * Two Originals as the loaders pair them (house, 120 BPM, mastered to about −8.6 LUFS): 4 bars of
 * each one's drop, repeated for the synthetic layout's length so every set-up position plays music.
 */
async function originalPair(): Promise<TrackSet> {
  const decode = decoderAt(SAMPLE_RATE);
  const tiled = async (url: string, layout: SyntheticLayout) => {
    const excerpt = await decode(await (await fetch(url)).arrayBuffer());
    const length = Math.round(syntheticLessonTrack(layout).durationSec * SAMPLE_RATE);
    return bufferOf(channelsOf(excerpt).map((channel) => Float32Array.from({ length }, (_, index) => channel[index % channel.length] ?? 0)));
  };
  return trackSet("Originals 014 + 038 (drops)", await tiled(drop014Url, SYNTHETIC_HOUSE), await tiled(drop038Url, SYNTHETIC_PARTNER));
}

/** Waits, on the wall clock, for something the session does on its own timers or promises. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Gave up after 10 s waiting for ${what}; is the machine badly overloaded?`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The highest sample peak each meter read over the first bars of the definition's Check, dBFS, by bus:
 * the master, each playing channel, and the Beat FX return (echo-out sets ECHO up; its echoes join the master).
 */
async function startingPeaks(
  definition: LessonDefinition,
  set: TrackSet,
): Promise<{ readonly master: number; readonly fx: number; readonly playing: Partial<Record<DeckId, number>> }> {
  const { track } = set;
  const barSec = (4 * 60) / track.grid.bpm;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round((LISTEN_BARS * barSec + 2) * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  const running = await createAudioEngine({ context, masterTempo: false });
  engine = running;
  const usesB = LessonSession.usesDeckB(definition, track);
  expect(await running.load("A", set.audio, { trackId: track.trackId, grid: track.grid })).toEqual({ ok: true });
  if (usesB) {
    const onB = trackOnDeck(track, "B");
    const audioB = onB.trackId === track.trackId ? set.audio : set.partnerAudio;
    expect(await running.load("B", audioB, { trackId: onB.trackId, grid: onB.grid })).toEqual({ ok: true });
  }
  const peaks: Record<"master" | "fx" | DeckId, number> = { master: Number.NEGATIVE_INFINITY, fx: Number.NEGATIVE_INFINITY, A: Number.NEGATIVE_INFINITY, B: Number.NEGATIVE_INFINITY };
  let trimmedA = false;
  const stops = [
    running.on("meter", (frame) => {
      // From 0.1 s: a set-up trim glides in over 3 ms as Play starts (offline, both happen at 0 s).
      if (frame.ctx >= SETTLE_SEC) peaks[frame.bus] = Math.max(peaks[frame.bus], frame.samplePeakDb);
    }),
    running.on("command", (event) => {
      if (event.command.control === "trim" && event.command.deck === "A") trimmedA = true;
    }),
  ];
  const listener = {
    observed: () => undefined,
    audioEnded: () => undefined,
    checkFailed: (message: string) => {
      throw new Error(message);
    },
  };
  const session = new LessonSession(running, definition, track, set.audio, "learner-1", listener, usesB);
  try {
    session.startCheck();
    // Every set-up turns TRIM A; the rest of it (and an auto-play) follows in the same task.
    await until(() => trimmedA, "the session to set up the Check");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A Check the Learner starts (deck-basics, cue-point): press Play as they would.
    if (!DECKS.some((deck) => running.deckState(deck).playing)) expect(running.command({ control: "play", deck: "A" }, { device: "touch" })).toEqual({ ok: true });
    await context.startRendering();
    const playing = Object.fromEntries(DECKS.filter((deck) => running.deckState(deck).playing).map((deck) => [deck, peaks[deck]]));
    return { master: peaks.master, fx: peaks.fx, playing };
  } finally {
    session.close();
    for (const stop of stops) stop();
  }
}

const DEFINITIONS: readonly (readonly [string, LessonDefinition])[] = [
  ...LESSONS.map((definition) => [definition.id, definition] as const),
  ...PLACEMENT_TASK_IDS.map((id) => [`Placement ${id}`, placementTask(id)] as const),
];

describe.each([
  { name: "hot synthetic", make: async () => Promise.resolve(hotSynthetic()) },
  { name: "Original pair", make: originalPair },
])("Check set-ups on the $name", ({ make }) => {
  let set: TrackSet | null = null;
  const tracks = async () => (set ??= await make());

  it.each(DEFINITIONS)("%s starts out of the red", { timeout: 30_000 }, async (id, definition) => {
    const loaded = await tracks();
    expect(definition.trackProblems(loaded.track), `the fixture must carry ${id}`).toEqual([]);
    const { master, fx, playing } = await startingPeaks(definition, loaded);
    const what = `${id} on ${loaded.name}: master ${master.toFixed(2)} dBFS, FX return ${fx.toFixed(2)} dBFS, channels ${JSON.stringify(playing)}`;
    expect(Object.keys(playing).length, what).toBeGreaterThan(0);
    if (STARTS_IN_THE_RED.has(id)) {
      // gain-staging: A is handed in the red (its own criteria grade it); B still starts out of it.
      expect(playing.A, what).toBeGreaterThan(CLIP_DBFS);
      if (playing.B !== undefined) expect(playing.B, what).toBeLessThanOrEqual(CLIP_DBFS);
      return;
    }
    expect(master, what).toBeLessThanOrEqual(CLIP_DBFS);
    expect(fx, what).toBeLessThanOrEqual(CLIP_DBFS);
    for (const peak of Object.values(playing)) expect(peak, what).toBeLessThanOrEqual(CLIP_DBFS);
  });
});
