// Routing of the four-channel and two-device monitors, rendered offline (never the speakers). The second
// device is faked by a node in the same offline context, routed to channels 2/3 (its headphones) and,
// for PC MASTER OUT, 4/5 (its master), so the test can hear both "devices" in one render.

import { describe, expect, it } from "vitest";
import { createAudioEngine } from "./engine.ts";
import { ControllerCueMonitor, routeToControllerOutputs, routeToControllerPhones, TwoDeviceMonitor, type SecondDeviceSink } from "./device-monitors.ts";
import { channelRmsDb, onsetSec, SAMPLE_RATE } from "./offline-test-support.ts";
import type { MonitorOutput } from "./monitor.ts";
import { CONTEXT_HOP_SEC } from "./output.ts";

const SILENT_DB = -100;

/** A master bus with a tone on the left only, and a cue bus with a tone on the right only, from `fromSec`. */
function buses(context: OfflineAudioContext, fromSec = 0) {
  const master = new GainNode(context, { channelCount: 2, channelCountMode: "explicit" });
  const cue = new GainNode(context, { channelCount: 2, channelCountMode: "explicit" });
  const feed = (target: AudioNode, channel: 0 | 1, frequency: number) => {
    const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
    const tone = new OscillatorNode(context, { frequency });
    const level = new GainNode(context, { gain: 0.25 });
    tone.connect(level).connect(merger, 0, channel);
    merger.connect(target);
    tone.start(fromSec);
  };
  feed(master, 0, 440);
  feed(cue, 1, 660);
  return { context, master, cue };
}

