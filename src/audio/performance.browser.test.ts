import { describe, expect, it } from "vitest";
import type { BeatGrid } from "./beat-grid.ts";
import { ECHO_FEEDBACK } from "./beat-fx.ts";
import { createAudioEngine, type CommandEvent } from "./engine.ts";
import type { BusMeterFrame } from "./meter.ts";
import { at, clickBuffer, expectOk, KEYBOARD, offlineContext, peakSec, SAMPLE_RATE, send, toneBuffer } from "./offline-test-support.ts";

// Hot cues, loops and Beat FX ECHO (Lessons 17–19), rendered offline at 48 kHz, never through speakers.
// An offline render has no output latency and no lookahead here, so heard time = applied time = render time.

const grid = (bpm: number): BeatGrid => ({ bpm, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 1 });

async function engineWith(buffer: (context: OfflineAudioContext) => AudioBuffer, seconds: number, trackGrid: BeatGrid | null = grid(120)) {
  const context = offlineContext(seconds);
  const engine = await createAudioEngine({ context, lookaheadSec: 0, masterTempo: false });
  const loaded = await engine.load("A", buffer(context), { trackId: "t", grid: trackGrid });
  if (!loaded.ok) throw new Error(loaded.error.kind);
  const commands: CommandEvent[] = [];
  engine.on("command", (event) => commands.push(event));
  return { context, engine, commands };
}

/** The first sample louder than 1e-3 at or after `from` s. */
function onsetAfter(rendered: AudioBuffer, from: number): number {
  const data = rendered.getChannelData(0);
  const start = Math.round(from * SAMPLE_RATE);
  return (start + data.subarray(start).findIndex((sample) => Math.abs(sample) > 1e-3)) / SAMPLE_RATE;
}

/** Peak sample magnitude in [from, to) s. */
function peakIn(rendered: AudioBuffer, from: number, to: number): number {
  const data = rendered.getChannelData(0).subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
  return data.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0);
}

describe("hot cues", () => {
  it("sets a pad at the heard position while playing, and a trigger jumps there and plays on at once", async () => {
    const { context, engine } = await engineWith((c) => clickBuffer(c, 4, [0.25, 1.25]), 2);
    send(engine, { control: "play", deck: "A" });
    const setAt = at(context, 0.25, () => {
      send(engine, { control: "hot-cue-set", deck: "A", slot: 0 });
    });
    const triggeredAt = at(context, 0.8, () => {
      send(engine, { control: "hot-cue", deck: "A", slot: 0 });
    });
    const rendered = await context.startRendering();
    const trigger = await triggeredAt;
    // An offline render suspends on a render quantum: the press lands just after 0.25 s.
    const set = await setAt;

    expect(engine.deckState("A").hotCues[0]).toBeCloseTo(set, 9);
    expect(engine.playheadAt("A", trigger + 0.1)?.positionSec).toBeCloseTo(set + 0.1, 9);
    // The hot cue sits just after the click at 0.25 s, so the next sound is the click at 1.25 s, on time.
    const expected = trigger + (1.25 - set);
    expect(Math.abs(onsetAfter(rendered, trigger + 0.01) - expected)).toBeLessThan(2 / SAMPLE_RATE);
  });

  it("places a press heard before the latest seek at the new position, not the one it replaced", async () => {
    // Heard time runs 0.2 s behind render time (an output latency): a press 50 ms after a seek is heard
    // before the seek reached the output, yet the Learner pressed after it.
    const context = offlineContext(1);
    const engine = await createAudioEngine({ context, lookaheadSec: 0, masterTempo: false, clock: { heardTime: () => ({ ok: true, ctx: context.currentTime - 0.2 }) } });
    await engine.load("A", toneBuffer(context, { frequency: 440, peak: 0.5, seconds: 8 }), { trackId: "t", grid: grid(120) });
    send(engine, { control: "play", deck: "A" });
    const seekedAt = at(context, 0.5, () => {
      send(engine, { control: "seek", deck: "A", value: 4 });
    });
    void at(context, 0.55, () => {
      send(engine, { control: "hot-cue-set", deck: "A", slot: 0 }, { control: "loop-auto", deck: "A", value: 4 });
    });
    await context.startRendering();
    const seek = await seekedAt;

    expect(engine.deckState("A").hotCues[0]).toBeCloseTo(4, 9);
    // 4 BEAT from the beat nearest 4 s, not from the start of the track.
    expect(engine.deckState("A").loop).toEqual({ start: 4, end: 6 });
    expect(seek).toBeCloseTo(0.5, 2);
  });

  it("starts a paused deck from the pad, and refuses an empty pad", async () => {
    const { context, engine } = await engineWith((c) => toneBuffer(c, { frequency: 440, peak: 0.5, seconds: 4 }), 1);
    expectOk(engine.command({ control: "hot-cue-set", deck: "A", slot: 3, pos: 2 }, KEYBOARD));
    expect(engine.command({ control: "hot-cue", deck: "A", slot: 1 }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "hot-cue-empty", slot: 1 } });
    send(engine, { control: "hot-cue", deck: "A", slot: 3 });
    await context.startRendering();
    expect(engine.deckState("A").playing).toBe(true);
    expect(engine.playheadAt("A", 0.5)?.positionSec).toBeCloseTo(2.5, 9);
  });

  it("empties a pad on clear and every pad on a new load", async () => {
    const { context, engine } = await engineWith((c) => toneBuffer(c, { frequency: 440, peak: 0.5, seconds: 4 }), 0.2);
    send(engine, { control: "hot-cue-set", deck: "A", slot: 0, pos: 1 }, { control: "hot-cue-set", deck: "A", slot: 7, pos: 2 }, { control: "hot-cue-clear", deck: "A", slot: 0 });
    expect(engine.deckState("A").hotCues).toEqual([null, null, null, null, null, null, null, 2]);
    await engine.load("A", toneBuffer(context, { frequency: 440, peak: 0.5, seconds: 4 }), { trackId: "u", grid: null });
    expect(engine.deckState("A").hotCues.every((pos) => pos === null)).toBe(true);
  });
});

