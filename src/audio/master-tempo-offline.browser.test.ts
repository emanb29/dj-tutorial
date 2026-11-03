// Master Tempo (key lock) rendered through an OfflineAudioContext, as the Mix Editor's Render needs it
// (ISS-188; findings in docs/research/offline-master-tempo.md). The realtime path is in
// master-tempo-realtime.browser.test.ts. Nothing here reaches the speakers.
//
// What holds: one offline render keeps the pitch at every tempo, follows the model's length, takes a
// tempo change sent mid-render, and is deterministic. What does not: a second render started from a
// snapshot of the first does not continue it sample-continuously while the stretcher plays, because
// the stretcher's output phase depends on its whole history. The plain rate voice does continue, so a
// stretcher pass rendered once per track, then played without Master Tempo, segments cleanly.

import SignalsmithStretch from "signalsmith-stretch";
import { describe, expect, it } from "vitest";
import { createAudioEngine } from "./engine.ts";
import { at, offlineContext, outputTimeOf, SAMPLE_RATE, send, toneBuffer, toneFrequency, toneLevelDb } from "./offline-test-support.ts";
import type { PlayheadSegment } from "./playhead.ts";

const TONE_HZ = 440;
/** 8 bars at 120 BPM, in track seconds. */
const EIGHT_BARS_SEC = 16;
/** The audio of a stretched track may end off the model by the stretcher's STFT smear (measured 5–10 ms). */
const END_TOLERANCE_SEC = 0.015;
/** Seams: a segment starts this long before the seam and its lead-in is dropped (a fresh mixer settles in it). */
const PREROLL_SEC = 0.25;

/** Three inharmonic partials: unlike a pure tone, no time shift but zero lines two renders up. */
function chordBuffer(context: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.round(seconds * context.sampleRate);
  const data = Float32Array.from({ length }, (_, index) =>
    [311, 440, 677].reduce((sum, hz) => sum + 0.2 * Math.sin((2 * Math.PI * hz * index) / context.sampleRate), 0),
  );
  const buffer = context.createBuffer(2, length, context.sampleRate);
  buffer.copyToChannel(data, 0);
  buffer.copyToChannel(data, 1);
  return buffer;
}

/** Time of the last sample louder than `threshold`, seconds. */
function lastLoudSec(rendered: AudioBuffer, threshold = 0.05): number {
  const data = rendered.getChannelData(0);
  for (let index = data.length - 1; index >= 0; index--) {
    if (Math.abs(data[index] ?? 0) > threshold) return index / rendered.sampleRate;
  }
  return Number.NaN;
}

interface DeckRender {
  readonly rendered: AudioBuffer;
  readonly segments: readonly PlayheadSegment[];
  /** The track position heard at a render time. */
  readonly positionAt: (ctx: number) => number;
}

/**
 * Deck A plays `track` from `fromSec` at `tempoPercent` (range ±6%), alone on the master. Every command
 * goes in before the render, except `ride`, which moves the tempo fader mid-render through suspend().
 */
async function renderDeck(options: {
  seconds: number;
  track: (context: BaseAudioContext) => AudioBuffer;
  masterTempo: boolean;
  tempoPercent: number;
  fromSec?: number;
  ride?: { atSec: number; tempoPercent: number };
}): Promise<DeckRender> {
  const context = offlineContext(options.seconds);
  const engine = await createAudioEngine({ context });
  const loaded = await engine.load("A", options.track(context), { trackId: "track", grid: null });
  if (!loaded.ok) throw new Error(`Loading the test track failed: ${loaded.error.kind}`);
  send(
    engine,
    { control: "crossfader", value: 0 },
    { control: "master-tempo", deck: "A", value: options.masterTempo },
    { control: "tempo-range", deck: "A", value: 6 },
    { control: "tempo", deck: "A", value: options.tempoPercent / 6 },
    { control: "seek", deck: "A", value: options.fromSec ?? 0 },
    { control: "play", deck: "A" },
  );
  await engine.settled();
  const { ride } = options;
  const rode =
    ride === undefined
      ? Promise.resolve()
      : at(context, ride.atSec, async () => {
          send(engine, { control: "tempo", deck: "A", value: ride.tempoPercent / 6 });
          // The stretch worklet's message lands before the render runs on past the change.
          await engine.settled();
        });
  const rendered = await context.startRendering();
  await rode;
  const segments = engine.trackHistory("A").at(-1)?.playhead.segments() ?? [];
  return { rendered, segments, positionAt: (ctx) => engine.playheadAt("A", ctx)?.positionSec ?? Number.NaN };
}

