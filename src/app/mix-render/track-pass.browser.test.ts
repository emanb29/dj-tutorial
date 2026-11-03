// The track pass (ISS-190): each track's playback rendered once, before mixing. Nothing is played.
import { describe, expect, it } from "vitest";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import type { PlanGrid } from "@shared/mix-plan.ts";
import { decoderAt } from "@tracks/load-audio.ts";
import { setTimeline, type SetTimeline } from "./timeline.ts";
import { renderTrackPlayback, stretchMap } from "./track-pass.ts";
import { partialsTrack, TEST_RATE, wavFile } from "./test-support.ts";

const SECONDS = 60;

function timelineOf(recipe: "crossfade-8" | "loop-to-extend", grids: readonly PlanGrid[]): SetTimeline {
  const { plan } = testPlan(2, { recipe, grid: (index) => grids[index] ?? testGrid() });
  const timed = setTimeline(plan, grids);
  if (!timed.ok) throw new Error(timed.problems[0]?.message);
  return timed.timeline;
}

/** A click (1 ms of 1 kHz) on every beat of a `bpm` grid whose first beat is at 0.1 s. */
function clickTrack(bpm: number): Float32Array {
  const data = new Float32Array(SECONDS * TEST_RATE);
  const click = Math.round(TEST_RATE / 1000);
  for (let beat = 0.1; beat < SECONDS - 1; beat += 60 / bpm) {
    const start = Math.round(beat * TEST_RATE);
    for (let index = 0; index < click; index++) data[start + index] = 0.8 * Math.sin((2 * Math.PI * index) / click);
  }
  return data;
}

const decode = async (data: Float32Array) => decoderAt(TEST_RATE)(await wavFile(data).arrayBuffer());

describe("stretchMap", () => {
  it("merges a tempo ride's quarter-beat steps into changes at least 0.35 s apart, keeping the track position exact at each", () => {
    const grids = [testGrid({ durationSec: 300 }), testGrid({ bpm: 126, durationSec: 300 })];
    const { plan } = testPlan(2, { recipe: "tempo-ride", grid: (index) => grids[index] ?? testGrid() });
    const timed = setTimeline(plan, grids);
    if (!timed.ok) throw new Error(timed.problems[0]?.message);
    const pieces = timed.timeline.tracks[1]?.pieces ?? [];
    const entries = stretchMap(pieces, 0.35) ?? [];
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.length).toBeLessThan(pieces.length);
    for (const [index, entry] of entries.entries()) {
      const next = entries[index + 1];
      if (next === undefined) continue;
      expect(next.fromSec - entry.fromSec).toBeGreaterThanOrEqual(0.35 - 1e-9);
      expect(entry.trackSec + (next.fromSec - entry.fromSec) * entry.rate).toBeCloseTo(next.trackSec, 9);
    }
  });

  it("cannot schedule a loop shorter than the stretcher's spacing", () => {
    const pieces = [
      { fromSec: 0, toSec: 0.2, trackSec: 10, rate: 1.05 },
      { fromSec: 0.2, toSec: 0.4, trackSec: 10, rate: 1.05 },
      { fromSec: 0.4, toSec: 5, trackSec: 10, rate: 1.05 },
    ];
    expect(stretchMap(pieces, 0.35)).toBeNull();
  });
});