describe("loops", () => {
  it("loops 4 BEAT from the grid beat nearest the press, sample-accurately, where the model says", async () => {
    // 120 BPM: a beat is 0.5 s. A click on every beat's downbeat bar start (0, 2, 4 …) and one at 0.1 s.
    const { context, engine } = await engineWith((c) => clickBuffer(c, 8, [0.1, 2.1]), 6);
    send(engine, { control: "play", deck: "A" });
    // Pressed 40 ms early for beat 0 … pressed at 0.0 is impossible, so press near beat 1 (0.5 s).
    const pressedAt = at(context, 0.46, () => {
      send(engine, { control: "loop-auto", deck: "A", value: 4 });
    });
    const rendered = await context.startRendering();
    await pressedAt;

    expect(engine.deckState("A").loop).toEqual({ start: 0.5, end: 2.5 });
    // The click at 2.1 is in the loop: heard at 2.1, then every 2 s.
    for (const heard of [2.1, 4.1]) expect(Math.abs(onsetAfter(rendered, heard - 0.05) - heard)).toBeLessThan(2 / SAMPLE_RATE);
    expect(engine.playheadAt("A", 4.1)?.positionSec).toBeCloseTo(2.1, 9);
    // The click at 0.1 is before the loop: never heard again.
    expect(peakIn(rendered, 2.55, 2.65)).toBeLessThan(1e-3);
  });

  it("wraps without a click: the seam is as smooth as the tone itself", async () => {
    // A 441 Hz tone and a 0.3 s loop that is no whole number of periods: an unfaded seam would jump.
    const frequency = 441;
    const { context, engine } = await engineWith((c) => toneBuffer(c, { frequency, peak: 0.5, seconds: 4 }), 2, null);
    send(engine, { control: "play", deck: "A" });
    void at(context, 0.1, () => {
      send(engine, { control: "loop-in", deck: "A" });
    });
    void at(context, 0.40123, () => {
      send(engine, { control: "loop-out", deck: "A" });
    });
    const rendered = await context.startRendering();

    const data = rendered.getChannelData(0);
    const steepest = data.slice(1).reduce((most, sample, index) => Math.max(most, Math.abs(sample - (data[index] ?? 0))), 0);
    const toneSlope = (2 * Math.PI * frequency * 0.5) / SAMPLE_RATE;
    expect(steepest).toBeLessThan(toneSlope * 1.5);
    // And it really looped: the deck is still within the loop at the end.
    expect(engine.playheadAt("A", 1.9)?.positionSec).toBeLessThan(0.41);
  });

  it("LOOP OUT heard before it applies jumps back to where a wrap would be, and EXIT plays straight on", async () => {
    const { context, engine } = await engineWith((c) => toneBuffer(c, { frequency: 440, peak: 0.5, seconds: 8 }), 3);
    send(engine, { control: "play", deck: "A" }, { control: "loop-in", deck: "A" });
    const outAt = at(context, 1, () => {
      send(engine, { control: "loop-out", deck: "A" });
    });
    const exitAt = at(context, 2.25, () => {
      send(engine, { control: "loop-exit", deck: "A" });
    });
    await context.startRendering();
    await outAt;
    const exit = await exitAt;

    expect(engine.playheadAt("A", 1.5)?.positionSec).toBeCloseTo(0.5, 2);
    expect(engine.deckState("A").loop).toBeNull();
    const atExit = engine.playheadAt("A", exit)?.positionSec ?? Number.NaN;
    expect(engine.playheadAt("A", exit + 0.5)?.positionSec).toBeCloseTo(atExit + 0.5, 9);
  });

  it("2X and ½X move the loop's end; a seek ends the loop and is recorded as the engine's own exit", async () => {
    const { context, engine, commands } = await engineWith((c) => toneBuffer(c, { frequency: 440, peak: 0.5, seconds: 8 }), 0.5);
    send(engine, { control: "play", deck: "A" }, { control: "loop-auto", deck: "A", value: 4 });
    send(engine, { control: "loop-double", deck: "A" });
    expect(engine.deckState("A").loop).toEqual({ start: 0, end: 4 });
    send(engine, { control: "loop-halve", deck: "A" }, { control: "loop-halve", deck: "A" });
    expect(engine.deckState("A").loop).toEqual({ start: 0, end: 1 });
    send(engine, { control: "seek", deck: "A", value: 5 });
    await context.startRendering();

    expect(engine.deckState("A").loop).toBeNull();
    expect(commands.at(-1)).toMatchObject({ command: { control: "loop-exit", deck: "A" }, device: "engine", rejected: null });
  });

  it("loops with Master Tempo on too: the stretcher wraps within a render quantum of the model", async () => {
    // Scheduled before the render: stretch messages sent while an offline context is suspended do not land.
    const context = offlineContext(3);
    const engine = await createAudioEngine({ context });
    await engine.load("A", clickBuffer(context, 6, [0.6]), { trackId: "t", grid: grid(120) });
    send(engine, { control: "master-tempo", deck: "A", value: true }, { control: "play", deck: "A" }, { control: "loop-auto", deck: "A", value: 2 });
    await engine.settled();
    const rendered = await context.startRendering();

    const start = engine.trackHistory("A").at(-1)?.playhead.segments().find((segment) => segment.rate > 0)?.fromCtx ?? Number.NaN;
    expect(engine.deckState("A").loop).toEqual({ start: 0, end: 1 });
    // The click at 0.6 s is heard on each 1 s pass; the stretcher's STFT smears it over a few ms.
    for (const pass of [0, 1]) {
      const expected = start + 0.6 + pass;
      expect(Math.abs(peakSec(rendered, expected, 0.03) - expected)).toBeLessThan(0.004);
    }
  });

  it("refuses LOOP OUT without LOOP IN, 4 BEAT without a grid, and EXIT without a loop", async () => {
    const { engine } = await engineWith((c) => toneBuffer(c, { frequency: 440, peak: 0.5, seconds: 4 }), 0.1, null);
    expect(engine.command({ control: "loop-out", deck: "A" }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "loop-in-missing" } });
    expect(engine.command({ control: "loop-auto", deck: "A", value: 4 }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "no-beat-grid" } });
    expect(engine.command({ control: "loop-exit", deck: "A" }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "no-loop" } });
  });
});

