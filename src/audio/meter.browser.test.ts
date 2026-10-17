import { describe, expect, it, vi } from "vitest";
import type { BusMeterFrame as MeterFrame, MeterBus } from "./meter.ts";
import { engineWithTone, expectOk, KEYBOARD, SAMPLE_RATE } from "./offline-test-support.ts";

const SECONDS = 3.5;
const CALIBRATION_PEAK = 10 ** (-3.01 / 20);

/** Renders a -3.01 dBFS stereo 1 kHz tone on deck A and collects every meter frame. */
async function meterCalibrationTone(fader: number) {
  const { context, engine } = await engineWithTone(SECONDS, { frequency: 1000, peak: CALIBRATION_PEAK });
  const frames: MeterFrame[] = [];
  engine.on("meter", (frame) => frames.push(frame));
  expectOk(engine.command({ control: "channel-fader", deck: "A", value: fader }, KEYBOARD));
  await context.startRendering();
  const framesPerBus = Math.floor((SECONDS * SAMPLE_RATE) / 960);
  // Worklet messages can arrive just after rendering resolves.
  await vi.waitFor(() => {
    expect(frames.filter((frame) => frame.bus === "master")).toHaveLength(framesPerBus);
  });
  const lastOf = (bus: MeterBus) => frames.filter((frame) => frame.bus === bus).at(-1);
  return { frames, framesPerBus, lastOf };
}

describe("loudness meters", () => {
  it("read a -3.01 dBFS 1 kHz stereo sine as -3.0 LUFS momentary and short-term on the master", async () => {
    const { lastOf } = await meterCalibrationTone(1);
    const master = lastOf("master");
    expect(Math.abs((master?.momentaryLufs ?? 0) + 3.0)).toBeLessThan(0.3);
    expect(Math.abs((master?.shortTermLufs ?? 0) + 3.0)).toBeLessThan(0.3);
    expect(master?.samplePeakDb).toBeCloseTo(-3.01, 1);
  });

  it("emit 50 frames a second per bus, timed on the context clock", async () => {
    const { frames, framesPerBus } = await meterCalibrationTone(1);
    for (const bus of ["A", "B", "master"] as const) {
      const busFrames = frames.filter((frame) => frame.bus === bus);
      expect(busFrames).toHaveLength(framesPerBus);
      expect(busFrames[0]?.ctx).toBeCloseTo(0.02, 9);
      expect((busFrames[1]?.ctx ?? 0) - (busFrames[0]?.ctx ?? 0)).toBeCloseTo(0.02, 9);
    }
  });

  it("meter channels pre-fader: deck A still reads with its fader down while the master is silent", async () => {
    const { lastOf } = await meterCalibrationTone(0);
    expect(Math.abs((lastOf("A")?.shortTermLufs ?? 0) + 3.0)).toBeLessThan(0.3);
    // A closed fader sits at the shared -120 dB gain floor.
    expect(lastOf("master")?.samplePeakDb).toBeLessThan(-100);
    expect(lastOf("B")?.momentaryLufs).toBe(Number.NEGATIVE_INFINITY);
  });
});