/**
 * How far a segment rendered from a snapshot strays from one continuous reference: the largest sample
 * difference over the second after the seam, and the step across the seam itself.
 */
function seamOf(reference: DeckRender, seamSec: number, segment: DeckRender, snapshotPosSec: number): { maxDiff: number; step: number } {
  const ref = reference.rendered.getChannelData(0);
  const seg = segment.rendered.getChannelData(0);
  const refSeam = Math.round(seamSec * SAMPLE_RATE);
  const segSeam = Math.round((outputTimeOf(segment.segments, snapshotPosSec) ?? Number.NaN) * SAMPLE_RATE);
  let maxDiff = 0;
  for (let offset = 0; offset < SAMPLE_RATE; offset++) {
    maxDiff = Math.max(maxDiff, Math.abs((ref[refSeam + offset] ?? 0) - (seg[segSeam + offset] ?? 0)));
  }
  return { maxDiff, step: Math.abs((seg[segSeam] ?? 0) - (ref[refSeam - 1] ?? 0)) };
}

/** The largest step between neighbouring samples in the 0.1 s before the seam: what continuous looks like. */
function naturalStep(reference: DeckRender, seamSec: number): number {
  const ref = reference.rendered.getChannelData(0);
  const seam = Math.round(seamSec * SAMPLE_RATE);
  let largest = 0;
  for (let index = seam - SAMPLE_RATE / 10; index < seam; index++) largest = Math.max(largest, Math.abs((ref[index] ?? 0) - (ref[index - 1] ?? 0)));
  return largest;
}

describe("Master Tempo in one offline render", () => {
  const tone = (context: BaseAudioContext) => toneBuffer(context, { frequency: TONE_HZ, peak: 0.5, seconds: EIGHT_BARS_SEC });

  for (const tempoPercent of [4, 6, -6]) {
    it(`renders 8 bars at ${tempoPercent > 0 ? "+" : ""}${String(tempoPercent)}% with the pitch kept and the length the tempo gives`, async () => {
      const rate = 1 + tempoPercent / 100;
      const { rendered, segments } = await renderDeck({ seconds: 0.5 + EIGHT_BARS_SEC / rate, track: tone, masterTempo: true, tempoPercent });
      const start = segments.find((segment) => segment.rate > 0)?.fromCtx ?? Number.NaN;
      const endError = lastLoudSec(rendered) - (start + EIGHT_BARS_SEC / rate);

      // Measured: 440.4 Hz at every tempo (the zero-crossing count's resolution over 13 s).
      expect(Math.abs(toneFrequency(rendered, 0, 1, 14) / TONE_HZ - 1)).toBeLessThan(0.01);
      expect(Math.abs(endError)).toBeLessThan(END_TOLERANCE_SEC);
    }, 30_000);
  }

  it("without Master Tempo, the same +4% raises the pitch 4% (the measurement tells the two apart)", async () => {
    const { rendered } = await renderDeck({ seconds: 4, track: tone, masterTempo: false, tempoPercent: 4 });
    expect(toneFrequency(rendered, 0, 0.5, 3.5) / TONE_HZ).toBeCloseTo(1.04, 2);
  });

  it("takes a tempo ride sent mid-render (suspend, then resume) where the model says", async () => {
    const short = (context: BaseAudioContext) => toneBuffer(context, { frequency: TONE_HZ, peak: 0.5, seconds: 4 });
    const { rendered, segments } = await renderDeck({ seconds: 5, track: short, masterTempo: true, tempoPercent: 0, ride: { atSec: 1, tempoPercent: 6 } });
    // Had the ride not landed, the track would end 0.17 s later than this.
    const expectedEnd = outputTimeOf(segments, 4 - 1e-6) ?? Number.NaN;
    expect(Math.abs(lastLoudSec(rendered) - expectedEnd)).toBeLessThan(END_TOLERANCE_SEC);
    expect(Math.abs(toneFrequency(rendered, 0, 1.5, 3.5) / TONE_HZ - 1)).toBeLessThan(0.01);
  });

  it("is deterministic: the same render twice gives the same samples", async () => {
    const chord = (context: BaseAudioContext) => chordBuffer(context, 6);
    const first = await renderDeck({ seconds: 3, track: chord, masterTempo: true, tempoPercent: 4 });
    const second = await renderDeck({ seconds: 3, track: chord, masterTempo: true, tempoPercent: 4 });
    const a = first.rendered.getChannelData(0);
    const b = second.rendered.getChannelData(0);
    expect(a.length).toBe(3 * SAMPLE_RATE);
    expect(a.every((sample, index) => Math.abs(sample - (b[index] ?? Number.NaN)) < 1e-6)).toBe(true);
  });
});

