import { describe, expect, it } from "vitest";
import type { CommandInput, DeckId, EngineCommand, EngineDeckSnapshot, EngineMixerSnapshot, Result } from "@audio";
import { ALL_CONTROL_IDS, type ControlId } from "./control-ids.ts";
import { ControllerSession, JOG_SEARCH_SEC_PER_RADIAN, KEY_BEND, KEY_BEND_FINE, WHEEL_GESTURE_END_MS, type ControllerEngine } from "./session.ts";

interface Sent {
  readonly command: EngineCommand;
  readonly input: CommandInput;
}

function deckSnapshot(deck: DeckId, overrides: Partial<EngineDeckSnapshot> = {}): EngineDeckSnapshot {
  return {
    deck,
    trackId: "loop",
    loading: false,
    playing: false,
    previewing: false,
    tempoFader: 0,
    tempoRangePercent: 10,
    tempoRate: 1,
    jogBend: 0,
    masterTempo: false,
    masterTempoAvailability: { available: true },
    cuePointSec: 0,
    hotCues: [null, null, null, null, null, null, null, null],
    loop: null,
    loopInSec: null,
    syncOn: false,
    ...overrides,
  };
}

const CHANNEL = { trim: 0, "eq-low": 0, "eq-mid": 0, "eq-high": 0, filter: 0, "channel-fader": 1, cue: false };

/** Records commands; reports deck A playing when `playing.A` is set. */
interface FakeEngineOptions {
  readonly playing?: Partial<Record<DeckId, boolean>>;
  readonly positionSec?: number;
  readonly hotCues?: Partial<Record<DeckId, readonly (number | null)[]>>;
  readonly looping?: Partial<Record<DeckId, boolean>>;
  readonly beatFx?: Partial<EngineMixerSnapshot["beatFx"]>;
  /** The engine's tapped Beat FX tempo (null = AUTO). */
  readonly beatFxBpm?: number | null;
}

function fakeEngine(options: FakeEngineOptions = {}) {
  const sent: Sent[] = [];
  const engine: ControllerEngine = {
    command(command: EngineCommand, input: CommandInput): Result {
      sent.push({ command, input });
      return { ok: true };
    },
    on: () => () => undefined,
    deckState: (deck) =>
      deckSnapshot(deck, {
        playing: options.playing?.[deck] ?? false,
        ...(options.hotCues?.[deck] === undefined ? {} : { hotCues: options.hotCues[deck] }),
        ...(options.looping?.[deck] === true ? { loop: { start: 1, end: 3 } } : {}),
      }),
    mixerState: () =>
      ({ crossfader: 0.5, masterLevel: 0, channels: { A: CHANNEL, B: CHANNEL }, cueMix: 0, headphoneLevel: 0.5, beatFxBpm: options.beatFxBpm ?? null, beatFx: { on: false, channel: "master", beats: 1, depth: 0.5, ...options.beatFx } }) satisfies EngineMixerSnapshot,
    playhead: () => ({ ok: true, ctx: 1, positionSec: options.positionSec ?? 12.5, beat: null, bar: null, beatInBar: null }),
    trackHistory: () => [],
  };
  return { engine, sent };
}

const everything: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS);

function session(engine: ControllerEngine, unlocks: ReadonlySet<ControlId> = everything, options: { macPlatform?: boolean } = {}) {
  const timers: (() => void)[] = [];
  const created = new ControllerSession(engine, {
    unlocks,
    macPlatform: options.macPlatform ?? false,
    schedule: (run) => {
      timers.push(run);
      return () => {
        timers.splice(timers.indexOf(run), 1);
      };
    },
  });
  return {
    session: created,
    fireTimers: () => {
      for (const run of timers.splice(0)) run();
    },
    pendingTimers: () => timers.length,
  };
}

const key = (code: string, extra: Partial<KeyboardEventLike> = {}): KeyboardEventLike => ({
  code,
  repeat: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  timeStamp: 100,
  ...extra,
});
type KeyboardEventLike = Parameters<ControllerSession["keyDown"]>[0];

