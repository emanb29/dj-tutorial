import { describe, expect, it } from "vitest";
import { testGrid } from "@shared/mix-plan-test-support.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import type { Transition } from "@shared/mix-plan.ts";
import { schedulePreview } from "./preview-audio.ts";
import { previewSchedule } from "./preview-schedule.ts";

// The preview rendered offline (never the speakers): a tone on one track and silence on the other, so
// the level heard is that track's. 120 BPM, so a beat is 0.5 s; the Transition starts on bar 3.
const RATE = 8000;
const GRIDS = { outgoing: testGrid(), incoming: testGrid() };
const PLACE = { outgoingAt: { bar: 3, beat: 1 }, incomingAt: { bar: 1, beat: 1 } } as const;

function tone(context: BaseAudioContext, seconds: number, peak: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.round(seconds * RATE), RATE);
  buffer.copyToChannel(Float32Array.from({ length: buffer.length }, (_, index) => peak * Math.sin((2 * Math.PI * 500 * index) / RATE)), 0);
  return buffer;
}

/** Renders the preview with only `heard`'s track sounding; returns the output and the time of a Transition beat. */
async function render(transition: Transition, heard: "outgoing" | "incoming") {
  const schedule = previewSchedule(transition, GRIDS);
  const seconds = (schedule.toBeat - schedule.fromBeat) * schedule.secPerBeat + 1;
  const context = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(seconds * RATE), sampleRate: RATE });
  const sound = tone(context, 60, 0.5);
  const silence = context.createBuffer(1, 60 * RATE, RATE);
  const preview = schedulePreview(context, schedule, heard === "outgoing" ? { outgoing: sound, incoming: silence } : { outgoing: silence, incoming: sound }, { startCtx: 0 });
  const output = (await context.startRendering()).getChannelData(0);
  const timeOf = (beat: number) => preview.startCtx + (beat - schedule.fromBeat) * schedule.secPerBeat;
  /** RMS over a quarter beat from `beat`. */
  const rmsAt = (beat: number) => {
    const from = Math.round(timeOf(beat) * RATE);
    const slice = output.subarray(from, from + Math.round(0.125 * RATE));
    return Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
  };
  return { rmsAt, beatAt: preview.beatAt, timeOf };
}

const FULL = 0.5 / Math.SQRT2;

describe("schedulePreview", () => {
  it("plays a crossfade: the outgoing track full before it and gone after; the incoming one silent before beat 0 and full from halfway", async () => {
    const transition = transitionFromRecipe("crossfade-8", PLACE);
    const outgoing = await render(transition, "outgoing");
    expect(outgoing.rmsAt(-6)).toBeCloseTo(FULL, 2);
    expect(outgoing.rmsAt(8)).toBeCloseTo(FULL, 2);
    expect(outgoing.rmsAt(24)).toBeLessThan(FULL / 4);
    expect(outgoing.rmsAt(40)).toBeLessThan(1e-3);

    const incoming = await render(transition, "incoming");
    expect(incoming.rmsAt(-4)).toBeLessThan(1e-3);
    // A quarter of the way up the fader over the first half (position² of 0.5 is 0.25).
    expect(incoming.rmsAt(8)).toBeGreaterThan(FULL * 0.15);
    expect(incoming.rmsAt(8)).toBeLessThan(FULL * 0.4);
    expect(incoming.rmsAt(20)).toBeCloseTo(FULL, 2);
  });

  it("cuts on the 1: full on the beat before, silent on the beat itself", async () => {
    const cut = await render(transitionFromRecipe("cut-on-the-1", PLACE), "outgoing");
    expect(cut.rmsAt(-0.5)).toBeCloseTo(FULL, 2);
    expect(cut.rmsAt(0.05)).toBeLessThan(1e-3);
  });

  it("kills the incoming track's lows in a filter sweep's start, and gives the beat heard at a time", async () => {
    // 500 Hz sits inside the low shelf's reach: killed, it is far quieter than when the lane lets it back.
    const sweep = await render(transitionFromRecipe("filter-sweep", PLACE), "incoming");
    expect(sweep.rmsAt(30)).toBeGreaterThan(sweep.rmsAt(4) * 3);
    expect(sweep.beatAt(sweep.timeOf(12))).toBeCloseTo(12);
  });
});
