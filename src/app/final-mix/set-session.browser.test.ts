// SetSession on a real engine, rendered offline (never the speakers).
import { afterEach, describe, expect, it } from "vitest";
import { createAudioEngine, type AudioEngine, type EngineCommand } from "@audio";
import { setEntry, SYNTHETIC_HOUSE, SYNTHETIC_SET, syntheticLessonTrack, synthesizeHouse, type LessonTrack, type SyntheticLayout } from "@lessons";
import type { DeckId } from "@shared/attempt.ts";
import { LESSON_IDS } from "@shared/catalogue.ts";
import { offlineRun, type OfflineRun } from "../lesson/lesson-test-support.ts";
import { SetSession, type SetTrackInfo } from "./set-session.ts";

const SAMPLE_RATE = 48_000;
/** A real context's lookahead: baseLatency + 2 render quanta. */
const LOOKAHEAD_SEC = 0.0116 + 256 / SAMPLE_RATE;

let engine: AudioEngine | null = null;
let run: OfflineRun | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
  await run?.close();
  run = null;
});

function trackInfo(track: LessonTrack, layout: SyntheticLayout): SetTrackInfo {
  const candidate = { track, artist: "test", genre: "house", camelot: null, shareable: false };
  return {
    entry: setEntry(candidate),
    prepared: {
      candidate,
      loadAudio: () => {
        const samples = synthesizeHouse(layout, SAMPLE_RATE);
        const buffer = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: SAMPLE_RATE });
        buffer.copyToChannel(samples, 0);
        return Promise.resolve(buffer);
      },
    },
  };
}

/** The synthetic groove with a lead-in: its bar 1 (and every phrase start) `leadInSec` into the file. */
function withLeadIn(id: string, leadInSec: number): SetTrackInfo {
  const plain = syntheticLessonTrack({ ...SYNTHETIC_HOUSE, id });
  const track: LessonTrack = {
    ...plain,
    grid: { ...plain.grid, firstBeat: leadInSec },
    phraseStarts: plain.phraseStarts.map((start) => start + leadInSec).filter((start) => start < plain.durationSec),
  };
  return trackInfo(track, SYNTHETIC_HOUSE);
}

describe("SetSession", () => {
  it("loads each track paused on its bar 1, its cue point there, as DJ software's auto cue does", async () => {
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: SAMPLE_RATE * 4, sampleRate: SAMPLE_RATE });
    engine = await createAudioEngine({ context, masterTempo: false, lookaheadSec: 0 });
    const session = new SetSession(engine, [withLeadIn("lead-in/a", 2.3), withLeadIn("lead-in/b", 1.1)], "learner-1", () => undefined);
    try {
      await session.warmUp(new AbortController().signal);
      expect(engine.deckState("A")).toMatchObject({ playing: false, cuePointSec: 2.3 });
      expect(engine.deckState("B")).toMatchObject({ playing: false, cuePointSec: 1.1 });
    } finally {
      session.close();
    }
  });
});

const setTrack = (id: string): SetTrackInfo => {
  const found = SYNTHETIC_SET.find((each) => each.layout.id === id);
  if (found === undefined) throw new Error(`no synthetic set track ${id}`);
  return trackInfo(syntheticLessonTrack(found.layout), found.layout);
};