describe("keyboard", () => {
  it("plays a paused deck and pauses a playing one, as keyboard input", () => {
    const paused = fakeEngine();
    session(paused.engine).session.keyDown(key("KeyX"));
    expect(paused.sent).toEqual([{ command: { control: "play", deck: "A" }, input: { device: "keyboard", eventTimeMs: 100, gestureEnd: true } }]);

    const playing = fakeEngine({ playing: { B: true } });
    session(playing.engine).session.keyDown(key("Comma"));
    expect(playing.sent.map((entry) => entry.command)).toEqual([{ control: "pause", deck: "B" }]);
  });

  it("holds deck CUE while the key is down and ends the gesture on release", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.keyDown(key("KeyZ", { timeStamp: 10 }));
    controller.keyUp(key("KeyZ", { timeStamp: 250 }));
    expect(sent).toEqual([
      { command: { control: "deck-cue", deck: "A", value: true }, input: { device: "keyboard", eventTimeMs: 10, gestureEnd: false } },
      { command: { control: "deck-cue", deck: "A", value: false }, input: { device: "keyboard", eventTimeMs: 250, gestureEnd: true } },
    ]);
  });

  it("ignores auto-repeat so a held key is one press", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.keyDown(key("KeyZ"));
    controller.keyDown(key("KeyZ", { repeat: true }));
    expect(sent).toHaveLength(1);
  });

  it("snaps a channel fader shut and open with the cut keys", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.keyDown(key("KeyL"));
    controller.keyDown(key("KeyO"));
    expect(sent.map((entry) => [entry.command, entry.input.gestureEnd])).toEqual([
      [{ control: "channel-fader", deck: "B", value: 0 }, true],
      [{ control: "channel-fader", deck: "B", value: 1 }, true],
    ]);
  });

  it("records a tap", () => {
    const { engine, sent } = fakeEngine();
    session(engine).session.keyDown(key("Space"));
    expect(sent.map((entry) => entry.command)).toEqual([{ control: "tap" }]);
  });

  it("says which keys it handled, so the page can stop the browser's default", () => {
    const { engine } = fakeEngine();
    const { session: controller } = session(engine);
    expect(controller.keyDown(key("Space"))).toBe(true);
    expect(controller.keyDown(key("KeyK"))).toBe(false);
  });

  it("ignores keys for locked controls", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine, new Set<ControlId>(["A.play"]));
    controller.keyDown(key("Comma"));
    controller.keyDown(key("KeyS"));
    controller.keyDown(key("Space"));
    expect(sent).toEqual([]);
    controller.keyDown(key("KeyX"));
    expect(sent).toHaveLength(1);
  });
});

describe("hot cues", () => {
  it("sets an empty pad in the engine at the press, timed from the key", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.keyDown(key("Digit2", { timeStamp: 250 }));
    expect(sent).toEqual([{ command: { control: "hot-cue-set", deck: "A", slot: 1 }, input: { device: "keyboard", eventTimeMs: 250, gestureEnd: true } }]);
  });

  it("triggers a set pad (the engine jumps and plays), and clears it with Shift", () => {
    const { engine, sent } = fakeEngine({ hotCues: { B: [12, null, null, null, null, null, null, null] } });
    const { session: controller } = session(engine);
    controller.keyDown(key("Digit7"));
    controller.keyUp(key("Digit7"));
    controller.keyDown(key("Digit7", { shiftKey: true }));
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "hot-cue", deck: "B", slot: 0 },
      { control: "hot-cue-clear", deck: "B", slot: 0 },
    ]);
  });
});

