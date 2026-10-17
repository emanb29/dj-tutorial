import { describe, expect, it } from "vitest";
import type { CommandInput, DeckId, EngineCommand, EngineDeckSnapshot, EngineMixerSnapshot, Result } from "@audio";
import { ALL_CONTROL_IDS, type ControlId } from "./control-ids.ts";
import { ControllerSession, WHEEL_GESTURE_END_MS, type ControllerEngine } from "./session.ts";

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
    syncOn: false,
    ...overrides,
  };
}

const CHANNEL = { trim: 0, "eq-low": 0, "eq-mid": 0, "eq-high": 0, filter: 0, "channel-fader": 1, cue: false };

/** Records commands; reports deck A playing when `playing.A` is set. */
function fakeEngine(options: { playing?: Partial<Record<DeckId, boolean>>; positionSec?: number } = {}) {
  const sent: Sent[] = [];
  const engine: ControllerEngine = {
    command(command: EngineCommand, input: CommandInput): Result {
      sent.push({ command, input });
      return { ok: true };
    },
    on: () => () => undefined,
    deckState: (deck) => deckSnapshot(deck, { playing: options.playing?.[deck] ?? false }),
    mixerState: () =>
      ({ crossfader: 0.5, masterLevel: 0, channels: { A: CHANNEL, B: CHANNEL }, cueMix: 0 }) satisfies EngineMixerSnapshot,
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
    expect(controller.keyDown(key("KeyQ"))).toBe(false);
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
  it("stores the playhead on an empty pad, then jumps there and plays on the next press", () => {
    const { engine, sent } = fakeEngine({ positionSec: 31.25 });
    const { session: controller } = session(engine);
    controller.keyDown(key("Digit2"));
    expect(sent).toEqual([]);
    expect(controller.snapshot().hotCues.A[1]).toBe(31.25);

    controller.keyDown(key("Digit2", { timeStamp: 500 }));
    expect(sent.map((entry) => entry.command)).toEqual([
      { control: "seek", deck: "A", value: 31.25 },
      { control: "play", deck: "A" },
    ]);
  });

  it("erases a hot cue with Shift", () => {
    const { engine } = fakeEngine();
    const { session: controller } = session(engine);
    controller.keyDown(key("Digit7"));
    controller.keyDown(key("Digit7", { shiftKey: true }));
    expect(controller.snapshot().hotCues.B[0]).toBeNull();
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

  it("jumps to a hot cue without playing when PLAY is locked (H2)", () => {
    const { engine, sent } = fakeEngine({ positionSec: 8 });
    const { session: controller } = session(engine, new Set<ControlId>(["A.hot-cue"]));
    controller.keyDown(key("Digit1"));
    controller.keyDown(key("Digit1"));
    expect(sent.map((entry) => entry.command)).toEqual([{ control: "seek", deck: "A", value: 8 }]);
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
    const { engine, sent } = fakeEngine();
    const jog = session(engine).session.beginJog("A", "trackpad");
    // 0.02 rad over 16 ms is 1.25 rad/s, a bend of 0.05; 0.04 rad is 0.1.
    jog?.turn(0.02, 0, { eventTimeMs: 100 });
    jog?.turn(0.02, 16, { eventTimeMs: 116 });
    jog?.turn(0.05, 4, { eventTimeMs: 120 });
    jog?.turn(0.04, 16, { eventTimeMs: 132 });
    expect(sent.map((entry) => entry.input.eventTimeMs)).toEqual([116, 132]);
  });

  it("always ends with bend 0 and gestureEnd, and is flushed by releaseAll", () => {
    const { engine, sent } = fakeEngine();
    const { session: controller } = session(engine);
    const jog = controller.beginJog("B", "mouse");
    jog?.turn(0.3, 16, { eventTimeMs: 16 });
    controller.releaseAll();
    expect(sent.at(-1)).toMatchObject({ command: { control: "jog-bend", deck: "B", value: 0 }, input: { gestureEnd: true } });
    jog?.end({ eventTimeMs: 40 });
    expect(sent).toHaveLength(2);
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
