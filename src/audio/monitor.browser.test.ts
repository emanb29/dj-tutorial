import { describe, expect, it } from "vitest";
import type { EngineCommand } from "./commands.ts";
import { SplitCueMonitor } from "./monitor.ts";
import { channelRmsDb, engineWithTone, expectOk, KEYBOARD, sineRmsDb } from "./offline-test-support.ts";

const PEAK = 0.5;
const SECONDS = 0.5;
const LEFT = 0;
const RIGHT = 1;

async function renderSplitCue(commands: readonly EngineCommand[], tone: { frequency: number; rightFrequency?: number } = { frequency: 1000 }) {
  const { context, engine } = await engineWithTone(SECONDS, { ...tone, peak: PEAK }, { monitor: new SplitCueMonitor() });
  for (const command of commands) expectOk(engine.command(command, KEYBOARD));
  const rendered = await context.startRendering();
  return {
    leftDb: channelRmsDb(rendered, LEFT, 0.2, SECONDS) - sineRmsDb(PEAK),
    rightDb: channelRmsDb(rendered, RIGHT, 0.2, SECONDS) - sineRmsDb(PEAK),
  };
}

describe("split-cue monitor output", () => {
  it("puts a cued channel in the left ear even with its fader down, and keeps it off the master", async () => {
    const { leftDb, rightDb } = await renderSplitCue([
      { control: "headphone-cue", deck: "A", value: true },
      { control: "channel-fader", deck: "A", value: 0 },
    ]);
    expect(leftDb).toBeCloseTo(0, 1);
    expect(rightDb).toBeLessThan(-100);
  });

  it("puts the master in the right ear and nothing in the left when no channel is cued", async () => {
    const { leftDb, rightDb } = await renderSplitCue([]);
    expect(leftDb).toBeLessThan(-100);
    expect(rightDb).toBeCloseTo(0, 1);
  });

  it("blends the master into the left ear with the cue/master mix knob", async () => {
    const { leftDb } = await renderSplitCue([
      { control: "channel-fader", deck: "A", value: 1 },
      { control: "cue-mix", value: 1 },
    ]);
    expect(leftDb).toBeCloseTo(0, 1);
  });

  it("attaching twice to the same buses does not double the output", async () => {
    const monitor = new SplitCueMonitor();
    const { context, engine } = await engineWithTone(SECONDS, { frequency: 1000, peak: PEAK }, { monitor });
    monitor.attach({ context, master: engine.mixer.master, cue: engine.mixer.cue });
    const rendered = await context.startRendering();
    expect(channelRmsDb(rendered, RIGHT, 0.2, SECONDS) - sineRmsDb(PEAK)).toBeCloseTo(0, 1);
  });

  it("detaching disconnects everything it connected", async () => {
    const monitor = new SplitCueMonitor();
    const { context } = await engineWithTone(SECONDS, { frequency: 1000, peak: PEAK }, { monitor });
    monitor.detach();
    const rendered = await context.startRendering();
    expect(channelRmsDb(rendered, RIGHT, 0.2, SECONDS)).toBe(Number.NEGATIVE_INFINITY);
    expect(channelRmsDb(rendered, LEFT, 0.2, SECONDS)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("sums stereo to mono in each ear: (L + R) / 2", async () => {
    // Left 1 kHz and right 3 kHz sines of peak 0.5 down-mix to two sines of peak 0.25: RMS 0.25, which
    // is 3.01 dB below one sine of peak 0.5.
    const { rightDb } = await renderSplitCue([], { frequency: 1000, rightFrequency: 3000 });
    expect(rightDb).toBeCloseTo(-3.01, 1);
  });
});