describe("loops and Beat FX", () => {
  it("LOOP IN and LOOP OUT; ½X and 2X on the CUE/LOOP CALL keys after the hot cues", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    for (const code of ["KeyD", "KeyF", "Digit5", "Digit6", "KeyY", "KeyU", "Minus", "Equal"] as const) {
      controller.keyDown(key(code));
      controller.keyUp(key(code));
    }
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "loop-in", deck: "A" },
      { control: "loop-out", deck: "A" },
      { control: "loop-halve", deck: "A" },
      { control: "loop-double", deck: "A" },
      { control: "loop-in", deck: "B" },
      { control: "loop-out", deck: "B" },
      { control: "loop-halve", deck: "B" },
      { control: "loop-double", deck: "B" },
    ]);
  });

  it("Shift on a loop key is the FLX4's SHIFT layer (IN ADJ, OUT ADJ, cue delete, memory): not yet", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    for (const [code, control] of [
      ["KeyD", "A.loop-in"],
      ["KeyF", "A.loop-out"],
      ["Digit5", "A.loop-halve"],
      ["Equal", "B.loop-double"],
    ] as const) {
      expect(controller.keyDown(key(code, { shiftKey: true }))).toBe(true);
      controller.keyUp(key(code));
      expect(controller.snapshot().notYet).toBe(control);
    }
    // SHIFT held on screen does the same for the on-screen buttons.
    controller.setShift("B", true);
    controller.loopCall("B", -1, false, { device: "mouse", eventTimeMs: 1 });
    expect(controller.snapshot().notYet).toBe("B.loop-halve");
    expect(sent).toEqual([]);
  });

  it("½X and 2X do nothing while the loop Lesson has not unlocked them", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine, new Set<ControlId>(["A.loop-in", "A.loop-out", "A.loop-exit"]));
    expect(controller.keyDown(key("Digit5"))).toBe(false);
    controller.loopCall("A", 1, false, { device: "mouse", eventTimeMs: 1 });
    expect(sent).toEqual([]);
  });

  it("4 BEAT/EXIT starts a 4-beat loop, or exits the one playing", () => {
    const { engine, sent } = fakeEngine({ looping: { B: true } });
    const { session: controller } = session(engine);
    controller.keyDown(key("KeyG"));
    controller.keyDown(key("KeyJ"));
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "loop-auto", deck: "A", value: 4 },
      { control: "loop-exit", deck: "B" },
    ]);
  });

  it("toggles Beat FX, steps BEAT ◀/▶ and cycles CH SELECT", () => {
    const { engine, sent } = fakeEngine({ beatFx: { on: true, beats: 1, channel: "B" } });
    const { session: controller } = session(engine);
    controller.keyDown(key("KeyV"));
    controller.keyDown(key("BracketRight"));
    controller.keyDown(key("BracketLeft"));
    controller.beatFxChannelNext({ device: "touch" });
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "beat-fx", value: false },
      { control: "beat-fx-beats", value: 2 },
      { control: "beat-fx-beats", value: 0.75 },
      { control: "beat-fx-channel", value: "master" },
    ]);
  });

  it("Shift + ] taps the Beat FX tempo (from the 4th tap), Shift + [ goes back to AUTO", () => {
    const { engine, sent } = fakeEngine({ beatFxBpm: 125 });
    const { session: controller } = session(engine);
    for (const time of [1000, 1480, 1960, 2440]) {
      controller.keyDown(key("BracketRight", { shiftKey: true, timeStamp: time }));
      controller.keyUp(key("BracketRight"));
    }
    controller.keyDown(key("BracketLeft", { shiftKey: true }));
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "beat-fx-bpm", value: 125 },
      { control: "beat-fx-bpm", value: null },
    ]);
  });

  it("the on-screen BEAT ▶ with SHIFT taps the beat (and the Beat FX tempo), as printed on the FLX4", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.beatButton(1, { device: "mouse" });
    controller.setShift("B", true);
    controller.beatButton(1, { device: "mouse" });
    controller.beatButton(-1, { device: "mouse" });
    expect(sent.map((entry) => entry.command)).toEqual([{ control: "beat-fx-beats", value: 2 }, { control: "tap" }]);
  });

  it("while Beat FX is locked and TAP is open, either on-screen BEAT button taps the beat", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine, new Set<ControlId>(["tap"]));
    controller.beatButton(-1, { device: "touch" });
    controller.beatButton(1, { device: "touch" });
    expect(sent.map((entry) => entry.command)).toEqual([{ control: "tap" }, { control: "tap" }]);
  });

  it("leaves loop and Beat FX keys to the browser while their controls are locked", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine, new Set<ControlId>(["A.play"]));
    expect(controller.keyDown(key("KeyD"))).toBe(false);
    expect(controller.keyDown(key("KeyV"))).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("drag gestures", () => {
  it("sends values while dragging and the final value with gestureEnd on release", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    const drag = controller.beginDrag("A.channel-fader", "mouse");
    drag?.move(-60, { fine: false, eventTimeMs: 1 });
    drag?.move(-120, { fine: false, eventTimeMs: 2 });
    drag?.end({ eventTimeMs: 3 });
    expect(sent).toEqual([
      { command: { control: "channel-fader", deck: "A", value: 0.75 }, input: { device: "mouse", eventTimeMs: 1, gestureEnd: false } },
      { command: { control: "channel-fader", deck: "A", value: 0.5 }, input: { device: "mouse", eventTimeMs: 2, gestureEnd: false } },
      { command: { control: "channel-fader", deck: "A", value: 0.5 }, input: { device: "mouse", eventTimeMs: 3, gestureEnd: true } },
    ]);
  });

  it("switches to fine adjust mid-drag from where the control is, without a jump", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    const drag = controller.beginDrag("A.channel-fader", "touch", { fullTravelPx: 100 });
    drag?.move(-20, { fine: false, eventTimeMs: 1 });
    drag?.move(-20, { fine: true, eventTimeMs: 2 });
    drag?.move(-70, { fine: true, eventTimeMs: 3 });
    drag?.move(-80, { fine: false, eventTimeMs: 4 });
    drag?.move(-90, { fine: false, eventTimeMs: 5 });
    const values = sent.map((entry) => ("value" in entry.command ? entry.command.value : null));
    // 20 px of full travel (0.2), then 50 px at a fifth (0.1), then 10 px at full travel again (0.1);
    // a switch alone moves nothing.
    expect(values[0]).toBeCloseTo(0.8);
    expect(values[1]).toBeCloseTo(0.7);
    expect(values[2]).toBeCloseTo(0.6);
    expect(values).toHaveLength(3);
  });

  it("sweeps a fader end to end over the track length it is given", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    const drag = controller.beginDrag("A.channel-fader", "touch", { fullTravelPx: 120 });
    drag?.move(-60, { fine: false, eventTimeMs: 1 });
    drag?.move(-120, { fine: false, eventTimeMs: 2 });
    drag?.end({ eventTimeMs: 3 });
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "channel-fader", deck: "A", value: 0.5 },
      { control: "channel-fader", deck: "A", value: 0 },
      { control: "channel-fader", deck: "A", value: 0 },
    ]);
  });

  it("sends nothing for a click that never moved", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.beginDrag("A.trim", "trackpad")?.end({ eventTimeMs: 3 });
    expect(sent).toEqual([]);
  });

  it("refuses to start a drag on a locked control", () => {
    const { engine } = fakeEngine();
    expect(session(engine, new Set()).session.beginDrag("A.trim", "mouse")).toBeNull();
  });

  it("resets to the control's rest value as one finished gesture", () => {
    const { engine, sent } = fakeEngine();
    session(engine).session.reset("crossfader", { device: "mouse", eventTimeMs: 9 });
    expect(sent).toEqual([{ command: { control: "crossfader", value: 0.5 }, input: { device: "mouse", eventTimeMs: 9, gestureEnd: true } }]);
  });
});