describe("ControllerCueMonitor (the FLX4's four outputs)", () => {
  it("puts the master on outputs 1/2 and the cue on 3/4", async () => {
    const context = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    expect(ControllerCueMonitor.fits(context)).toBe(true);
    const monitor = new ControllerCueMonitor();
    monitor.attach(buses(context));
    monitor.setCueMix(0);
    const rendered = await context.startRendering();
    expect(channelRmsDb(rendered, 0, 0.1, 0.9)).toBeGreaterThan(-20);
    expect(channelRmsDb(rendered, 1, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(rendered, 2, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(rendered, 3, 0.1, 0.9)).toBeGreaterThan(-20);
  });

  it("mixes the master into the headphones with MIXING, and leaves LEVEL to the FLX4's own headphone amp", async () => {
    const context = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    const monitor: MonitorOutput = new ControllerCueMonitor();
    monitor.attach(buses(context));
    monitor.setCueMix(1);
    monitor.setHeadphoneGain(0.5);
    const rendered = await context.startRendering();
    // Master only in the headphones now, at the master's level: the FLX4 turns its PHONES jack down
    // itself, so the app scaling 3/4 too would apply LEVEL twice.
    expect(channelRmsDb(rendered, 2, 0.1, 0.9)).toBeCloseTo(channelRmsDb(rendered, 0, 0.1, 0.9), 1);
    expect(channelRmsDb(rendered, 3, 0.1, 0.9)).toBeLessThan(SILENT_DB);
  });

  it("does not fit a two-channel device", () => {
    expect(ControllerCueMonitor.fits(new OfflineAudioContext(2, 128, SAMPLE_RATE))).toBe(false);
  });
});

/**
 * The second device: channels 2/3 of the offline render are its headphones, with a set latency; with
 * `carriesMaster` (PC MASTER OUT), channels 4/5 are its master outputs. `levelOnDevice`: its own amp
 * applies HEADPHONES LEVEL (the FLX4's jack).
 */
function fakeHeadphones(context: OfflineAudioContext, latencySec: number, shape: { readonly levelOnDevice?: boolean; readonly carriesMaster?: boolean } = {}): SecondDeviceSink & { closed: boolean } {
  const { levelOnDevice = false, carriesMaster = false } = shape;
  const merger = new ChannelMergerNode(context, { numberOfInputs: carriesMaster ? 6 : 4 });
  merger.connect(context.destination);
  const pair = (from: number) => {
    const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    split.connect(merger, 0, from);
    split.connect(merger, 1, from + 1);
    return split;
  };
  const sink = {
    closed: false,
    levelOnDevice,
    carriesMaster,
    open() {
      return { headphones: pair(2), master: carriesMaster ? pair(4) : null };
    },
    latencySec: () => latencySec,
    close() {
      sink.closed = true;
    },
  };
  return sink;
}

/** One channel of a render, as a mono buffer, for onsetSec. */
function channelOf(rendered: AudioBuffer, index: number): AudioBuffer {
  const only = new AudioBuffer({ length: rendered.length, numberOfChannels: 1, sampleRate: SAMPLE_RATE });
  only.copyToChannel(rendered.getChannelData(index), 0);
  return only;
}

describe("TwoDeviceMonitor (speakers and headphones)", () => {
  it("delays the master by how much later the headphones are, and says so for the clock", async () => {
    const context = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    context.destination.channelCount = 4;
    context.destination.channelInterpretation = "discrete";
    const headphones = fakeHeadphones(context, 0.1);
    const monitor = new TwoDeviceMonitor(headphones, 0, () => 0.01);
    const { master, cue } = buses(context, 0.2);
    monitor.attach({ context, master, cue });
    monitor.setCueMix(0);
    const expected = 0.1 + CONTEXT_HOP_SEC - 0.01;
    expect(monitor.masterDelaySec()).toBeCloseTo(expected, 9);
    expect(monitor.cueDelaySec()).toBe(0);
    const rendered = await context.startRendering();
    const channel = (index: number) => {
      const only = new AudioBuffer({ length: rendered.length, numberOfChannels: 1, sampleRate: SAMPLE_RATE });
      only.copyToChannel(rendered.getChannelData(index), 0);
      return only;
    };
    expect(onsetSec(channel(0))).toBeCloseTo(0.2 + expected, 2);
    expect(onsetSec(channel(3))).toBeCloseTo(0.2, 2);
  });

  it("delays the headphones instead when the speakers are later, and takes the Learner's offset", () => {
    const context = new OfflineAudioContext(2, 128, SAMPLE_RATE);
    const monitor = new TwoDeviceMonitor(fakeHeadphones(context, 0), 0, () => 0.2);
    monitor.attach({ context, master: new GainNode(context), cue: new GainNode(context) });
    expect(monitor.masterDelaySec()).toBe(0);
    expect(monitor.cueDelaySec()).toBeCloseTo(0.2 - CONTEXT_HOP_SEC, 9);
    monitor.setHeadphoneOffset(50);
    expect(monitor.cueDelaySec()).toBeCloseTo(0.2 - CONTEXT_HOP_SEC - 0.05, 9);
  });

  it("scales the headphones by LEVEL on a plain headphone device, and not on the FLX4's jack (its own amp does)", async () => {
    const render = async (levelOnDevice: boolean) => {
      const context = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
      context.destination.channelCount = 4;
      context.destination.channelInterpretation = "discrete";
      const monitor = new TwoDeviceMonitor(fakeHeadphones(context, 0, { levelOnDevice }), 0, () => 0);
      monitor.attach(buses(context));
      monitor.setCueMix(0);
      monitor.setHeadphoneGain(0.5);
      const rendered = await context.startRendering();
      return channelRmsDb(rendered, 3, 0.1, 0.9);
    };
    const device = await render(false);
    const flx4 = await render(true);
    expect(device).toBeCloseTo(flx4 - 6.02, 0);
    expect(flx4).toBeGreaterThan(-20);
  });

  it("closes the headphone device when detached", () => {
    const context = new OfflineAudioContext(2, 128, SAMPLE_RATE);
    const headphones = fakeHeadphones(context, 0);
    const monitor = new TwoDeviceMonitor(headphones, 0, () => 0);
    monitor.attach({ context, master: new GainNode(context), cue: new GainNode(context) });
    monitor.detach();
    expect(headphones.closed).toBe(true);
  });
});

describe("speakers on this computer, headphones on the FLX4 (TwoDeviceMonitor into routeToControllerPhones)", () => {
  /** Channels `from` and `from + 1` of a render, as a stereo buffer: what crossed to the second device. */
  function stereoOf(rendered: AudioBuffer, from: number): AudioBuffer {
    const pair = new AudioBuffer({ length: rendered.length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
    pair.copyToChannel(rendered.getChannelData(from), 0);
    pair.copyToChannel(rendered.getChannelData(from + 1), 1);
    return pair;
  }

  it("puts a stereo headphone signal on the FLX4's 3/4 and silence on its MASTER OUT (1/2)", async () => {
    const flx4 = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    const tone = new OscillatorNode(flx4, { frequency: 660 });
    const level = new GainNode(flx4, { gain: 0.25, channelCount: 2, channelCountMode: "explicit" });
    tone.connect(level);
    routeToControllerPhones(level, flx4);
    tone.start();
    const rendered = await flx4.startRendering();
    expect(channelRmsDb(rendered, 0, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(rendered, 1, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(rendered, 2, 0.1, 0.9)).toBeGreaterThan(-20);
    expect(channelRmsDb(rendered, 3, 0.1, 0.9)).toBeGreaterThan(-20);
  });

  it("gives the master context the master only, and the FLX4's context the cue on 3/4 only", async () => {
    // The engine's context: channels 0/1 are the computer's speakers; 2/3 catch what the stream carries
    // to the FLX4 (fakeHeadphones), which a second render then plays into the FLX4's own context.
    const engine = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    engine.destination.channelCount = 4;
    engine.destination.channelInterpretation = "discrete";
    const monitor = new TwoDeviceMonitor(fakeHeadphones(engine, 0), 0, () => 0);
    monitor.attach(buses(engine));
    monitor.setCueMix(0);
    const speakers = await engine.startRendering();
    // The master (left tone) on the speakers; the cue (right tone) never reaches them.
    expect(channelRmsDb(speakers, 0, 0.1, 0.9)).toBeGreaterThan(-20);
    expect(channelRmsDb(speakers, 1, 0.1, 0.9)).toBeLessThan(SILENT_DB);

    const flx4 = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    const stream = new AudioBufferSourceNode(flx4, { buffer: stereoOf(speakers, 2) });
    routeToControllerPhones(stream, flx4);
    stream.start();
    const phones = await flx4.startRendering();
    // Nothing on the FLX4's MASTER OUT.
    expect(channelRmsDb(phones, 0, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(phones, 1, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    // The cue (right) in the headphones' right ear; no master (left) in them at MIXING 0.
    expect(channelRmsDb(phones, 2, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(phones, 3, 0.1, 0.9)).toBeGreaterThan(-20);
  });
});

describe("PC MASTER OUT: the master on this computer and on the FLX4's MASTER OUT, the cue in the FLX4's headphones", () => {
  function sixChannels(): OfflineAudioContext {
    const context = new OfflineAudioContext(6, SAMPLE_RATE, SAMPLE_RATE);
    context.destination.channelCount = 6;
    context.destination.channelInterpretation = "discrete";
    return context;
  }

  it("puts the master on the FLX4's 1/2 and the headphone signal on its 3/4", async () => {
    const flx4 = new OfflineAudioContext(4, SAMPLE_RATE, SAMPLE_RATE);
    const { master, cue } = buses(flx4);
    routeToControllerOutputs(flx4, { headphones: cue, master });
    const rendered = await flx4.startRendering();
    // Master (a left-only tone) on MASTER OUT left; the headphone signal (a right-only tone) on the jack's right.
    expect(channelRmsDb(rendered, 0, 0.1, 0.9)).toBeGreaterThan(-20);
    expect(channelRmsDb(rendered, 1, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(rendered, 2, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    expect(channelRmsDb(rendered, 3, 0.1, 0.9)).toBeGreaterThan(-20);
  });

  it("sends the master to both devices and the cue to the FLX4 only, and delays the computer when the FLX4 is later", async () => {
    const context = sixChannels();
    const flx4 = fakeHeadphones(context, 0.1, { carriesMaster: true, levelOnDevice: true });
    const monitor = new TwoDeviceMonitor(flx4, 0, () => 0.01);
    expect(monitor.secondDevicePlaysMaster).toBe(true);
    monitor.attach(buses(context, 0.2));
    monitor.setCueMix(0);
    const expected = 0.1 + CONTEXT_HOP_SEC - 0.01;
    expect(monitor.masterDelaySec()).toBeCloseTo(expected, 9);
    expect(monitor.cueDelaySec()).toBe(0);
    const rendered = await context.startRendering();
    // This computer: the master, delayed; never the cue.
    expect(onsetSec(channelOf(rendered, 0))).toBeCloseTo(0.2 + expected, 2);
    expect(channelRmsDb(rendered, 1, 0.1, 0.9)).toBeLessThan(SILENT_DB);
    // The FLX4: its MASTER OUT (4) and its headphones (3, the cue) together, undelayed.
    expect(onsetSec(channelOf(rendered, 4))).toBeCloseTo(0.2, 2);
    expect(onsetSec(channelOf(rendered, 3))).toBeCloseTo(0.2, 2);
    expect(channelRmsDb(rendered, 5, 0.1, 0.9)).toBeLessThan(SILENT_DB);
  });

  it("delays the FLX4's master and headphones together when this computer is later, and takes the Learner's offset", async () => {
    const context = sixChannels();
    const monitor = new TwoDeviceMonitor(fakeHeadphones(context, 0, { carriesMaster: true, levelOnDevice: true }), 0, () => 0.2);
    monitor.attach(buses(context, 0.1));
    monitor.setCueMix(0);
    const flx4Delay = 0.2 - CONTEXT_HOP_SEC;
    expect(monitor.masterDelaySec()).toBe(0);
    expect(monitor.cueDelaySec()).toBeCloseTo(flx4Delay, 9);
    const rendered = await context.startRendering();
    expect(onsetSec(channelOf(rendered, 0))).toBeCloseTo(0.1, 2);
    expect(onsetSec(channelOf(rendered, 4))).toBeCloseTo(0.1 + flx4Delay, 2);
    expect(onsetSec(channelOf(rendered, 3))).toBeCloseTo(0.1 + flx4Delay, 2);
    monitor.setHeadphoneOffset(50);
    expect(monitor.cueDelaySec()).toBeCloseTo(flx4Delay - 0.05, 9);
  });

  it("closes the FLX4's context when detached", () => {
    const context = new OfflineAudioContext(2, 128, SAMPLE_RATE);
    const flx4 = fakeHeadphones(context, 0, { carriesMaster: true, levelOnDevice: true });
    const monitor = new TwoDeviceMonitor(flx4, 0, () => 0);
    monitor.attach({ context, master: new GainNode(context), cue: new GainNode(context) });
    monitor.detach();
    expect(flx4.closed).toBe(true);
  });
});

describe("the engine's clock with two devices", () => {
  it("hears the master later by its line-up delay, so grading stays on the master device's clock", async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const monitor = new TwoDeviceMonitor(fakeHeadphones(context, 0.15), 0, () => 0.01);
    const engine = await createAudioEngine({ context, monitor, masterTempo: false, clock: { heardTime: (ms) => ({ ok: true, ctx: (ms ?? 0) / 1000 }) } });
    const heard = engine.heardTime(2000);
    expect(heard.ok && heard.ctx).toBeCloseTo(2 - monitor.masterDelaySec(), 9);
    expect(monitor.masterDelaySec()).toBeGreaterThan(0.1);
    await engine.close();
  });

  // PC MASTER OUT: the engine's context is this computer's speakers, so heard time is read from their
  // output timestamp. Lined up, the FLX4 sounds at that same moment, so either output is "heard".
  it("PC MASTER OUT, FLX4 later: heard time is this computer's output timestamp minus its line-up delay", async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const monitor = new TwoDeviceMonitor(fakeHeadphones(context, 0.12, { carriesMaster: true, levelOnDevice: true }), 0, () => 0.01);
    const engine = await createAudioEngine({ context, monitor, masterTempo: false, clock: { heardTime: (ms) => ({ ok: true, ctx: (ms ?? 0) / 1000 }) } });
    const heard = engine.heardTime(2000);
    expect(heard.ok && heard.ctx).toBeCloseTo(2 - (0.12 + CONTEXT_HOP_SEC - 0.01), 9);
    await engine.close();
  });

  it("PC MASTER OUT, this computer later: the FLX4 is delayed instead and heard time is this computer's timestamp as it is", async () => {
    const context = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const monitor = new TwoDeviceMonitor(fakeHeadphones(context, 0, { carriesMaster: true, levelOnDevice: true }), 0, () => 0.2);
    const engine = await createAudioEngine({ context, monitor, masterTempo: false, clock: { heardTime: (ms) => ({ ok: true, ctx: (ms ?? 0) / 1000 }) } });
    const heard = engine.heardTime(2000);
    expect(heard.ok && heard.ctx).toBeCloseTo(2, 9);
    expect(monitor.cueDelaySec()).toBeGreaterThan(0.1);
    await engine.close();
  });
});