describe("renderTrackPlayback", () => {
  it("stretches a 126 BPM track to the set's 120 BPM with its beats where the timeline puts them", async () => {
    const grids = [testGrid({ durationSec: SECONDS }), testGrid({ bpm: 126, durationSec: SECONDS })];
    const playback = timelineOf("crossfade-8", grids).tracks[1];
    if (playback === undefined) throw new Error("expected an incoming track");
    const render = await renderTrackPlayback(await decode(clickTrack(126)), playback, { sampleRate: TEST_RATE, masterTempo: true });
    expect(render.kind).toBe("stretched");
    const data = render.buffer.getChannelData(0);
    // Heard at 120 BPM: a beat every 0.5 s from the track's entry. Measured within 2 ms of the model (deck.browser.test.ts's bound for the deck).
    const enterFrame = playback.enterSec * TEST_RATE - render.firstFrame;
    for (const beat of [2, 10, 40, 80, 110]) {
      const expected = enterFrame + beat * 0.5 * TEST_RATE;
      const window = data.subarray(Math.round(expected - 0.02 * TEST_RATE), Math.round(expected + 0.02 * TEST_RATE));
      const onset = window.findIndex((sample) => Math.abs(sample) > 0.1);
      expect(onset).toBeGreaterThan(-1);
      expect(Math.abs(onset - 0.02 * TEST_RATE) / TEST_RATE).toBeLessThan(0.002);
    }
  }, 60_000);

  it("re-pitches instead with Master Tempo off: the same beats, sped down with the key", async () => {
    const grids = [testGrid({ durationSec: SECONDS }), testGrid({ bpm: 126, durationSec: SECONDS })];
    const playback = timelineOf("crossfade-8", grids).tracks[1];
    if (playback === undefined) throw new Error("expected an incoming track");
    const render = await renderTrackPlayback(await decode(clickTrack(126)), playback, { sampleRate: TEST_RATE, masterTempo: false });
    expect(render.kind).toBe("re-pitched");
    const data = render.buffer.getChannelData(0);
    const enterFrame = playback.enterSec * TEST_RATE - render.firstFrame;
    const expected = enterFrame + 40 * 0.5 * TEST_RATE;
    const onset = data.subarray(Math.round(expected - 0.02 * TEST_RATE)).findIndex((sample) => Math.abs(sample) > 0.1);
    expect(Math.abs(onset - 0.02 * TEST_RATE) / TEST_RATE).toBeLessThan(0.001);
  }, 60_000);

  it("holds a loop: each pass round a 1-bar loop is the same audio", async () => {
    const grids = [testGrid({ durationSec: SECONDS }), testGrid({ durationSec: SECONDS })];
    const timeline = timelineOf("loop-to-extend", grids);
    const playback = timeline.tracks[0];
    const transition = timeline.transitions[0];
    if (playback === undefined || transition === undefined) throw new Error("expected an outgoing track and a Transition");
    // A tone that changes over the track, so only a loop repeats it.
    const sweep = Float32Array.from({ length: SECONDS * TEST_RATE }, (_, index) => 0.5 * Math.sin(2 * Math.PI * (200 + index / TEST_RATE) * (index / TEST_RATE)));
    const render = await renderTrackPlayback(await decode(sweep), playback, { sampleRate: TEST_RATE, masterTempo: true });
    expect(render.kind).toBe("looped");
    const data = render.buffer.getChannelData(0);
    const loopStart = Math.round(transition.startSec * TEST_RATE) - render.firstFrame;
    const bar = 2 * TEST_RATE;
    let largest = 0;
    // Away from the wraps' 4 ms crossfades.
    for (let index = 0.01 * TEST_RATE; index < bar - 0.01 * TEST_RATE; index++) largest = Math.max(largest, Math.abs((data[loopStart + index] ?? 0) - (data[loopStart + 3 * bar + index] ?? 0)));
    expect(largest).toBeLessThan(1e-3);
  }, 60_000);

  it("copies a track played at its own tempo, sample for sample", async () => {
    const grids = [testGrid({ durationSec: SECONDS }), testGrid({ durationSec: SECONDS })];
    const playback = timelineOf("crossfade-8", grids).tracks[1];
    if (playback === undefined) throw new Error("expected an incoming track");
    const tone = partialsTrack(SECONDS, [[440, 0.5]]);
    const decoded = await decode(tone);
    const render = await renderTrackPlayback(decoded, playback, { sampleRate: TEST_RATE, masterTempo: true });
    expect(render.kind).toBe("copied");
    const data = render.buffer.getChannelData(0);
    const original = decoded.getChannelData(0);
    // The incoming track starts at bar 1 (0.1 s into it), at the Transition's start.
    const offset = Math.round(0.1 * TEST_RATE) - (Math.round(playback.enterSec * TEST_RATE) - render.firstFrame);
    for (const index of [1000, 50_000, 500_000]) expect(data[index]).toBe(original[index + offset]);
  }, 60_000);
});