describe("segment seams (a render split into segments, each from a snapshot)", () => {
  const SEAM_SEC = 4;
  const chord = (context: BaseAudioContext) => chordBuffer(context, 20);

  /** A reference render from 1 s into the track, and a segment rendered from its snapshot at the seam. */
  async function seam(masterTempo: boolean, track = chord, tempoPercent = 4) {
    const reference = await renderDeck({ seconds: SEAM_SEC + 2, track, masterTempo, tempoPercent, fromSec: 1 });
    const snapshotPosSec = reference.positionAt(SEAM_SEC);
    const fromSec = snapshotPosSec - PREROLL_SEC * (1 + tempoPercent / 100);
    const segment = await renderDeck({ seconds: PREROLL_SEC + 2, track, masterTempo, tempoPercent, fromSec });
    return { ...seamOf(reference, SEAM_SEC, segment, snapshotPosSec), natural: naturalStep(reference, SEAM_SEC) };
  }

  it("without Master Tempo, a segment from a snapshot continues the reference (measured: within 3e-4)", async () => {
    const { maxDiff, step, natural } = await seam(false);
    expect(maxDiff).toBeLessThan(1e-3);
    expect(step).toBeLessThan(natural * 1.1);
  });

  // Known limitation: the stretcher re-synthesises with phases that depend on everything it has played,
  // so a fresh one does not line up with the reference (measured: up to 0.35–0.54 off on a 0.6 peak, and a
  // 0.08–0.29 step at the seam against a natural 0.037, with 0, 0.25 or 1 s of preroll). `fails` turns
  // this red if that ever changes, so the Render can drop its workaround.
  it.fails("with Master Tempo on, a segment from a snapshot continues the reference", async () => {
    const { maxDiff, step, natural } = await seam(true);
    expect(maxDiff).toBeLessThan(1e-2);
    expect(step).toBeLessThan(natural * 1.1);
  });

  it("a track stretched in one pass, then played without Master Tempo, segments cleanly (the recommended Render)", async () => {
    // Pass 1: the stretcher alone over the whole span, at +4%, as one offline render.
    const source = offlineContext(8);
    const stretch = await SignalsmithStretch(source, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const input = chordBuffer(source, 12);
    const channels = [input.getChannelData(0).slice(), input.getChannelData(1).slice()];
    await stretch.addBuffers(channels, channels.map((channel) => channel.buffer));
    await stretch.schedule({ output: 0, input: 0, rate: 1.04, active: true });
    stretch.connect(source.destination);
    const stretched = await source.startRendering();

    // The pass kept the key: the 440 Hz partial is there, not moved up 4% to 457.6 Hz.
    expect(toneLevelDb(stretched, 0, 1, 7, 440) - toneLevelDb(stretched, 0, 1, 7, 457.6)).toBeGreaterThan(20);

    // Pass 2: the stretched audio is the deck's track, played at 0% with Master Tempo off, in segments.
    const { maxDiff, step, natural } = await seam(false, () => stretched, 0);
    expect(maxDiff).toBeLessThan(1e-3);
    expect(step).toBeLessThan(natural * 1.1);
  }, 30_000);
});