describe("wheel gestures", () => {
  it("moves on each wheel event and ends the gesture once scrolling stops", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller, fireTimers } = session(engine);
    const fingersUp = { deltaX: 0, deltaY: 6.5, deltaMode: 0 };
    controller.wheel("A.trim", fingersUp, { fine: false, eventTimeMs: 1 });
    controller.wheel("A.trim", fingersUp, { fine: false, eventTimeMs: 2 });
    expect(sent.every((entry) => entry.input.device === "trackpad" && entry.input.gestureEnd === false)).toBe(true);
    fireTimers();
    expect(sent).toHaveLength(3);
    expect(sent[2]?.input.gestureEnd).toBe(true);
    expect(sent[2]?.command).toEqual(sent[1]?.command);
    expect(WHEEL_GESTURE_END_MS).toBeGreaterThan(50);
  });
});

describe("keyboard nudges on a focused control", () => {
  it("sends each nudge as a finished gesture", () => {
    const { engine, sent } = fakeEngine();
    const handled = session(engine).session.nudge("A.channel-fader", "ArrowDown", { fine: false, eventTimeMs: 4 });
    expect(handled).toBe(true);
    expect(sent).toEqual([
      { command: { control: "channel-fader", deck: "A", value: 0.98 }, input: { device: "keyboard", eventTimeMs: 4, gestureEnd: true } },
    ]);
  });
});