describe.each([
  { what: "wired output (40 ms)", latencySec: 0.04 },
  { what: "Bluetooth headphones (250 ms)", latencySec: 0.25 },
])("the final set by ear on $what", ({ latencySec }) => {
  it("passes three tracks with a cut and a blend made as the Lessons taught them", { timeout: 180_000 }, async () => {
    const offline = await offlineRun({ sampleRate: SAMPLE_RATE, renderSec: 200, latencySec, lookaheadSec: LOOKAHEAD_SEC });
    run = offline;
    const { engine: decks } = offline;
    // Two 124 BPM grooves, then one at 123 (0.8% slower): the blend needs its tempo matched by ear.
    const tracks = [setTrack("synthetic/set-124a"), setTrack("synthetic/set-124e"), setTrack("synthetic/set-123")];
    const bpm = (deck: DeckId, trackBpm: number) => trackBpm * decks.deckState(deck).tempoRate;
    let timedOut = false;
    const session = new SetSession(decks, tracks, "learner-1", () => {
      timedOut = true;
    });
    const signal = new AbortController().signal;
    /** Sends a Learner's command now; returns when it takes effect (render time). */
    const press = (command: EngineCommand): number => {
      let appliedAt = Number.NaN;
      const stop = decks.on("command", (event) => {
        if (event.command === command) appliedAt = event.appliedCtx;
      });
      const sent = decks.command(command, { device: "keyboard" });
      stop();
      if (!sent.ok) throw new Error(`the engine refused ${JSON.stringify(command)}: ${JSON.stringify(sent.error)}`);
      return appliedAt;
    };
    /** `deck`'s beat against `reference`'s as heard now, wrapped to ±½ beat. */
    const phaseOff = (deck: DeckId, reference: DeckId) => {
      const heard = offline.heardNow();
      const off = (decks.playheadAt(deck, heard)?.beat ?? Number.NaN) - (decks.playheadAt(reference, heard)?.beat ?? Number.NaN);
      return off - Math.round(off);
    };
    try {
      await session.warmUp(signal);
      press({ control: "headphone-cue", deck: "B", value: true });
      expect(session.startSet()).toEqual({ ok: true });
      const bar = (4 * 60) / 124;
      // Track 1 from its bar 1; a cut to track 2 on its third phrase's 1 (Lesson 7): Play B, B up, A down.
      const playedA = press({ control: "play", deck: "A" });
      await offline.renderToHeard(playedA + 16 * bar);
      const playedB = press({ control: "play", deck: "B" });
      press({ control: "channel-fader", deck: "B", value: 1 });
      press({ control: "channel-fader", deck: "A", value: 0 });
      press({ control: "headphone-cue", deck: "B", value: false });
      // Track 3 onto the free deck, cued in the headphones with its LOW cut (Lesson 16).
      await offline.renderTo(offline.now() + 2);
      expect(await session.loadNext(signal)).toEqual({ ok: true });
      press({ control: "headphone-cue", deck: "A", value: true });
      press({ control: "eq-low", deck: "A", value: -1 });
      // On track 2's third phrase: Play track 3 in the headphones, match its tempo by ear, nudge it in line.
      await offline.renderToHeard(playedB + 16 * bar);
      press({ control: "play", deck: "A" });
      await offline.renderToHeard(playedB + 17 * bar);
      const range = decks.deckState("A").tempoRangePercent;
      press({ control: "tempo", deck: "A", value: (((124 + 0.03) / 123 - 1) * 100) / range });
      await offline.renderToHeard(playedB + 18 * bar);
      const off = phaseOff("A", "B");
      press({ control: "jog-bend", deck: "A", value: off > 0 ? -0.04 : 0.04 });
      await offline.renderTo(offline.now() + Math.abs(off) / (0.04 * (bpm("A", 123) / 60)));
      press({ control: "jog-bend", deck: "A", value: 0 });
      // Fourth phrase: fader A up (the blend); fifth: swap the bass, then fader B down over 2 bars.
      await offline.renderToHeard(playedB + 24 * bar);
      for (let step = 1; step <= 4; step += 1) {
        await offline.renderTo(offline.now() + bar / 16);
        press({ control: "channel-fader", deck: "A", value: step / 4 });
      }
      press({ control: "headphone-cue", deck: "A", value: false });
      await offline.renderToHeard(playedB + 32 * bar - 0.03);
      press({ control: "eq-low", deck: "B", value: -1 });
      await offline.renderTo(offline.now() + 0.06);
      press({ control: "eq-low", deck: "A", value: 0 });
      for (let step = 1; step <= 16; step += 1) {
        await offline.renderTo(offline.now() + bar / 8);
        press({ control: "channel-fader", deck: "B", value: 1 - step / 16 });
      }
      press({ control: "eq-low", deck: "B", value: 0 });
      // Track 3 rides for two more phrases; End set.
      await offline.renderToHeard(playedB + 52 * bar);
      const graded = await session.end({ passedLessons: LESSON_IDS.filter((id) => id !== "final-mix"), mode: "lesson", timedOut });
      if ("error" in graded) throw new Error(graded.error);
      const summary = "criteria" in graded.outcome ? graded.outcome.criteria.map(({ id, status, measured }) => ({ id, status, measured })) : graded.outcome.outcome;
      expect(graded.outcome.outcome, JSON.stringify(summary)).toMatchObject({ kind: "passed" });
      expect(graded.transitions.map((transition) => transition.kind)).toEqual(["cut", "blend"]);
    } finally {
      session.close();
    }
  });
});
