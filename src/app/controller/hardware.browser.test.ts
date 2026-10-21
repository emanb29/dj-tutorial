// The DDJ-FLX4 end to end in the engine: MIDI messages through the bridge and the controller session
// into a real engine rendering offline (never the speakers), recorded by the real recorder. The clock
// maps performance time to heard time with a fixed offset, as getOutputTimestamp() does, so the test
// can check a MIDI message is heard at its own timestamp, exactly as a key press would be.

import { describe, expect, it } from "vitest";
import { AttemptRecorder, createAudioEngine, SplitCueMonitor, type AudioEngine, type MonitorOutput, type OutputClock } from "@audio";
import { at, channelRmsDb, offlineContext, toneBuffer } from "@audio/offline-test-support.ts";
import type { MidiMessage } from "@midi";
import { ALL_CONTROL_IDS } from "./control-ids.ts";
import { HardwareBridge, type HardwarePort } from "./hardware.ts";
import { ControllerSession } from "./session.ts";

/** performance.now() of heard time 0 in this test. */
const ORIGIN_MS = 5000;
const LOOKAHEAD_S = 0.02;

function fixedOffsetClock(): OutputClock {
  return {
    heardTime: (performanceTimeMs) => ({ ok: true, ctx: ((performanceTimeMs ?? ORIGIN_MS) - ORIGIN_MS) / 1000 }),
  };
}