describe("Beat FX ECHO", () => {
  async function echoOf(options: { closeFaderAt?: number; offAt?: number; channel?: "A" | "B" | "master" }) {
    // One click at 0.05 s; 120 BPM, a 1-beat echo: repeats every 0.5 s.
    const { context, engine } = await engineWith((c) => clickBuffer(c, 4, [0.05]), 3);
    const frames: BusMeterFrame[] = [];
    engine.on("meter", (frame) => {
      if (frame.bus === "fx") frames.push(frame);
    });
    send(
      engine,
      { control: "beat-fx-channel", value: options.channel ?? "A" },
      { control: "beat-fx-beats", value: 1 },
      { control: "beat-fx-depth", value: 1 },
      { control: "beat-fx", value: true },
      { control: "play", deck: "A" },
    );
    if (options.closeFaderAt !== undefined) {
      void at(context, options.closeFaderAt, () => {
        send(engine, { control: "channel-fader", deck: "A", value: 0 });
      });
    }
    if (options.offAt !== undefined) {
      void at(context, options.offAt, () => {
        send(engine, { control: "beat-fx", value: false });
      });
    }
    const rendered = await context.startRendering();
    return { rendered, frames, engine };
  }

  it("repeats a click every beat, each repeat about half the one before", async () => {
    const { rendered, frames, engine } = await echoOf({});
    const repeats = [0.55, 1.05, 1.55].map((t) => peakIn(rendered, t - 0.01, t + 0.01));
    expect(repeats[0]).toBeGreaterThan(0.3);
    expect((repeats[1] ?? 0) / (repeats[0] ?? 1)).toBeCloseTo(ECHO_FEEDBACK, 1);
    expect((repeats[2] ?? 0) / (repeats[1] ?? 1)).toBeCloseTo(ECHO_FEEDBACK, 1);
    expect(frames.length).toBeGreaterThan(100);
    expect(engine.mixerState().beatFx).toEqual({ on: true, channel: "A", beats: 1, depth: 1 });
  });

  it("rings out after the channel fader closes and after OFF, as on a real mixer", async () => {
    const faderClosed = await echoOf({ closeFaderAt: 0.3 });
    expect(peakIn(faderClosed.rendered, 1.04, 1.06)).toBeGreaterThan(0.1);
    const off = await echoOf({ offAt: 0.3 });
    expect(peakIn(off.rendered, 1.04, 1.06)).toBeGreaterThan(0.1);
  });

  it("takes in only the selected channel", async () => {
    const { rendered } = await echoOf({ channel: "B" });
    expect(peakIn(rendered, 0.5, 2)).toBeLessThan(1e-3);
  });

  it("follows the deck's tempo: at 60 BPM a 1-beat echo is 1 s", async () => {
    const context = offlineContext(1.5);
    const engine = await createAudioEngine({ context, lookaheadSec: 0, masterTempo: false });
    await engine.load("A", clickBuffer(context, 4, [0.05]), { trackId: "t", grid: grid(60) });
    send(engine, { control: "beat-fx-channel", value: "A" }, { control: "beat-fx-depth", value: 1 }, { control: "beat-fx", value: true }, { control: "play", deck: "A" });
    const rendered = await context.startRendering();
    expect(peakIn(rendered, 0.5, 0.6)).toBeLessThan(1e-3);
    expect(peakIn(rendered, 1.04, 1.06)).toBeGreaterThan(0.3);
  });

  it("follows a tapped BPM (TAP) over the deck's, until AUTO", async () => {
    const context = offlineContext(1.5);
    const engine = await createAudioEngine({ context, lookaheadSec: 0, masterTempo: false });
    await engine.load("A", clickBuffer(context, 4, [0.05]), { trackId: "t", grid: grid(120) });
    send(engine, { control: "beat-fx-channel", value: "A" }, { control: "beat-fx-depth", value: 1 }, { control: "beat-fx-bpm", value: 60 }, { control: "beat-fx", value: true }, { control: "play", deck: "A" });
    const rendered = await context.startRendering();
    expect(engine.mixerState().beatFxBpm).toBe(60);
    // A 1-beat echo at the tapped 60 BPM: 1 s, not the deck's 0.5 s.
    expect(peakIn(rendered, 0.5, 0.6)).toBeLessThan(1e-3);
    expect(peakIn(rendered, 1.04, 1.06)).toBeGreaterThan(0.3);
    expect(engine.command({ control: "beat-fx-bpm", value: null }, KEYBOARD)).toEqual({ ok: true });
    expect(engine.mixerState().beatFxBpm).toBeNull();
    expect(engine.command({ control: "beat-fx-bpm", value: 20 }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "value-out-of-range" } });
  });

  it("refuses a BEAT that is not one of the ◀/▶ steps", async () => {
    const { engine } = await engineWith((c) => toneBuffer(c, { frequency: 440, peak: 0.5, seconds: 1 }), 0.1);
    expect(engine.command({ control: "beat-fx-beats", value: 3 }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "value-out-of-range" } });
  });
});
