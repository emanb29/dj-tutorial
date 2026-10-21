// A connected DDJ-FLX4 against the Lessons' set-ups (hardware-sync.ts): a real engine rendered offline
// (never the speakers), and a fake controller whose faders and knobs are where the test says. While it
// is connected, a set-up takes neutral values from the hardware, waits for the Learner to match the
// deliberate ones (or Skip), and never sets a fader or knob in software anywhere the hardware is known
// not to be.
import { afterEach, describe, expect, it } from "vitest";
import type { CommandEvent } from "@audio";
import { lessonDefinition, practiceDecksFor, SYNTHETIC_PARTNER, setUpTrim } from "@lessons";
import { HardwarePositions, trackPositions, type MidiMessage } from "@midi";
import { ALL_CONTROL_IDS } from "../controller/control-ids.ts";
import type { ContinuousControlId } from "../controller/gestures.ts";
import { HardwareBridge, hardwareAppValue } from "../controller/hardware.ts";
import { ControllerSession } from "../controller/session.ts";
import { liveHardwareView, type HardwareView } from "./hardware-sync.ts";
import { lessonHarness, pairTrack, synthetic, until, type LessonHarness } from "./lesson-test-support.ts";

const SAMPLE_RATE = 48_000;

/** The FLX4 as a set-up sees it: where each fader and knob is (app values), and moves to make. */
class FakeController implements HardwareView {
  connected = true;
  private readonly places = new Map<ContinuousControlId, number>();
  private readonly listeners = new Set<() => void>();

  constructor(places: Partial<Record<ContinuousControlId, number>>) {
    for (const [control, value] of Object.entries(places)) this.places.set(control as ContinuousControlId, value);
  }

