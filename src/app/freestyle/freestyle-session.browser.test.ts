// FreestyleSession on a real engine, rendered offline (never the speakers).
import { afterEach, describe, expect, it } from "vitest";
import { createAudioEngine, type AudioEngine } from "@audio";
import { SYNTHETIC_HOUSE, syntheticLessonTrack, synthesizeHouse, type LessonTrack } from "@lessons";
import type { PreparedTrack } from "../final-mix/library.ts";
import { FreestyleSession } from "./freestyle-session.ts";

const SAMPLE_RATE = 48_000;

let engine: AudioEngine | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
});

/** The synthetic groove with its bar 1 `leadInSec` into the file. */
function prepared(id: string, leadInSec: number): PreparedTrack {
  const plain = syntheticLessonTrack({ ...SYNTHETIC_HOUSE, id });
  const track: LessonTrack = {
    ...plain,
    grid: { ...plain.grid, firstBeat: leadInSec },
    phraseStarts: plain.phraseStarts.map((start) => start + leadInSec).filter((start) => start < plain.durationSec),
  };
  return {
    candidate: { track, artist: "test", genre: "house", camelot: null, shareable: false },
    loadAudio: () => {
      const samples = synthesizeHouse(SYNTHETIC_HOUSE, SAMPLE_RATE);
      const buffer = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: SAMPLE_RATE });
      buffer.copyToChannel(samples, 0);
      return Promise.resolve(buffer);
    },
  };
}

async function offlineEngine(): Promise<AudioEngine> {
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: SAMPLE_RATE * 4, sampleRate: SAMPLE_RATE });
  engine = await createAudioEngine({ context, masterTempo: false, lookaheadSec: 0 });
  return engine;
}

const signal = () => new AbortController().signal;

describe("FreestyleSession", () => {
  it("loads a track onto either deck paused on its bar 1, its cue point there", async () => {
    const created = await offlineEngine();
    const session = new FreestyleSession(created, { hardwareConnected: () => false });
    expect(await session.load("A", prepared("free/a", 2.3), signal())).toEqual({ ok: true });
    expect(await session.load("B", prepared("free/b", 1.1), signal())).toEqual({ ok: true });
    expect(created.deckState("A")).toMatchObject({ playing: false, cuePointSec: 2.3 });
    expect(created.deckState("B")).toMatchObject({ playing: false, cuePointSec: 1.1 });
    expect(session.track("A")?.trackId).toBe("free/a");
    expect(session.track("B")?.trackId).toBe("free/b");
  });

  it("refuses to load onto a playing deck, as a CDJ does", async () => {
    const created = await offlineEngine();
    const session = new FreestyleSession(created, { hardwareConnected: () => false });
    await session.load("A", prepared("free/a", 0), signal());
    expect(created.command({ control: "play", deck: "A" }, { device: "keyboard" }).ok).toBe(true);
    expect(session.loadBlocker("A")).toBe("Pause deck A first");
    expect(await session.load("A", prepared("free/c", 0), signal())).toEqual({ ok: false, message: "Pause deck A first" });
    expect(session.track("A")?.trackId).toBe("free/a");
  });

  it("sets TRIM out of the red without a controller, and leaves it to the hardware with one", async () => {
    const created = await offlineEngine();
    let connected = false;
    const session = new FreestyleSession(created, { hardwareConnected: () => connected });
    const before = created.mixerState().channels.A.trim;
    await session.load("A", prepared("free/a", 0), signal());
    const softwareTrim = created.mixerState().channels.A.trim;
    expect(softwareTrim).not.toBe(before);
    connected = true;
    await session.load("B", prepared("free/b", 0), signal());
    expect(created.mixerState().channels.B.trim).toBe(before);
  });
});
