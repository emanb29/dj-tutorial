import { describe, expect, it } from "vitest";
import type { BeatGrid } from "./beat-grid.ts";
import { createAudioEngine } from "./engine.ts";
import { at, KEYBOARD, offlineContext, toneBuffer } from "./offline-test-support.ts";
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

async function engineWithTrack(options: { seconds: number; clock?: OutputClock; deckB?: boolean }) {
  const context = offlineContext(options.seconds);
  const engine = await createAudioEngine(options.clock === undefined ? { context } : { context, clock: options.clock });
  const tone = () => toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: options.seconds + 1 });
  await engine.load("A", tone(), { trackId: "track-a", grid });
  if (options.deckB === true) await engine.load("B", tone(), { trackId: "track-b", grid });
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
      { ctx: 1.25, control: "play", deck: "A", value: 1, appliedCtx: 0, inputDevice: "keyboard" },
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
      A: { channelFader: 1, trimDb: 0, eqHighDb: 0, eqMidDb: 0, eqLowDb: 0, filter: 0, cueMonitor: false },
      B: { channelFader: 0, trimDb: 0, eqHighDb: 0, eqMidDb: 0, eqLowDb: 0, filter: 0, cueMonitor: false },
      crossfader: 0.5,
      beatFx: { on: false, channel: "master", beats: 1, depth: 0.5 },
    });
    expect(attempt.initialDecks).toEqual({
      A: { tempo: 1, jogBend: 0, sync: false, masterTempo: false, hotCues: [null, null, null, null, null, null, null, null], loop: null },
      B: { tempo: 1, jogBend: 0, sync: false, masterTempo: false, hotCues: [null, null, null, null, null, null, null, null], loop: null },
    });
    expect(attempt.meters.fxReturn).toHaveLength(50);
  });

  it("records hot cues, loops and Beat FX as contract events with their pads, positions and lengths, and loop wraps in the playhead", async () => {
    const { context, engine } = await engineWithTrack({ seconds: 4, deckB: true });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    const press = (time: number, ...commands: Parameters<typeof engine.command>[0][]) =>
      at(context, time, () => {
        for (const command of commands) expect(engine.command(command, KEYBOARD)).toEqual({ ok: true });
      });
    engine.command({ control: "play", deck: "A" }, KEYBOARD);
    const times = [
      press(0.48, { control: "hot-cue-set", deck: "A", slot: 2 }, { control: "beat-fx-channel", value: "A" }, { control: "beat-fx-beats", value: 0.5 }),
      press(1.0, { control: "loop-auto", deck: "A", value: 4 }, { control: "beat-fx-depth", value: 0.8 }, { control: "beat-fx", value: true }),
      press(1.6, { control: "loop-halve", deck: "A" }, { control: "beat-fx-channel", value: "master" }),
      press(3.4, { control: "hot-cue", deck: "A", slot: 2 }, { control: "beat-fx", value: false }, { control: "hot-cue-clear", deck: "A", slot: 2 }),
    ];
    void at(context, 3.9, () => {
      engine.command({ control: "done" }, KEYBOARD);
    });
    const done = context.startRendering();
    const [setAt, loopAt, halveAt, triggerAt] = await Promise.all(times);
    await done;
    const attempt = await stopped(recorder);

    const performance = attempt.events.filter((event) => event.control !== "play" && event.control !== "done");
    const slot3 = expect.closeTo(setAt ?? Number.NaN, 9) as number;
    expect(performance).toEqual([
      { ctx: setAt, control: "hotCueSet", deck: "A", value: 3, pos: slot3, appliedCtx: setAt, inputDevice: "keyboard" },
      { ctx: setAt, control: "beatFxChannel", deck: "A", value: 1, appliedCtx: setAt, inputDevice: "keyboard" },
      { ctx: setAt, control: "beatFxBeats", value: 0.5, appliedCtx: setAt, inputDevice: "keyboard" },
      // 4 BEAT near 1.0 s at 120 BPM: beats 2–6, from 1 s to 3 s.
      { ctx: loopAt, control: "loopAuto", deck: "A", value: 2, pos: 1, appliedCtx: loopAt, inputDevice: "keyboard" },
      { ctx: loopAt, control: "beatFxDepth", value: 0.8, appliedCtx: loopAt, inputDevice: "keyboard" },
      { ctx: loopAt, control: "beatFx", value: 1, appliedCtx: loopAt, inputDevice: "keyboard" },
      { ctx: halveAt, control: "loopHalve", deck: "A", value: 1, pos: 1, appliedCtx: halveAt, inputDevice: "keyboard" },
      { ctx: halveAt, control: "beatFxChannel", value: 1, appliedCtx: halveAt, inputDevice: "keyboard" },
      { ctx: triggerAt, control: "hotCue", deck: "A", value: 3, pos: slot3, appliedCtx: triggerAt, inputDevice: "keyboard" },
      // The hot cue left the loop: the engine's own exit, where the jump took effect.
      { ctx: triggerAt, control: "loopExit", deck: "A", value: 1, appliedCtx: triggerAt, inputDevice: "engine", byEngine: true },
      { ctx: triggerAt, control: "beatFx", value: 0, appliedCtx: triggerAt, inputDevice: "keyboard" },
    ]);
    // The loop started at 1 s; the ½X loop (1–2 s, from 1.6 s) wrapped back to 1 s at 2 s and 3 s.
    const segments = attempt.decks.A?.playhead.segments ?? [];
    expect(segments.filter((segment) => segment.pos === 1 && segment.rate > 0).map((segment) => segment.fromCtx)).toEqual([
      expect.closeTo(1, 9),
      expect.closeTo(2, 9),
      expect.closeTo(3, 9),
    ]);
    expect(attempt.meters.fxReturn?.length).toBeGreaterThan(150);
  });

  it("records tempo as a rate ratio, jog bends, SYNC (with the engine's own drop), Master Tempo and the CFX filter", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock, deckB: true });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    const at = (eventTimeMs: number) => ({ device: "trackpad", eventTimeMs }) as const;
    engine.command({ control: "play", deck: "A" }, at(5_000));
    engine.command({ control: "tempo", deck: "A", value: 0.5 }, at(5_100));
    engine.command({ control: "tempo-range", deck: "A", value: 6 }, at(5_200));
    engine.command({ control: "jog-bend", deck: "A", value: 0.05 }, at(5_300));
    engine.command({ control: "jog-bend", deck: "A", value: 0 }, at(5_350));
    engine.command({ control: "filter", deck: "A", value: 0.8 }, at(5_400));
    engine.command({ control: "filter", deck: "A", value: 3 }, at(5_450)); // out of range: refused
    engine.command({ control: "sync", deck: "B", value: true }, at(5_500));
    engine.command({ control: "tempo", deck: "B", value: 0 }, at(5_550)); // locked by SYNC: refused
    engine.command({ control: "sync", deck: "A", value: true }, at(5_600)); // A follows now: the engine drops B's SYNC
    engine.command({ control: "master-tempo", deck: "A", value: true }, at(5_700));
    engine.command({ control: "jog-search", deck: "B", value: 1 }, at(5_800)); // in the playhead model only
    engine.command({ control: "headphone-level", value: 0.7 }, at(5_900)); // monitoring only
    const attempt = await stopped(recorder);
    const appliedOf = (control: string, deck: string, value?: unknown) =>
      attempt.engineEvents.find((event) => event.command.control === control && "deck" in event.command && event.command.deck === deck && (value === undefined || ("value" in event.command && event.command.value === value)))?.appliedCtx;

    const deckEvents = attempt.events.filter((event) => ["tempo", "jogBend", "filter", "sync", "masterTempo"].includes(event.control));
    expect(deckEvents).toEqual([
      // The engine's own change has no heard time: it sits where it took effect, which sorts it first on this shifted clock.
      { ctx: appliedOf("sync", "B", false), control: "sync", deck: "B", value: 0, appliedCtx: appliedOf("sync", "B", false), byEngine: true, inputDevice: "engine" },
      { ctx: expect.closeTo(1.1, 9) as number, control: "tempo", deck: "A", value: expect.closeTo(1.05, 12) as number, appliedCtx: appliedOf("tempo", "A"), inputDevice: "trackpad" },
      // A 6% range at the same fader position: the rate drops to 1.03.
      { ctx: expect.closeTo(1.2, 9) as number, control: "tempo", deck: "A", value: expect.closeTo(1.03, 12) as number, appliedCtx: appliedOf("tempo-range", "A"), inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.3, 9) as number, control: "jogBend", deck: "A", value: 0.05, appliedCtx: appliedOf("jog-bend", "A", 0.05), inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.35, 9) as number, control: "jogBend", deck: "A", value: 0, appliedCtx: appliedOf("jog-bend", "A", 0), inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.4, 9) as number, control: "filter", deck: "A", value: 0.8, appliedCtx: appliedOf("filter", "A", 0.8), inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.5, 9) as number, control: "sync", deck: "B", value: 1, appliedCtx: appliedOf("sync", "B", true), inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.6, 9) as number, control: "sync", deck: "A", value: 1, appliedCtx: appliedOf("sync", "A", true), inputDevice: "trackpad" },
      { ctx: expect.closeTo(1.7, 9) as number, control: "masterTempo", deck: "A", value: 1, appliedCtx: appliedOf("master-tempo", "A"), inputDevice: "trackpad" },
    ]);
    // Jog search and headphone level have no contract id; the engine's own event never counts toward the input device.
    expect(attempt.events.map((event) => event.control)).not.toContain("jogSearch");
    expect(attempt.events).toHaveLength(deckEvents.length + 1);
    expect(attempt.inputDevice).toBe("trackpad");
  });

  it("puts the filter and each deck's tempo, jog bend, SYNC and Master Tempo at the start into the initial snapshot", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, deckB: true });
    for (const command of [
      { control: "tempo", deck: "A", value: 0.5 },
      { control: "master-tempo", deck: "A", value: true },
      { control: "filter", deck: "B", value: -0.3 },
      { control: "sync", deck: "B", value: true },
    ] as const) {
      expect(engine.command(command, KEYBOARD)).toEqual({ ok: true });
    }
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    engine.command({ control: "done" }, KEYBOARD);
    const attempt = await stopped(recorder);

    expect(attempt.initialMixer.A.filter).toBe(0);
    expect(attempt.initialMixer.B.filter).toBe(-0.3);
    expect(attempt.initialDecks.A).toEqual({ tempo: expect.closeTo(1.05, 12) as number, jogBend: 0, sync: false, masterTempo: true, hotCues: [null, null, null, null, null, null, null, null], loop: null });
    // B follows A at the same grid BPM, so it plays at A's rate.
    expect(attempt.initialDecks.B).toEqual({ tempo: expect.closeTo(1.05, 12) as number, jogBend: 0, sync: true, masterTempo: false, hotCues: [null, null, null, null, null, null, null, null], loop: null });
    expect(attempt.events.map((event) => event.control)).toEqual(["done"]);
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

  it("coalesces refused moves too, without letting them hide the accepted ones", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    for (let step = 0; step <= 100; step++) {
      // EQ knobs are -1…1: every odd move is out of range and refused.
      engine.command({ control: "eq-low", deck: "A", value: step % 2 === 0 ? step / 100 : 5 }, { device: "trackpad", eventTimeMs: 5_000 + step });
    }
    const attempt = await stopped(recorder);
    const refused = attempt.engineEvents.filter((event) => event.rejected !== null);

    expect(refused.length).toBeLessThanOrEqual(6);
    expect(attempt.events.filter((event) => event.control === "eqLow").at(-1)).toMatchObject({ ctx: expect.closeTo(1.1, 9) as number });
  });

  it("sizes its budget from the attempt's expected duration, so a 15-minute final mix fits", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    expect(recorder.usage()).toBeNull();
    expect(recorder.start({ expectedDurationSec: 900 })).toEqual({ ok: true });

    // 900 s × 2 active controls × 30 moves/s × 2 headroom; meters: 4 buses × 50 frames/s × 900 s × 2.
    expect(recorder.usage()).toEqual({
      controlEvents: 0,
      controlEventBudget: 108_000,
      meterFrames: 0,
      meterFrameCapacity: 360_000,
      nearCapacity: false,
      degraded: false,
    });
  });

  it("refuses an expected duration that is not a positive number of seconds", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1 });
    const recorder = new AttemptRecorder(engine, { wallClock });
    expect(recorder.start({ expectedDurationSec: 0 })).toMatchObject({
      ok: false,
      error: { kind: "value-out-of-range", control: "expectedDurationSec", value: 0 },
    });
    expect(recorder.isRecording()).toBe(false);
  });

  it("warns once near capacity and then coalesces continuous moves harder, keeping every button press", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock, capacity: { controlEvents: 100, meterFrames: 10 } });
    const warnings: unknown[] = [];
    recorder.on("recorder-near-capacity", (warning) => warnings.push(warning));
    recorder.start();
    for (let press = 0; press < 80; press++) engine.command({ control: "tap" }, { device: "keyboard", eventTimeMs: 5_000 + press });
    expect(warnings).toEqual([{ kind: "recorder-near-capacity", controlEvents: 80, controlEventBudget: 100, coalesceHz: 7.5 }]);
    expect(recorder.usage()?.nearCapacity).toBe(true);

    // 25 moves a second: all kept at the usual 30 Hz, about one in four at 7.5 Hz.
    for (let step = 0; step <= 10; step++) {
      engine.command({ control: "crossfader", value: step / 10 }, { device: "trackpad", eventTimeMs: 5_100 + 40 * step });
    }
    engine.command({ control: "tap" }, { device: "keyboard", eventTimeMs: 5_600 });
    const attempt = await stopped(recorder);

    expect(warnings).toHaveLength(1);
    expect(attempt.events.filter((event) => event.control === "tap")).toHaveLength(81);
    const crossfader = attempt.events.filter((event) => event.control === "crossfader");
    expect(crossfader.length).toBeLessThanOrEqual(5);
    expect(crossfader.at(-1)).toMatchObject({ value: 1 });
    expect(attempt.degraded).toBe(false);
  });

  it("never loses an attempt at its ceiling: discrete events are all kept, continuous ones stop, and it is marked degraded", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock, capacity: { controlEvents: 4, meterFrames: 10 } });
    recorder.start();
    for (let step = 0; step < 8; step++) {
      // Moves 200 ms apart are never coalesced, so only the ceiling limits them.
      engine.command({ control: "crossfader", value: step / 8 }, { device: "trackpad", eventTimeMs: 5_000 + 200 * step });
      engine.command({ control: "tap" }, { device: "keyboard", eventTimeMs: 5_000 + 200 * step + 100 });
    }
    const attempt = await stopped(recorder);

    expect(attempt.degraded).toBe(true);
    expect(attempt.events.filter((event) => event.control === "tap")).toHaveLength(8);
    expect(attempt.events.filter((event) => event.control === "crossfader").length).toBeLessThanOrEqual(4);
  });

  it("keeps an attempt that outgrows its meter capacity, marked degraded", async () => {
    const { context, engine } = await engineWithTrack({ seconds: 1 });
    const recorder = new AttemptRecorder(engine, { wallClock, capacity: { controlEvents: 100, meterFrames: 30 } });
    recorder.start();
    engine.command({ control: "play", deck: "A" }, KEYBOARD);
    await context.startRendering();
    const attempt = await stopped(recorder);

    expect(attempt.degraded).toBe(true);
    expect(attempt.meters.master.length + (attempt.meters.A?.length ?? 0) + (attempt.meters.B?.length ?? 0) + (attempt.meters.fxReturn?.length ?? 0)).toBe(30);
  });

  it("is not degraded when it stays within its budget", async () => {
    const { engine } = await engineWithTrack({ seconds: 0.1, clock: shiftedClock });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    engine.command({ control: "tap" }, { device: "keyboard", eventTimeMs: 5_100 });
    expect((await stopped(recorder)).degraded).toBe(false);
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

  it("with track changes allowed, keeps every loaded track's grid and the last track's playhead per deck", async () => {
    const { context, engine } = await engineWithTrack({ seconds: 0.1 });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start({ allowTrackChanges: true });
    const otherGrid = { ...grid, firstBeat: 0.2 };
    await engine.load("A", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), { trackId: "track-b", grid: otherGrid });
    engine.command({ control: "seek", deck: "A", value: 0.5 }, KEYBOARD);
    engine.command({ control: "deck-cue", deck: "A", value: true }, KEYBOARD);
    const attempt = await stopped(recorder);
    expect(attempt.decks.A?.trackId).toBe("track-b");
    expect(Object.keys(attempt.grids).sort()).toEqual(["track-a", "track-b"].sort());
    expect(attempt.grids["track-b"]).toEqual(otherGrid);
    expect(attempt.cuePoints.map((cue) => [cue.trackId, cue.pos])).toEqual([["track-b", 0.5]]);
    // The track the deck held before, with its own playhead: stopped at the load that replaced it.
    expect(attempt.decks.A?.earlier?.map((track) => track.trackId)).toEqual(["track-a"]);
    const replacedAt = attempt.decks.A?.loadedCtx ?? Number.NaN;
    expect(attempt.decks.A?.earlier?.[0]?.loadedCtx).toBeLessThanOrEqual(replacedAt);
    expect(attempt.decks.A?.earlier?.[0]?.playhead.segments.at(-1)?.rate ?? 0).toBe(0);
  });

  it("refuses an attempt in which a deck changed track (v1: one track per deck)", async () => {
    const { context, engine } = await engineWithTrack({ seconds: 0.1 });
    const recorder = new AttemptRecorder(engine, { wallClock });
    recorder.start();
    await engine.load("A", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), { trackId: "track-b", grid });
    expect(await recorder.stop(details)).toEqual({ ok: false, error: { kind: "recorder-track-changed", deck: "A" } });
  });
});