  position(control: ContinuousControlId): number | null {
    return this.places.get(control) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The Learner moves a control (it is then known). */
  move(control: ContinuousControlId, value: number): void {
    this.places.set(control, value);
    for (const listener of this.listeners) listener();
  }

  unplug(): void {
    this.connected = false;
    this.places.clear();
    for (const listener of this.listeners) listener();
  }
}

const CONTINUOUS = new Set(["channel-fader", "trim", "eq-high", "eq-mid", "eq-low", "filter", "tempo", "crossfader", "master-level", "cue-mix", "headphone-level", "beat-fx-depth"]);

/** Every fader and knob the session set (it sends as the keyboard; the test sends nothing), with the hardware's place then. */
function watchSets(run: LessonHarness, controller: FakeController): { control: ContinuousControlId; value: number; hardware: number | null }[] {
  const sets: { control: ContinuousControlId; value: number; hardware: number | null }[] = [];
  run.engine.on("command", (event: CommandEvent) => {
    const { command } = event;
    const value = "value" in command ? command.value : null;
    if (event.device !== "keyboard" || event.rejected !== null || !CONTINUOUS.has(command.control) || typeof value !== "number") return;
    const control = ("deck" in command ? `${command.deck}.${command.control}` : command.control) as ContinuousControlId;
    sets.push({ control, value, hardware: controller.position(control) });
  });
  return sets;
}

let current: LessonHarness | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function harness(lessonId: Parameters<typeof lessonHarness>[0]["lessonId"], controller: HardwareView, renderSec = 60): Promise<LessonHarness> {
  current = await lessonHarness({
    sampleRate: SAMPLE_RATE,
    lessonId,
    track: pairTrack(),
    renderSec,
    partnerAudio: (context) => synthetic(context, SYNTHETIC_PARTNER),
    hardware: controller,
  });
  return current;
}

describe("a set-up with the FLX4 connected", () => {
  it("takes neutral values from the hardware and starts at once when the deliberate ones already match", { timeout: 30_000 }, async () => {
    // Lesson 2 (Find the beat and the one): fader A up; TRIM is the usual set-up level (neutral).
    const controller = new FakeController({ "A.channel-fader": 1, "A.trim": 0.3, "master-level": -0.25, "headphone-level": 0.8 });
    const run = await harness("beats-and-bars", controller);
    const sets = watchSets(run, controller);
    run.session.preparePractice();
    await until(() => run.engine.deckState("A").playing, "practice to play");
    expect(run.session.setUpPending()).toBeNull();
    const { channels, masterLevel, headphoneLevel } = run.engine.mixerState();
    expect(channels.A.trim).toBeCloseTo(0.3, 9);
    expect(masterLevel).toBeCloseTo(-0.25, 9);
    expect(headphoneLevel).toBeCloseTo(0.8, 9);
    expect(sets.filter((set) => set.hardware !== null && Math.abs(set.value - set.hardware) > 1e-9)).toEqual([]);
  });

  it("waits for Lesson 4 (Set the level)'s hot TRIM A and quiet TRIM B, ticking each off, then starts; never ahead of the hardware", { timeout: 30_000 }, async () => {
    const controller = new FakeController({ "A.channel-fader": 1, "B.channel-fader": 0, "A.trim": 0, "B.trim": 0 });
    const run = await harness("gain-staging", controller);
    const sets = watchSets(run, controller);
    const planned = practiceDecksFor(lessonDefinition("gain-staging"), run.track);
    run.session.preparePractice();
    await until(() => run.session.setUpPending() !== null, "the match step");
    const lines = () => run.session.setUpPending()?.items.map((item) => [item.label, item.state]);
    expect(lines()).toEqual([
      ["Fader A", "matched"],
      ["TRIM A", "move"],
      ["Fader B", "matched"],
      ["TRIM B", "move"],
    ]);
    // Nothing plays, and R is not a practice rep, until the controller matches.
    expect(run.engine.deckState("A").playing).toBe(false);
    run.session.ready();
    expect(run.observed.filter((observation) => observation.kind === "ready")).toEqual([]);

    controller.move("A.trim", planned.A.trim ?? 0);
    expect(lines()).toEqual([
      ["Fader A", "matched"],
      ["TRIM A", "matched"],
      ["Fader B", "matched"],
      ["TRIM B", "move"],
    ]);
    expect(run.engine.deckState("A").playing).toBe(false);
    // Close enough: within the tolerance, and the screen takes the hardware's value, not the plan's.
    const nearB = (planned.B?.trim ?? 0) + 0.03;
    controller.move("B.trim", nearB);
    expect(run.session.setUpPending()).toBeNull();
    await until(() => run.engine.deckState("A").playing, "practice to play");
    expect(run.engine.mixerState().channels.B.trim).toBeCloseTo(nearB, 9);
    expect(sets.filter((set) => set.hardware !== null && Math.abs(set.value - set.hardware) > 1e-9)).toEqual([]);
  });

  it("asks to wiggle a control it has not seen, and Skip goes on with the planned value", { timeout: 30_000 }, async () => {
    const controller = new FakeController({});
    const run = await harness("deck-basics", controller);
    run.session.preparePractice();
    await until(() => run.session.setUpPending() !== null, "the match step");
    expect(run.session.setUpPending()?.items.map((item) => [item.label, item.state])).toEqual([["Fader A", "unknown"]]);
    run.session.skipSetUp();
    expect(run.session.setUpPending()).toBeNull();
    // Lesson 1's practice starts with fader A down, TRIM at the set-up level (no position known).
    await until(() => run.engine.mixerState().channels.A["channel-fader"] === 0, "the planned fader");
    expect(run.engine.mixerState().channels.A.trim).toBeCloseTo(setUpTrim(run.track), 9);
    // Skipped once: later set-ups in this Lesson do not ask again.
    run.session.preparePractice();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run.session.setUpPending()).toBeNull();
  });

  it("goes on by itself at the phrase's end once the items tick and the caption's asks are done; R goes at once", { timeout: 60_000 }, async () => {
    // Lesson 7 (Your first transition: the cut): fader A up; the caption asks CUE 🎧 B on, fader B up,
    // trims matched. B is cued with its fader down, but the step asks it up: no "Fader B" item to
    // contradict the caption. Its Check opens with this set-up step: the items tick off in it.
    const controller = new FakeController({ "A.channel-fader": 0.6, "B.channel-fader": 0.6, "A.trim": 0, "B.trim": 0 });
    const run = await harness("cut-on-phrase", controller);
    const sets = watchSets(run, controller);
    const midi = (control: "A.channel-fader" | "B.channel-fader", value: number) => {
      controller.move(control, value);
      run.engine.command({ control: "channel-fader", deck: control === "A.channel-fader" ? "A" : "B", value }, { device: "midi" });
    };
    run.session.startCheck();
    await until(() => run.session.setUpPending() !== null, "the set-up step");
    expect(run.session.setUpPending()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");
    expect(run.session.setUpPending()?.items.map((item) => [item.label, item.state])).toEqual([["Fader A", "move"]]);
    // Fader B stays where the hardware has it until the Learner moves it.
    expect(run.engine.mixerState().channels.B["channel-fader"]).toBeCloseTo(0.6, 6);
    // R does nothing while an item is still to match; A loops its first phrase meanwhile.
    run.session.ready();
    expect(run.session.setUpPending()).not.toBeNull();
    await until(() => run.engine.deckState("A").playing, "A to loop its first phrase");
    run.engine.command({ control: "headphone-cue", deck: "B", value: true }, { device: "midi" });
    midi("B.channel-fader", 1);
    // Fader A still to match: not set yet.
    await run.renderTo(run.now() + 0.5);
    expect(run.session.setUpPending()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");
    midi("A.channel-fader", 1);
    await until(() => run.session.setUpPending()?.caption === "All set: starts on the next phrase", "the step to be set");
    // Set: it waits for A's phrase to come round, then the Check starts by itself (no R).
    await run.renderTo(run.now() + 0.5);
    expect(run.session.setUpPending()).not.toBeNull();
    for (let tries = 0; run.session.setUpPending() !== null; tries += 1) {
      if (tries > 200) throw new Error("The set-up step never went on by itself.");
      await run.renderTo(run.now() + 0.1);
    }
    await until(() => run.session.runningPlan() !== null && run.engine.deckState("A").playing, "the Check to start");
    expect(run.engine.mixerState().channels.B["channel-fader"]).toBe(1);

    // A retry: the Check cues CUE 🎧 B off again; the controller is unchanged, so nothing to match.
    run.session.startCheck();
    await until(() => run.session.setUpPending() !== null, "the retry's set-up step");
    expect(run.session.setUpPending()?.items.every((item) => item.state === "matched")).toBe(true);
    expect(run.session.setUpPending()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");
    // R, the manual way: at once, the asks or not.
    run.session.ready();
    expect(run.session.setUpPending()).toBeNull();
    await until(() => run.session.runningPlan() !== null && run.engine.deckState("A").playing, "the retry to start");
    expect(sets.filter((set) => set.hardware !== null && Math.abs(set.value - set.hardware) > 1e-9)).toEqual([]);
  });

  it("practice's set-up step keeps observing the Learner, and when it comes round already set it still plays its phrase first", { timeout: 90_000 }, async () => {
    const controller = new FakeController({ "A.channel-fader": 1, "B.channel-fader": 1, "A.trim": 0, "B.trim": 0 });
    const run = await harness("cut-on-phrase", controller, 120);
    const bar = (4 * 60) / run.track.grid.bpm;
    const start = lessonDefinition("cut-on-phrase").practiceStart(run.track);
    run.session.preparePractice("practice");
    await until(() => run.session.setUpPending() !== null && run.engine.deckState("A").playing, "practice's set-up step, A looping");
    // Fader B is up on the hardware, and stays there: only CUE 🎧 B to go.
    expect(run.session.setUpPending()?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched");
    const seen = run.observed.length;
    const sent = run.engine.command({ control: "headphone-cue", deck: "B", value: true }, { device: "keyboard" });
    expect(sent.ok).toBe(true);
    expect(run.observed.length).toBeGreaterThan(seen);
    expect(run.session.setUpPending()?.caption).toBe("All set: starts on the next phrase");
    run.session.ready();
    expect(run.session.setUpPending()).toBeNull();
    expect(run.engine.deckState("A").playing).toBe(true);

    // Practice goes round to its set-up again: CUE 🎧 B and fader B are as the Learner left them.
    for (let tries = 0; run.session.setUpPending() === null; tries += 1) {
      if (tries > 600) throw new Error("Practice never went back to its set-up.");
      await run.renderTo(run.now() + 0.1);
    }
    // The step came round (A back at its phrase start) within the last render step.
    const cameAt = run.now();
    expect(Math.abs((run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN) - start)).toBeLessThan(0.2);
    expect(run.session.setUpPending()?.caption).toBe("All set: starts on the next phrase");
    // Not at once: A plays its phrase through first, for the Learner to hear where it starts.
    await run.renderTo(run.now() + 4 * bar);
    expect(run.session.setUpPending()).not.toBeNull();
    let wentAt = Number.NaN;
    const stop = run.engine.on("command", (event) => {
      if (Number.isNaN(wentAt) && run.session.setUpPending() === null && event.command.control === "seek" && "deck" in event.command && event.command.deck === "A") wentAt = event.appliedCtx;
    });
    for (let tries = 0; run.session.setUpPending() !== null; tries += 1) {
      if (tries > 200) throw new Error("The set-up step never went on by itself.");
      await run.renderTo(run.now() + 0.1);
    }
    stop();
    expect(wentAt - cameAt).toBeGreaterThan(8 * bar - 0.15);
    expect(wentAt - cameAt).toBeLessThan(8 * bar + 0.3);
  });

  it("Lesson 6 (Set a cue point by ear) practice waits for the controller, then each cue point set is a rep", { timeout: 30_000 }, async () => {
    // Every fader of the set-up as far from its target as it goes: nothing matches yet.
    const definition = lessonDefinition("cue-point");
    const decks = practiceDecksFor(definition, pairTrack());
    const controller = new FakeController({ "A.channel-fader": decks.A.fader > 0.5 ? 0 : 1, "A.trim": 0 });
    const run = await harness("cue-point", controller);
    run.session.preparePractice("practice");
    await until(() => run.session.setUpPending() !== null, "the match step");
    expect(run.session.setUpPending()?.caption).toBeNull();
    controller.move("A.channel-fader", decks.A.fader);
    run.engine.command({ control: "channel-fader", deck: "A", value: decks.A.fader }, { device: "midi" });
    await until(() => run.session.setUpPending() === null, "the controller to match");
    await until(() => Math.abs((run.engine.playheadAt("A", run.now())?.positionSec ?? Number.NaN) - decks.A.pos) < 0.5, "practice to cue deck A");
    run.engine.command({ control: "pause", deck: "A" }, { device: "keyboard" });
    await run.renderTo(run.now() + 0.05);
    run.engine.command({ control: "deck-cue", deck: "A", value: true }, { device: "keyboard" });
    run.engine.command({ control: "deck-cue", deck: "A", value: false }, { device: "keyboard" });
    await run.renderTo(run.now() + 0.05);
    expect(run.observed.filter((observation) => observation.kind === "cue-set")).toHaveLength(1);
  });

  it("skips a captioned set-up step's unmatched items: they are set on screen, and nothing else is waited for", { timeout: 30_000 }, async () => {
    const controller = new FakeController({ "A.channel-fader": 0.6, "B.channel-fader": 0.6, "A.trim": 0, "B.trim": 0 });
    const run = await harness("cut-on-phrase", controller);
    run.session.startCheck();
    await until(() => run.session.setUpPending() !== null, "the set-up step");
    run.session.skipSetUp();
    expect(run.session.setUpPending()).toBeNull();
    expect(run.engine.mixerState().channels.A["channel-fader"]).toBe(1);
    await until(() => run.session.runningPlan() !== null && run.engine.deckState("A").playing, "the Check to start");
  });

  it("goes on as planned when the controller is unplugged mid-step", { timeout: 30_000 }, async () => {
    const controller = new FakeController({ "A.channel-fader": 0.5 });
    const run = await harness("beats-and-bars", controller);
    run.session.preparePractice();
    await until(() => run.session.setUpPending() !== null, "the match step");
    controller.unplug();
    await until(() => run.engine.deckState("A").playing, "practice to play");
    expect(run.engine.mixerState().channels.A["channel-fader"]).toBe(1);
  });
});

/** The FLX4 as MIDI: what the app's connection gives the positions record and the hardware bridge. */
class MidiPort {
  readonly connected = true;
  private readonly listeners = new Set<(message: MidiMessage) => void>();
  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribe(): () => void {
    return () => undefined;
  }
  send(): boolean {
    return true;
  }
  /** A 14-bit fader or knob message (MSB, then LSB) at 0…1 of its travel. */
  continuous(status: number, msbCc: number, value01: number): void {
    const raw = Math.round(value01 * 16383);
    for (const data of [[status, msbCc, raw >> 7], [status, msbCc + 0x20, raw & 0x7f]]) {
      for (const listener of this.listeners) listener({ data: new Uint8Array(data), timeStamp: performance.now() });
    }
  }
}

describe("the FLX4's MIDI against a Lesson set-up", () => {
  it("adopts the positions its faders and knobs sent, and the hardware drives them on at once (no pickup)", { timeout: 30_000 }, async () => {
    const port = new MidiPort();
    const positions = new HardwarePositions();
    trackPositions(port, positions);
    // Fader A up (0xB0 0x13), TRIM A at 65% (0xB0 0x04), MASTER LEVEL at 30% (0xB6 0x08).
    port.continuous(0xb0, 0x13, 1);
    port.continuous(0xb0, 0x04, 0.65);
    port.continuous(0xb6, 0x08, 0.3);
    const run = await harness("beats-and-bars", liveHardwareView(port, positions));
    const controller = new ControllerSession(run.engine, { unlocks: new Set(ALL_CONTROL_IDS), macPlatform: true, schedule: () => () => undefined });
    controller.connect();
    const detach = new HardwareBridge(controller, run.engine, port, { schedule: () => () => undefined, positions }).attach();
    try {
      run.session.preparePractice();
      await until(() => run.engine.deckState("A").playing, "practice to play");
      expect(run.session.setUpPending()).toBeNull();
      expect(run.engine.mixerState().channels.A.trim).toBeCloseTo(hardwareAppValue("A.trim", 0.65), 3);
      expect(run.engine.mixerState().masterLevel).toBeCloseTo(hardwareAppValue("master-level", 0.3), 3);
      await until(() => Math.abs(controller.valueOf("A.trim") - hardwareAppValue("A.trim", 0.65)) < 1e-3, "the screen to show TRIM A where the hardware is");
      // A quick turn: the screen and the engine follow it straight away.
      port.continuous(0xb0, 0x04, 0.8);
      expect(run.engine.mixerState().channels.A.trim).toBeCloseTo(hardwareAppValue("A.trim", 0.8), 3);
      expect(controller.snapshot().pickup["A.trim"]).toBeUndefined();
    } finally {
      detach();
    }
  });

  it("blocks Lesson 4 (Set the level) until TRIM A's MIDI reaches the hot set-up, then plays", { timeout: 30_000 }, async () => {
    const port = new MidiPort();
    const positions = new HardwarePositions();
    trackPositions(port, positions);
    for (const [status, cc, value] of [[0xb0, 0x13, 1], [0xb1, 0x13, 0], [0xb0, 0x04, 0.5], [0xb1, 0x04, 0.5]] as const) port.continuous(status, cc, value);
    const run = await harness("gain-staging", liveHardwareView(port, positions));
    const planned = practiceDecksFor(lessonDefinition("gain-staging"), run.track);
    run.session.preparePractice();
    await until(() => run.session.setUpPending() !== null, "the match step");
    // The knobs' travel is 0…1 for −1…1 on screen.
    port.continuous(0xb0, 0x04, ((planned.A.trim ?? 0) + 1) / 2);
    expect(run.session.setUpPending()?.items.filter((item) => item.state !== "matched").map((item) => item.label)).toEqual(["TRIM B"]);
    port.continuous(0xb1, 0x04, ((planned.B?.trim ?? 0) + 1) / 2);
    await until(() => run.engine.deckState("A").playing, "practice to play");
    expect(run.session.setUpPending()).toBeNull();
  });
});

describe("a set-up with no controller", () => {
  it("applies every value as planned, with no match step", { timeout: 30_000 }, async () => {
    const controller = new FakeController({ "A.channel-fader": 0.2, "A.trim": 0.9 });
    controller.connected = false;
    const run = await harness("gain-staging", controller);
    const planned = practiceDecksFor(lessonDefinition("gain-staging"), run.track);
    run.session.preparePractice();
    await until(() => run.engine.deckState("A").playing, "practice to play");
    expect(run.session.setUpPending()).toBeNull();
    const { channels } = run.engine.mixerState();
    expect(channels.A.trim).toBeCloseTo(planned.A.trim ?? Number.NaN, 9);
    expect(channels.B.trim).toBeCloseTo(planned.B?.trim ?? Number.NaN, 9);
    expect(channels.A["channel-fader"]).toBe(1);
  });
});
