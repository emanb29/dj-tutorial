import { describe, expect, it } from "vitest";
import type { EngineCommand } from "./commands.ts";
import { channelRmsDb, engineWithTone, expectOk, KEYBOARD, sineRmsDb } from "./offline-test-support.ts";

const PEAK = 0.5;
const SECONDS = 0.6;

/** Renders deck A's tone through the mixer with `commands` applied, and returns the level change in dB. */
async function gainDb(frequency: number, commands: readonly EngineCommand[]): Promise<number> {
  const { context, engine } = await engineWithTone(SECONDS, { frequency, peak: PEAK });
  for (const command of commands) expectOk(engine.command(command, KEYBOARD));
  const rendered = await context.startRendering();
  // Skip the first 0.2 s so filters and parameter smoothing have settled.
  return channelRmsDb(rendered, 0, 0.2, SECONDS) - sineRmsDb(PEAK);
}

describe("channel strip", () => {
  it("passes a tone unchanged with every control at its default", async () => {
    expect(await gainDb(1000, [])).toBeCloseTo(0, 1);
  });

  it("isolator EQ at centre is flat across the bands", async () => {
    for (const frequency of [60, 250, 1000, 2500, 8000]) {
      expect(Math.abs(await gainDb(frequency, []))).toBeLessThan(0.5);
    }
  });

  it("boosts the mid band by 6 dB fully right", async () => {
    expect(await gainDb(1000, [{ control: "eq-mid", deck: "A", value: 1 }])).toBeCloseTo(6, 0);
  });

  it("cuts the mid band by about 13 dB halfway left (the other bands leak a little at 1 kHz)", async () => {
    expect(Math.abs((await gainDb(1000, [{ control: "eq-mid", deck: "A", value: -0.5 }])) + 13)).toBeLessThan(1);
  });

  it("kills each band fully left", async () => {
    expect(await gainDb(50, [{ control: "eq-low", deck: "A", value: -1 }])).toBeLessThan(-40);
    expect(await gainDb(1000, [{ control: "eq-mid", deck: "A", value: -1 }])).toBeLessThan(-25);
    expect(await gainDb(10_000, [{ control: "eq-high", deck: "A", value: -1 }])).toBeLessThan(-40);
  });

  it("leaves other bands alone when one is killed", async () => {
    expect(Math.abs(await gainDb(8000, [{ control: "eq-low", deck: "A", value: -1 }]))).toBeLessThan(0.5);
  });

  it("filter fully left is a low-pass: lows pass, highs are cut", async () => {
    const left = { control: "filter", deck: "A", value: -1 } as const;
    expect(Math.abs(await gainDb(40, [left]))).toBeLessThan(3);
    expect(await gainDb(2000, [left])).toBeLessThan(-30);
  });

  it("filter fully right is a high-pass: lows are cut", async () => {
    expect(await gainDb(1000, [{ control: "filter", deck: "A", value: 1 }])).toBeLessThan(-30);
  });

  it("trim halfway left is -12 dB", async () => {
    expect(await gainDb(1000, [{ control: "trim", deck: "A", value: -0.5 }])).toBeCloseTo(-12, 1);
  });

  it("channel fader halfway is -12 dB and fully down is silent", async () => {
    expect(await gainDb(1000, [{ control: "channel-fader", deck: "A", value: 0.5 }])).toBeCloseTo(-12.04, 1);
    expect(await gainDb(1000, [{ control: "channel-fader", deck: "A", value: 0 }])).toBeLessThan(-100);
  });

  it("master level halfway left is -12 dB", async () => {
    expect(await gainDb(1000, [{ control: "master-level", value: -0.5 }])).toBeCloseTo(-12, 1);
  });
});

describe("crossfader (the shared curve)", () => {
  it("leaves deck A at unity from its side to the centre", async () => {
    expect(await gainDb(1000, [{ control: "crossfader", value: 0 }])).toBeCloseTo(0, 1);
    expect(await gainDb(1000, [{ control: "crossfader", value: 0.5 }])).toBeCloseTo(0, 1);
  });

  it("fades deck A to -6 dB at three quarters and silence fully right", async () => {
    expect(await gainDb(1000, [{ control: "crossfader", value: 0.75 }])).toBeCloseTo(-6.02, 1);
    expect(await gainDb(1000, [{ control: "crossfader", value: 1 }])).toBeLessThan(-100);
  });
});

describe("parameter changes", () => {
  it("a kill reaches true silence rather than leaking a decaying tail", async () => {
    // Fully down, the fader snaps to its -120 dB floor once the smoothing has run.
    expect(await gainDb(1000, [{ control: "channel-fader", deck: "A", value: 0 }])).toBeLessThan(-115);
  });

  it("a later change overrides an earlier one instead of being undone by its snap", async () => {
    expect(
      await gainDb(1000, [
        { control: "channel-fader", deck: "A", value: 0 },
        { control: "channel-fader", deck: "A", value: 1 },
      ]),
    ).toBeCloseTo(0, 1);
  });

  it("moving the filter straight across the centre switches cleanly from low-pass to high-pass", async () => {
    expect(
      await gainDb(1000, [
        { control: "filter", deck: "A", value: -1 },
        { control: "filter", deck: "A", value: 1 },
      ]),
    ).toBeLessThan(-30);
  });
});

describe("command validation", () => {
  it("rejects values outside a control's range, and NaN, as typed errors", async () => {
    const { engine } = await engineWithTone(0.1, { frequency: 1000, peak: PEAK });
    expect(engine.command({ control: "eq-low", deck: "A", value: 1.5 }, KEYBOARD)).toEqual({
      ok: false,
      error: { kind: "value-out-of-range", control: "eq-low", value: 1.5, min: -1, max: 1 },
    });
    expect(engine.command({ control: "channel-fader", deck: "A", value: Number.NaN }, KEYBOARD)).toMatchObject({
      ok: false,
      error: { kind: "value-out-of-range" },
    });
  });
});