describe("review fixes: locks", () => {
  it("does not claim a key whose control is locked, so the browser keeps it (H1)", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine, new Set<ControlId>());
    expect(controller.keyDown(key("Space"))).toBe(false);
    expect(controller.keyUp(key("Space"))).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends one trigger for a set pad, even with PLAY locked: on the FLX4 a hot cue jumps and plays", () => {
    const { engine, sent } = fakeEngine({ hotCues: { A: [8, null, null, null, null, null, null, null] } });
    const { session: controller } = session(engine, new Set<ControlId>(["A.hot-cue"]));
    controller.keyDown(key("Digit1"));
    expect(sent.map((entry) => entry.command)).toEqual([{ control: "hot-cue", deck: "A", slot: 0 }]);
  });

  it("still finishes a drag with gestureEnd when the control locks mid-drag", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    const drag = controller.beginDrag("A.trim", "mouse");
    drag?.move(24, { fine: false, eventTimeMs: 1 });
    controller.setUnlocks(new Set());
    drag?.end({ eventTimeMs: 2 });
    expect(sent.filter((entry) => entry.input.gestureEnd)).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ command: { control: "trim", deck: "A" }, input: { gestureEnd: true } });
  });
});

describe("review fixes: nothing stays held (H3)", () => {
  it("releases a CUE held from the keyboard when everything is released (blur, hidden tab)", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.keyDown(key("KeyM"));
    controller.releaseAll();
    expect(sent.at(-1)).toMatchObject({ command: { control: "deck-cue", deck: "B", value: false }, input: { gestureEnd: true } });
    controller.keyUp(key("KeyM"));
    expect(sent).toHaveLength(2);
  });

  it("releases a held CUE exactly once when its control locks mid-hold", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    controller.deckCue("A", true, { device: "trackpad", eventTimeMs: 1 });
    controller.setUnlocks(new Set());
    controller.deckCue("A", false, { device: "trackpad", eventTimeMs: 2 });
    expect(sent.map((entry) => [entry.command, entry.input.gestureEnd])).toEqual([
      [{ control: "deck-cue", deck: "A", value: true }, false],
      [{ control: "deck-cue", deck: "A", value: false }, true],
    ]);
  });

  it("releases SHIFT", () => {
    const { engine } = fakeEngine();
    const { session: controller } = session(engine);
    controller.setShift("A", true);
    controller.releaseAll();
    expect(controller.snapshot().shiftHeld.A).toBe(false);
  });

  it("flushes an open drag and a pending wheel end when disconnected (M2)", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller, pendingTimers } = session(engine);
    const disconnect = controller.connect();
    const drag = controller.beginDrag("B.channel-fader", "mouse");
    drag?.move(-24, { fine: false, eventTimeMs: 1 });
    controller.wheel("A.trim", { deltaX: 0, deltaY: 6.5, deltaMode: 0 }, { fine: false, eventTimeMs: 2 });
    disconnect();
    const ends = sent.filter((entry) => entry.input.gestureEnd).map((entry) => entry.command.control);
    expect(ends.sort()).toEqual(["channel-fader", "trim"]);
    expect(pendingTimers()).toBe(0);
    drag?.end({ eventTimeMs: 3 });
    expect(sent.filter((entry) => entry.input.gestureEnd)).toHaveLength(2);
  });
});

