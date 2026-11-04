// Lesson 19 (A full blend by ear) on a DDJ-FLX4: the Check's set-up leaves LOW B where the knob is, and
// the Learner cuts it, so soft takeover never waits for the physical knob to find a value the app set on
// its own. MIDI bytes through the bridge and the controller session into a real engine rendering offline
// (never the speakers), as hardware.browser.test.ts does.
import { afterEach, describe, expect, it } from "vitest";
import type { MidiMessage } from "@midi";
import { LESSON_IDS } from "@shared/catalogue.ts";
import { ALL_CONTROL_IDS } from "../controller/control-ids.ts";
import { HardwareBridge, type HardwarePort } from "../controller/hardware.ts";
import { ControllerSession } from "../controller/session.ts";
import { lessonHarness, pairTrack, passedBefore, setUpThenReady, synthetic, until, type LessonHarness } from "./lesson-test-support.ts";
import { SYNTHETIC_HOUSE, SYNTHETIC_PARTNER } from "@lessons";

const SAMPLE_RATE = 48_000;

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
  /** The FLX4's LOW knob on deck B (channel 2, CC 0x0f and its LSB 0x2f) at `value01` of its travel, sent now. */
  lowB(value01: number): void {
    const raw = Math.round(value01 * 16383);
    for (const bytes of [
      [0xb1, 0x0f, raw >> 7],
      [0xb1, 0x2f, raw & 0x7f],
    ]) {
      this.listener?.({ data: new Uint8Array(bytes), timeStamp: performance.now() });
    }
  }
}

let current: { run: LessonHarness; detach: () => void } | null = null;
afterEach(async () => {
  current?.detach();
  await current?.run.close();
  current = null;
});

describe("blend-by-ear with the FLX4", () => {
  it("leaves LOW B to the Learner: the knob drives it at once, down for the match and back up for the swap", { timeout: 60_000 }, async () => {
    const run = await lessonHarness({
      sampleRate: SAMPLE_RATE,
      lessonId: "blend-by-ear",
      track: pairTrack(),
      audio: (context) => synthetic(context, SYNTHETIC_HOUSE),
      partnerAudio: (context) => synthetic(context, SYNTHETIC_PARTNER),
      renderSec: 40,
      latencySec: 0.04,
    });
    const controller = new ControllerSession(run.engine, { unlocks: new Set(ALL_CONTROL_IDS), macPlatform: true, schedule: () => () => undefined });
    controller.connect();
    const port = new Port();
    const detach = new HardwareBridge(controller, run.engine, port, { schedule: () => () => undefined, positions: { get: () => null } }).attach();
    current = { run, detach };
    const lowB = () => run.engine.mixerState().channels.B["eq-low"];
    const waiting = () => controller.snapshot().pickup["B.eq-low"];

    // The knob sits in the middle, where practice left LOW B: it has it.
    port.lowB(0.5);
    expect(waiting()).toBeUndefined();

    run.session.startCheck(passedBefore(LESSON_IDS, "blend-by-ear"));
    await until(() => run.session.setUpPending() !== null, "the Check's set-up step");
    await run.renderTo(run.now() + 0.5);
    // The set-up centred the EQ, as the knob is: nothing to pick up.
    expect(lowB()).toBe(0);
    expect(waiting()).toBeUndefined();
    expect(run.session.checkCue()?.caption).toBe("Set up: LOW B all the way down");

    // "LOW B all the way down", off the clock: every turn moves the app's LOW B with the knob.
    const down: number[] = [];
    for (const value of [0.4, 0.25, 0.1, 0]) {
      port.lowB(value);
      await run.renderTo(run.now() + 0.05);
      down.push(lowB());
      expect(waiting()).toBeUndefined();
    }
    expect(down.every((value, index) => index === 0 || value < (down[index - 1] ?? Number.POSITIVE_INFINITY))).toBe(true);
    expect(down.at(-1)).toBe(-1);
    expect(run.session.checkCue()?.caption).toBe("All set: starts on the next phrase");
    // R: the Check starts at once, LOW B left as the knob put it.
    const playAt = await setUpThenReady(run, []);
    await run.renderToHeard(playAt + 0.5);
    expect(lowB()).toBe(-1);
    expect(run.session.checkCue()?.caption).toContain("Now match B");

    // At the swap, "LOW B up": the knob brings it straight back, no hunting for a pickup point.
    for (const value of [0.2, 0.35, 0.5]) {
      port.lowB(value);
      await run.renderTo(run.now() + 0.05);
      expect(waiting()).toBeUndefined();
    }
    expect(lowB()).toBeCloseTo(0, 3);
  });
});
