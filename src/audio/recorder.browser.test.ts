import { describe, expect, it } from "vitest";
import type { BeatGrid } from "./beat-grid.ts";
import { createAudioEngine } from "./engine.ts";
import { KEYBOARD, offlineContext, toneBuffer } from "./offline-test-support.ts";
import type { OutputClock } from "./output-clock.ts";
import { AttemptRecorder, type AttemptDetails } from "./recorder.ts";

/** A clock whose heard time is performance time minus 4 s; "now" is performance time 5 s. */
const shiftedClock: OutputClock = {
  heardTime: (performanceTimeMs = 5_000) => ({ ok: true, ctx: performanceTimeMs / 1000 - 4 }),
};

const grid: BeatGrid = { bpm: 120, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 4 };
const details: AttemptDetails = {
  attemptId: "attempt-1",
  learnerId: "learner-1",
  endReason: "done",
  abandoned: false,
  phraseMarkers: { "track-a": [0, 16] },
  answers: {},
};
const wallClock = () => new Date("2026-10-17T10:00:00.000Z");

async function engineWithTrack(options: { seconds: number; clock?: OutputClock }) {
  const context = offlineContext(options.seconds);
  const engine = await createAudioEngine(options.clock === undefined ? { context } : { context, clock: options.clock });
  await engine.load("A", toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: options.seconds + 1 }), { trackId: "track-a", grid });
  return { context, engine };
}

async function stopped(recorder: AttemptRecorder) {
  const result = await recorder.stop(details);
  if (!result.ok) throw new Error(`stop failed: ${result.error.kind}`);
  return result.attempt;
}