describe("review fixes: jog wheel (M4, M2)", () => {
  it("ignores coalesced moves with no elapsed time and sends at most one bend per 16 ms", () => {
    const { engine, sent } = fakeEngine({ playing: { A: true } });
    const jog = session(engine).session.beginJog("A", "trackpad");
    // 0.02 rad over 16 ms is 1.25 rad/s, a bend of 0.05; 0.04 rad is 0.1.
    jog?.turn(0.02, 0, { eventTimeMs: 100 });
    jog?.turn(0.02, 16, { eventTimeMs: 116 });
    jog?.turn(0.05, 4, { eventTimeMs: 120 });
    jog?.turn(0.04, 16, { eventTimeMs: 132 });
    expect(sent.map((entry) => entry.input.eventTimeMs)).toEqual([116, 132]);
  });

  it("always ends with bend 0 and gestureEnd, and is flushed by releaseAll", () => {
    const { engine, sent } = fakeEngine({ playing: { B: true } });
    const { session: controller } = session(engine);
    const jog = controller.beginJog("B", "mouse");
    jog?.turn(0.3, 16, { eventTimeMs: 16 });
    controller.releaseAll();
    expect(sent.at(-1)).toMatchObject({ command: { control: "jog-bend", deck: "B", value: 0 }, input: { gestureEnd: true } });
    jog?.end({ eventTimeMs: 40 });
    expect(sent).toHaveLength(2);
  });
});

describe("nudge keys: a held arrow (B) or Q/E (A) bends a playing deck, like a jog nudge", () => {
  const bends = (sent: readonly Sent[]) => sent.map((entry) => [entry.command, entry.input.gestureEnd, entry.input.eventTimeMs]);

  it("bends B faster while → is held and releases the bend with the key", () => {
    const { engine, sent } = fakeEngine({ playing: { B: true } });
    const { session: controller } = session(engine);
    expect(controller.keyDown(key("ArrowRight", { timeStamp: 10 }))).toBe(true);
    controller.keyDown(key("ArrowRight", { timeStamp: 40, repeat: true }));
    expect(controller.keyUp(key("ArrowRight", { timeStamp: 300 }))).toBe(true);
    expect(bends(sent)).toEqual([
      [{ control: "jog-bend", deck: "B", value: KEY_BEND }, false, 10],
      [{ control: "jog-bend", deck: "B", value: 0 }, true, 300],
    ]);
  });

  it("bends slower with ←, and A with Q and E; Shift is the fine bend", () => {
    const { engine, sent } = fakeEngine({ playing: { A: true, B: true } });
    const { session: controller } = session(engine);
    controller.keyDown(key("ArrowLeft", { shiftKey: true }));
    controller.keyUp(key("ArrowLeft"));
    controller.keyDown(key("KeyQ"));
    controller.keyUp(key("KeyQ"));
    controller.keyDown(key("KeyE"));
    expect(sent.filter((entry) => entry.input.gestureEnd === false).map((entry) => entry.command)).toEqual([
      { control: "jog-bend", deck: "B", value: -KEY_BEND_FINE },
      { control: "jog-bend", deck: "A", value: -KEY_BEND },
      { control: "jog-bend", deck: "A", value: KEY_BEND },
    ]);
  });

  it("does nothing on a paused deck or before the nudge-phase Lesson unlocks the bend", () => {
    const paused = fakeEngine();
    const { session: idle } = session(paused.engine);
    idle.keyDown(key("ArrowRight"));
    idle.keyUp(key("ArrowRight"));
    expect(paused.sent).toEqual([]);

    const playing = fakeEngine({ playing: { B: true } });
    const { session: locked } = session(playing.engine, new Set<ControlId>(["B.jog"]));
    expect(locked.keyDown(key("ArrowRight"))).toBe(false);
    expect(playing.sent).toEqual([]);
  });

  it("lets go of a held nudge when the page loses focus", () => {
    const { engine, sent } = fakeEngine({ playing: { B: true } });
    const { session: controller } = session(engine);
    controller.keyDown(key("ArrowLeft"));
    controller.releaseAll();
    expect(sent.at(-1)).toMatchObject({ command: { control: "jog-bend", deck: "B", value: 0 }, input: { gestureEnd: true } });
  });
});