class Port implements HardwarePort {
  readonly connected = true;
  private listener: ((message: MidiMessage) => void) | null = null;
  onMessage(listener: (message: MidiMessage) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  subscribe() {
    return () => undefined;
  }
  send() {
    return true;
  }
  midi(bytes: number[], heardSec: number): void {
    this.listener?.({ data: new Uint8Array(bytes), timeStamp: ORIGIN_MS + heardSec * 1000 });
  }
}

async function rig(monitor?: MonitorOutput): Promise<{ context: OfflineAudioContext; engine: AudioEngine; port: Port; recorder: AttemptRecorder; session: ControllerSession }> {
  const context = offlineContext(3);
  const engine = await createAudioEngine({ context, masterTempo: false, lookaheadSec: LOOKAHEAD_S, clock: fixedOffsetClock(), ...(monitor === undefined ? {} : { monitor }) });
  const loaded = await engine.load("A", toneBuffer(context, { frequency: 220, peak: 0.25, seconds: 4 }), { trackId: "tone", grid: { bpm: 120, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 1 } });
  if (!loaded.ok) throw new Error(`loading failed: ${loaded.error.kind}`);
  const session = new ControllerSession(engine, { unlocks: new Set(ALL_CONTROL_IDS), macPlatform: true, schedule: () => () => undefined });
  session.connect();
  const port = new Port();
  new HardwareBridge(session, engine, port, { schedule: () => () => undefined }).attach();
  const recorder = new AttemptRecorder(engine);
  return { context, engine, port, recorder, session };
}

const fader = (value01: number): number[][] => {
  const raw = Math.round(value01 * 16383);
  return [
    [0xb0, 0x13, raw >> 7],
    [0xb0, 0x33, raw & 0x7f],
  ];
};

describe("the FLX4 through the session into a real engine", () => {
  it("records PLAY and a fader fade as midi input, heard at each message's own timestamp", async () => {
    const { context, port, recorder, engine } = await rig();
    expect(recorder.start()).toEqual({ ok: true });
    // The app's channel fader starts at 1: bring the hardware fader up to it first (pickup), as a Learner does.
    const steps = [
      at(context, 0.1, () => {
        for (const message of fader(1)) port.midi(message, 0.1);
      }),
      // The message arrived a little after it was sent; it is heard at its own timestamp, 0.2 s.
      at(context, 0.25, () => {
        port.midi([0x90, 0x0b, 0x7f], 0.2);
        port.midi([0x90, 0x0b, 0x00], 0.21);
      }),
      at(context, 1, () => {
        for (const message of fader(0.5)) port.midi(message, 1);
      }),
      at(context, 1.5, () => {
        for (const message of fader(0)) port.midi(message, 1.5);
      }),
    ];
    await context.startRendering();
    await Promise.all(steps);
    const stopped = await recorder.stop({ attemptId: "a", learnerId: "l", endReason: "done", abandoned: false, phraseMarkers: {}, answers: {} });
    if (!stopped.ok) throw new Error(`stop failed: ${stopped.error.kind}`);
    const { attempt } = stopped;
    const { engineEvents } = attempt;

    expect(attempt.inputDevice).toBe("midi");
    const play = attempt.events.find((event) => event.control === "play");
    expect(play?.ctx).toBeCloseTo(0.2, 9);
    // Applied a lookahead after it was heard, as for any input.
    expect(play?.appliedCtx).toBeGreaterThan(0.2);
    const faderEvents = attempt.events.filter((event) => event.control === "channelFader" && event.deck === "A");
    expect(faderEvents.map((event) => [Number(event.ctx.toFixed(6)), Number(event.value.toFixed(3))])).toEqual([
      [0.1, 1],
      [1, 0.5],
      [1.5, 0],
    ]);
    expect(engineEvents.filter((event) => event.device !== "engine").every((event) => event.device === "midi")).toBe(true);
    expect(engine.mixerState().channels.A["channel-fader"]).toBe(0);
  });

  it("HEADPHONES MIXING and LEVEL change the headphone ear at once, from wherever the knobs are", async () => {
    // Split cue: the left ear is the headphones, the right the master. Nothing is cued, so with MIXING
    // turned to MASTER the left ear is the master; LEVEL at 0.25 (about 9 o'clock) is 12 dB quieter.
    const { context, port, engine } = await rig(new SplitCueMonitor());
    const steps = [
      at(context, 0.1, () => {
        port.midi([0x90, 0x0b, 0x7f], 0.1);
        port.midi([0x90, 0x0b, 0x00], 0.11);
      }),
      at(context, 0.3, () => {
        // AlphaTheta's list: HEADPHONE MIX B6 0C / 2C, HEADPHONE LEVEL B6 0D / 2D (MSB, then LSB).
        port.midi([0xb6, 0x0c, 0x7f], 0.3);
        port.midi([0xb6, 0x2c, 0x7f], 0.3);
        port.midi([0xb6, 0x0d, 0x20], 0.3);
        port.midi([0xb6, 0x2d, 0x00], 0.3);
      }),
    ];
    const rendered = await context.startRendering();
    await Promise.all(steps);
    expect(engine.mixerState().cueMix).toBeCloseTo(1, 3);
    expect(engine.mixerState().headphoneLevel).toBeCloseTo(0.25, 3);
    const masterDb = channelRmsDb(rendered, 1, 1, 2.5);
    expect(masterDb).toBeGreaterThan(-30);
    expect(channelRmsDb(rendered, 0, 1, 2.5)).toBeCloseTo(masterDb - 12.04, 0);
  });

  it("CUE/LOOP CALL ◀ halves the loop and ▶ doubles it; SHIFT + LOOP IN (IN ADJ) changes nothing", async () => {
    const { context, port, recorder, session, engine } = await rig();
    expect(recorder.start()).toEqual({ ok: true });
    const steps = [
      at(context, 0.1, () => {
        port.midi([0x90, 0x0b, 0x7f], 0.1);
      }),
      // 4 BEAT: a 2 s loop at 120 BPM.
      at(context, 0.5, () => {
        port.midi([0x90, 0x4d, 0x7f], 0.5);
      }),
      at(context, 0.8, () => {
        port.midi([0x90, 0x51, 0x7f], 0.8);
        port.midi([0x90, 0x51, 0x00], 0.81);
      }),
      at(context, 1.1, () => {
        port.midi([0x90, 0x53, 0x7f], 1.1);
      }),
      at(context, 1.4, () => {
        port.midi([0x90, 0x3f, 0x7f], 1.4);
        port.midi([0x90, 0x4c, 0x7f], 1.41);
        port.midi([0x90, 0x3f, 0x00], 1.42);
      }),
    ];
    await context.startRendering();
    await Promise.all(steps);
    const stopped = await recorder.stop({ attemptId: "a", learnerId: "l", endReason: "done", abandoned: false, phraseMarkers: {}, answers: {} });
    if (!stopped.ok) throw new Error(`stop failed: ${stopped.error.kind}`);
    const loopEvents = stopped.attempt.events.filter((event) => event.control.startsWith("loop"));
    expect(loopEvents.map((event) => [event.control, Number(event.ctx.toFixed(6)), Number(event.value.toFixed(6))])).toEqual([
      ["loopAuto", 0.5, 2],
      ["loopHalve", 0.8, 1],
      ["loopDouble", 1.1, 2],
    ]);
    expect(engine.deckState("A").loop).not.toBeNull();
    expect(session.snapshot().notYet).toBe("A.loop-in");
  });

  it("places a MIDI press on the heard timeline exactly where a key press with the same timestamp goes", async () => {
    const { context, port, recorder, session } = await rig();
    expect(recorder.start()).toEqual({ ok: true });
    const steps = [
      at(context, 0.5, () => {
        port.midi([0x94, 0x6b, 0x7f], 0.4321);
        session.keyDown({ code: "Space", repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: ORIGIN_MS + 432.1 });
      }),
    ];
    await context.startRendering();
    await Promise.all(steps);
    const stopped = await recorder.stop({ attemptId: "a", learnerId: "l", endReason: "done", abandoned: false, phraseMarkers: {}, answers: {} });
    if (!stopped.ok) throw new Error(`stop failed: ${stopped.error.kind}`);
    const taps = stopped.attempt.engineEvents.filter((event) => event.command.control === "tap");
    expect(taps.map((event) => event.device)).toEqual(["midi", "keyboard"]);
    expect(taps[0]?.heardCtx).toBeCloseTo(0.4321, 9);
    expect(taps[0]?.heardCtx).toBe(taps[1]?.heardCtx);
  });
});
