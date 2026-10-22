// Master Tempo through a real (running) AudioContext, not an offline render. The stretch worklet was
// silent only there: offline renders played it, so the offline tests in deck.browser.test.ts passed
// while the app's Master Tempo was mute. Chromium runs with --mute-audio, so nothing reaches the
// speakers; the level is read from an AnalyserNode on the master.

import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { EngineCommand } from "./commands.ts";
import { createAudioEngine, type AudioEngine } from "./engine.ts";
import { rmsDb, send, sineRmsDb, toneBuffer } from "./offline-test-support.ts";

const TONE_PEAK = 0.5;
/** Long enough past the stretcher's latency (0.12 s) and the lookahead for the deck to be heard. */
const SETTLE_MS = 400;
const LISTEN_MS = 300;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let engine: AudioEngine | null = null;

afterEach(async () => {
  await engine?.close();
  engine = null;
});

/** An engine on a running AudioContext (a click grants the user activation autoplay needs), deck A loaded with a tone. */
async function realtimeEngine(): Promise<{ engine: AudioEngine; quietestDb: () => Promise<number> }> {
  const button = document.createElement("button");
  button.textContent = "Start audio";
  document.body.append(button);
  await userEvent.click(button);
  button.remove();
  const context = new AudioContext({ latencyHint: "interactive" });
  await context.resume();
  expect(context.state, "the AudioContext must run for this test; it needs a user activation").toBe("running");
  const created = await createAudioEngine({ context });
  await created.load("A", toneBuffer(context, { frequency: 440, peak: TONE_PEAK, seconds: 20 }), { trackId: "tone", grid: null });
  const analyser = new AnalyserNode(context, { fftSize: 2048 });
  created.mixer.master.connect(analyser);
  // The quietest of several readings over LISTEN_MS: a deck that is heard all along reads loud in every one.
  const quietestDb = async () => {
    const readings: number[] = [];
    const data = new Float32Array(analyser.fftSize);
    const until = performance.now() + LISTEN_MS;
    while (performance.now() < until) {
      analyser.getFloatTimeDomainData(data);
      readings.push(rmsDb(data));
      await wait(30);
    }
    return Math.min(...readings);
  };
  engine = created;
  return { engine: created, quietestDb };
}

async function heardAfter(commands: readonly EngineCommand[]): Promise<number> {
  const { engine: running, quietestDb } = await realtimeEngine();
  send(running, ...commands);
  await wait(SETTLE_MS);
  return quietestDb();
}

describe("Master Tempo in a running AudioContext", () => {
  // The tone at full channel fader and centred crossfader, within a few dB (the stretcher's STFT and
  // the crossfader's curve shave a little off).
  const loud = sineRmsDb(TONE_PEAK) - 6;

  it("plays the deck with Master Tempo off (the comparison)", async () => {
    expect(await heardAfter([{ control: "play", deck: "A" }])).toBeGreaterThan(loud);
  });

  it("plays the deck with Master Tempo on", async () => {
    expect(await heardAfter([{ control: "master-tempo", deck: "A", value: true }, { control: "play", deck: "A" }])).toBeGreaterThan(loud);
  });

  it("plays the ear round's On clip after its Off clip: pause, Master Tempo on, seek, play", async () => {
    const { engine: running, quietestDb } = await realtimeEngine();
    send(running, { control: "play", deck: "A" });
    await wait(SETTLE_MS);
    expect(await quietestDb()).toBeGreaterThan(loud);
    send(
      running,
      { control: "pause", deck: "A" },
      { control: "master-tempo", deck: "A", value: true },
      { control: "seek", deck: "A", value: 1 },
      { control: "play", deck: "A" },
    );
    await wait(SETTLE_MS);
    expect(await quietestDb()).toBeGreaterThan(loud);
    // The clip's tempo jump: still heard.
    send(running, { control: "tempo", deck: "A", value: 0.5 });
    await wait(SETTLE_MS);
    expect(await quietestDb()).toBeGreaterThan(loud);
  });
});