describe("jog wheel on a paused deck: search, not pitch bend", () => {
  const searched = (sent: readonly Sent[]) =>
    sent.filter((entry) => entry.command.control === "jog-search").reduce((sum, entry) => sum + (entry.command as { value: number }).value, 0);

  it("turns the platter into a playhead search, in proportion to the angle turned", () => {
    const { engine, sent } = fakeEngine();
    const jog = session(engine).session.beginJog("A", "trackpad");
    jog?.turn(1, 16, { eventTimeMs: 16 });
    jog?.turn(-0.5, 16, { eventTimeMs: 32 });
    jog?.end({ eventTimeMs: 40 });
    expect(sent.every((entry) => entry.command.control === "jog-search")).toBe(true);
    expect(searched(sent)).toBeCloseTo(0.5 * JOG_SEARCH_SEC_PER_RADIAN, 9);
  });

  it("never loses search distance to throttling: fast moves are summed and sent by the end", () => {
    const { engine, sent } = fakeEngine();
    const jog = session(engine).session.beginJog("A", "trackpad");
    for (let index = 1; index <= 10; index++) jog?.turn(0.1, 2, { eventTimeMs: index * 2 });
    jog?.end({ eventTimeMs: 30 });
    expect(sent.length).toBeLessThan(10);
    expect(searched(sent)).toBeCloseTo(1 * JOG_SEARCH_SEC_PER_RADIAN, 9);
    expect(sent.at(-1)?.input.gestureEnd).toBe(true);
  });

  it("searches even with zero elapsed time (search does not need a speed)", () => {
    const { engine, sent } = fakeEngine();
    const jog = session(engine).session.beginJog("A", "trackpad");
    jog?.turn(0.2, 0, { eventTimeMs: 5 });
    jog?.end({ eventTimeMs: 6 });
    expect(searched(sent)).toBeCloseTo(0.2 * JOG_SEARCH_SEC_PER_RADIAN, 9);
  });

  it("bends a playing deck only once its pitch-bend part is unlocked (the nudge-phase Lesson)", () => {
    const { engine, sent } = fakeEngine({ playing: { A: true } });
    const searchOnly = new Set<ControlId>(["A.jog"]);
    const jog = session(engine, searchOnly).session.beginJog("A", "trackpad");
    jog?.turn(0.3, 16, { eventTimeMs: 16 });
    jog?.end({ eventTimeMs: 40 });
    expect(sent).toEqual([]);
  });
});

describe("headphone LEVEL", () => {
  it("reads and sets the engine's headphone level", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    expect(controller.valueOf("headphone-level")).toBe(0.5);
    controller.setValue("headphone-level", 0.8, { device: "mouse" });
    expect(sent.map((entry) => entry.command)).toEqual([{ control: "headphone-level", value: 0.8 }]);
  });
});

describe("review fixes: scroll direction follows the platform, not the device label (M1)", () => {
  const valueSent = (sent: readonly Sent[]) => (sent[0]?.command as { value: number } | undefined)?.value ?? Number.NaN;

  it("treats a Mac's wheel as natural scrolling even when it looks like a mouse", () => {
    const { engine, sent } = fakeEngine();
    session(engine, everything, { macPlatform: true }).session.wheel("A.trim", { deltaX: 0, deltaY: 120, deltaMode: 0 }, { fine: false, eventTimeMs: 1 });
    expect(sent[0]?.input.device).toBe("mouse");
    expect(valueSent(sent)).toBeGreaterThan(0);
  });

  it("treats other platforms' wheels as classic scrolling", () => {
    const { engine, sent } = fakeEngine();
    session(engine).session.wheel("A.trim", { deltaX: 0, deltaY: 120, deltaMode: 0 }, { fine: false, eventTimeMs: 1 });
    expect(valueSent(sent)).toBeLessThan(0);
  });
});