describe("AttemptRecorder", () => {
  it("records contract controls at heard time, in the Checks' units, with device and applied time as extras", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    expect(recorder.start()).toEqual({ ok: true });

    engine.command({ control: "play", deck: "A" }, { device: "keyboard", eventTimeMs: 5_250 });
    engine.command({ control: "channel-fader", deck: "A", value: 0.4 }, { device: "trackpad", eventTimeMs: 5_500 });
    engine.command({ control: "crossfader", value: 0.6 }, { device: "trackpad", eventTimeMs: 5_600 });
    engine.command({ control: "eq-low", deck: "B", value: -1 }, { device: "trackpad", eventTimeMs: 5_700 });
    engine.command({ control: "trim", deck: "A", value: -0.5 }, { device: "trackpad", eventTimeMs: 5_710 });
    engine.command({ control: "headphone-cue", deck: "B", value: true }, { device: "mouse", eventTimeMs: 5_720 });
    engine.command({ control: "eq-low", deck: "B", value: 7 }, { device: "trackpad", eventTimeMs: 5_730 });
    engine.command({ control: "tap" }, { device: "keyboard", eventTimeMs: 5_800 });
    engine.command({ control: "ready", deck: "A" }, { device: "keyboard", eventTimeMs: 5_850 });
    engine.command({ control: "done" }, { device: "keyboard", eventTimeMs: 5_900 });
    const attempt = await stopped(recorder);

    expect(attempt.events).toEqual([
      { ctx: 1.5, control: "channelFader", deck: "A", value: 0.4, appliedCtx: 0, inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.6, 9) as number, control: "crossfader", value: 0.6, appliedCtx: 0, inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.7, 9) as number, control: "eqLow", deck: "B", value: -120, appliedCtx: 0, inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.71, 9) as number, control: "trim", deck: "A", value: -12, appliedCtx: 0, inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.72, 9) as number, control: "cueMonitor", deck: "B", value: 1, appliedCtx: 0, inputDevice: "mouse" },
      { ctx: expect.closeTo(1.8, 9) as number, control: "tap", value: 1, appliedCtx: 0, inputDevice: "keyboard" },
      { ctx: expect.closeTo(1.85, 9) as number, control: "ready", deck: "A", value: 1, appliedCtx: 0, inputDevice: "keyboard" },
      { ctx: expect.closeTo(1.9, 9) as number, control: "done", value: 1, appliedCtx: 0, inputDevice: "keyboard" },
    ]);
    expect(attempt.inputDevice).toBe("trackpad");
    // Every command, including ones the Checks do not read and ones the engine refused, is kept as an extra.
    expect(attempt.engineEvents.map((event) => [event.command.control, event.rejected?.kind ?? null])).toContainEqual(["play", null]);
    expect(attempt.engineEvents.map((event) => [event.command.control, event.rejected?.kind ?? null])).toContainEqual(["eq-low", "value-out-of-range"]);
  });

  it("captures meters per bus, the deck's playhead model, grids, the initial mixer and the attempt details", async () => {
    const { context, engine } = await engineWithTrack({ seconds: 1 });
    engine.command({ control: "channel-fader", deck: "B", value: 0 }, KEYBOARD);
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    engine.command({ control: "play", deck: "A" }, KEYBOARD);
    await context.startRendering();
    // stop() itself waits for the last meter frames to arrive.
    const attempt = await stopped(recorder);

    expect(attempt).toMatchObject({
      attemptId: "attempt-1",
      learnerId: "learner-1",
      startedAt: "2026-10-17T10:00:00.000Z",
      endedAt: "2026-10-17T10:00:00.000Z",
      endReason: "done",
      abandoned: false,
      interruptions: [],
      phraseMarkers: { "track-a": [0, 16] },
      grids: { "track-a": grid },
      decks: { A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }] } } },
      cuePoints: [],
    });
    expect(attempt.meters.master).toHaveLength(50);
    expect(attempt.meters.A).toHaveLength(50);
    expect(attempt.meters.B).toHaveLength(50);
    expect(Object.keys(attempt.meters.master[0] ?? {}).sort()).toEqual(["ctx", "momentaryLufs", "samplePeakDb", "shortTermLufs"]);
    expect(attempt.initialMixer).toEqual({
      A: { channelFader: 1, trimDb: 0, eqHighDb: 0, eqMidDb: 0, eqLowDb: 0, cueMonitor: false },
      B: { channelFader: 0, trimDb: 0, eqHighDb: 0, eqMidDb: 0, eqLowDb: 0, cueMonitor: false },
      crossfader: 0.5,
    });
  });

  it("records cue points the Learner sets with deck CUE", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1 });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    engine.command({ control: "seek", deck: "A", value: 0.75 }, KEYBOARD);
    engine.command({ control: "deck-cue", deck: "A", value: true }, KEYBOARD);
    engine.command({ control: "deck-cue", deck: "A", value: false }, KEYBOARD);
    const attempt = await stopped(recorder);

    expect(attempt.cuePoints).toEqual([{ ctx: 0, deck: "A", trackId: "track-a", pos: 0.75 }]);
    expect(attempt.events.map((event) => [event.control, event.value])).toEqual([
      ["deckCue", 1],
      ["deckCue", 0],
    ]);
  });

  it("coalesces pointer-rate moves to about 30 per second, keeping the first move and the gesture end exactly", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    for (let step = 0; step <= 100; step++) {
      engine.command(
        { control: "channel-fader", deck: "A", value: step / 100 },
        { device: "trackpad", eventTimeMs: 5_000 + step, gestureEnd: step === 100 },
      );
    }
    const attempt = await stopped(recorder);
    const fader = attempt.events.filter((event) => event.control === "channelFader");

    expect(fader.length).toBeLessThanOrEqual(6);
    expect(fader[0]).toMatchObject({ ctx: 1, value: 0 });
    expect(fader.at(-1)).toMatchObject({ ctx: expect.closeTo(1.1, 9) as number, value: 1 });
    expect(fader.map((event) => event.ctx)).toEqual([...fader.map((event) => event.ctx)].sort((a, b) => a - b));
  });

  it("is bounded: past its capacity it stops and reports the attempt as unusable", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock, capacity: { controlEvents: 2, meterFrames: 10 } });
    recorder.start();
    for (const [index, control] of (["tap", "done", "tap"] as const).entries()) {
      engine.command({ control }, { device: "keyboard", eventTimeMs: 5_000 + 100 * index });
    }
    expect(await recorder.stop(details)).toEqual({ ok: false, error: { kind: "recorder-full", capacity: 2 } });
  });

  it("refuses to start twice, or to stop when idle", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1 });
    const recorder = new AttemptRecorder(engine, { wallClock });
    expect(await recorder.stop(details)).toEqual({ ok: false, error: { kind: "recorder-not-recording" } });
    recorder.start();
    expect(recorder.start()).toEqual({ ok: false, error: { kind: "recorder-already-recording" } });
  });

  it("records an interruption when the output stops running mid-attempt", async () => {
    let running = true;
    const flakyClock: OutputClock = {
      heardTime: () => (running ? { ok: true, ctx: 2 } : { ok: false, error: { kind: "output-not-running" } }),
    };
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: flakyClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    running = false;
    engine.command({ control: "tap" }, KEYBOARD);
    running = true;
    const attempt = await stopped(recorder);
    expect(attempt.interruptions).toEqual([{ ctx: 0, kind: "contextSuspended" }]);
  });

  it("lets the app report a hidden tab", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    engine.command({ control: "tap" }, { device: "keyboard", eventTimeMs: 5_100 });
    recorder.markTabHidden(5_500);
    const attempt = await stopped(recorder);
    expect(attempt.interruptions).toEqual([{ ctx: 1.5, kind: "tabHidden" }]);
  });

  it("refuses an attempt in which a deck changed track (v1: one track per deck)", async () => {
    const { context, engine } = await engineWithTrack({ seconds: 0.1 });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    await engine.load("A", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), { trackId: "track-b", grid });
    expect(await recorder.stop(details)).toEqual({ ok: false, error: { kind: "recorder-track-changed", deck: "A" } });
  });
});
