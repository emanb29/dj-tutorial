import { describe, expect, it } from "vitest";
import type { CommandInput, DeckId, EngineCommand, EngineDeckSnapshot, EngineEvents, EngineMixerSnapshot, Result } from "@audio";
import type { MidiMessage } from "@midi";
import { ALL_CONTROL_IDS, type ControlId } from "./control-ids.ts";
import { HARDWARE_JOG, HardwareBridge, type HardwareBridgeOptions, type HardwarePort } from "./hardware.ts";
import { ControllerSession, HARDWARE_SETTLE_MS, NOT_YET_MS, type ControllerEngine } from "./session.ts";

interface Sent {
  readonly command: EngineCommand;
  readonly input: CommandInput;
}

/** A small engine with state: values and play state follow accepted commands, as the real one's do. */
function statefulEngine() {
  const sent: Sent[] = [];
  const listeners: { [K in keyof EngineEvents]?: ((payload: EngineEvents[K]) => void)[] } = {};
  const channel = () => ({ trim: 0, "eq-low": 0, "eq-mid": 0, "eq-high": 0, filter: 0, "channel-fader": 0, cue: false });
  const mixer = { crossfader: 0.5, masterLevel: 0, channels: { A: channel(), B: channel() }, cueMix: 0, headphoneLevel: 0.5 };
  const decks: Record<DeckId, EngineDeckSnapshot> = {
    A: deck("A"),
    B: deck("B"),
  };
  const emit = <K extends keyof EngineEvents>(name: K, payload: EngineEvents[K]) => {
    for (const listener of listeners[name] ?? []) listener(payload);
  };
  const engine: ControllerEngine = {
    command(command: EngineCommand, input: CommandInput): Result {
      sent.push({ command, input });
      if (command.control === "play" || command.control === "pause") {
        decks[command.deck] = { ...decks[command.deck], playing: command.control === "play" };
        emit("deck", decks[command.deck]);
      } else if (command.control === "sync") {
        decks[command.deck] = { ...decks[command.deck], syncOn: command.value };
        emit("deck", decks[command.deck]);
      } else if (command.control === "master-tempo") {
        decks[command.deck] = { ...decks[command.deck], masterTempo: command.value };
        emit("deck", decks[command.deck]);
      } else if (command.control === "tempo") {
        decks[command.deck] = { ...decks[command.deck], tempoFader: command.value };
        emit("deck", decks[command.deck]);
      } else if (command.control === "headphone-cue") {
        mixer.channels[command.deck].cue = command.value;
      } else if (command.control === "crossfader") mixer.crossfader = command.value;
      else if (command.control === "cue-mix") mixer.cueMix = command.value;
      else if (command.control === "master-level") mixer.masterLevel = command.value;
      else if ("deck" in command && "value" in command && typeof command.value === "number" && command.control in mixer.channels[command.deck]) {
        (mixer.channels[command.deck] as unknown as Record<string, number>)[command.control] = command.value;
      }
      emit("command", { command, device: input.device, heardCtx: 1, appliedCtx: 1, gestureEnd: input.gestureEnd ?? false, rejected: null });
      return { ok: true };
    },
    on: (name, listener) => {
      const list = (listeners[name] ??= []) as ((payload: unknown) => void)[];
      list.push(listener as (payload: unknown) => void);
      return () => {
        list.splice(list.indexOf(listener as (payload: unknown) => void), 1);
      };
    },
    deckState: (id) => decks[id],
    mixerState: () => structuredClone(mixer) satisfies EngineMixerSnapshot,
    playhead: () => ({ ok: true, ctx: 1, positionSec: 12.5, beat: null, bar: null, beatInBar: null }),
    trackHistory: () => [],
  };
  return { engine, sent, emit };
}

function deck(id: DeckId): EngineDeckSnapshot {
  return {
    deck: id,
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
  };
}

class FakePort implements HardwarePort {
  connected = true;
  readonly out: number[][] = [];
  private readonly messageListeners = new Set<(message: MidiMessage) => void>();
  private readonly statusListeners = new Set<() => void>();

  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribe(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send(messages: readonly (readonly number[])[]): boolean {
    if (!this.connected) return false;
    this.out.push(...messages.map((message) => [...message]));
    return true;
  }

  midi(bytes: number[], timeStamp = 1000): void {
    for (const listener of this.messageListeners) listener({ data: new Uint8Array(bytes), timeStamp });
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const listener of this.statusListeners) listener();
  }
}

const everything: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS);

function rig(unlocks: ReadonlySet<ControlId> = everything, options: Pick<HardwareBridgeOptions, "tapJudged" | "publishTap"> = {}) {
  const { engine, sent, emit } = statefulEngine();
  let timers: { run: () => void; delayMs: number }[] = [];
  const schedule = (run: () => void, delayMs: number) => {
    const timer = { run, delayMs };
    timers.push(timer);
    return () => {
      timers = timers.filter((candidate) => candidate !== timer);
    };
  };
  const session = new ControllerSession(engine, { unlocks, macPlatform: true, schedule });
  const stopSession = session.connect();
  const port = new FakePort();
  const keys: string[] = [];
  const bridge = new HardwareBridge(session, engine, port, {
    schedule,
    lessonKey: (code) => keys.push(code),
    tapJudged: options.tapJudged ?? (() => () => undefined),
    publishTap: options.publishTap ?? (() => undefined),
  });
  const detach = bridge.attach();
  return {
    session,
    sent,
    port,
    keys,
    emit,
    detach: () => {
      detach();
      stopSession();
    },
    fire: (delayMs?: number) => {
      const due = timers.filter((timer) => delayMs === undefined || timer.delayMs === delayMs);
      timers = timers.filter((timer) => !due.includes(timer));
      for (const timer of due) timer.run();
    },
  };
}

const fourteenBit = (status: number, cc: number, value01: number): number[][] => {
  const raw = Math.round(value01 * 16383);
  return [
    [status, cc, raw >> 7],
    [status, cc + 0x20, raw & 0x7f],
  ];
};
const commands = (sent: readonly Sent[]) => sent.map((entry) => entry.command);

describe("buttons go through the session as midi input, at the message's time", () => {
  it("PLAY plays and pauses deck A with device midi and the MIDI timestamp", () => {
    const { port, sent } = rig();
    port.midi([0x90, 0x0b, 0x7f], 1234.5);
    port.midi([0x90, 0x0b, 0x00], 1300);
    port.midi([0x90, 0x0b, 0x7f], 2000);
    expect(sent).toEqual([
      { command: { control: "play", deck: "A" }, input: { device: "midi", eventTimeMs: 1234.5, gestureEnd: true } },
      { command: { control: "pause", deck: "A" }, input: { device: "midi", eventTimeMs: 2000, gestureEnd: true } },
    ]);
  });

  it("CUE holds while the button is down", () => {
    const { port, sent } = rig();
    port.midi([0x91, 0x0c, 0x7f], 100);
    port.midi([0x91, 0x0c, 0x00], 400);
    expect(sent.map((entry) => [entry.command, entry.input.eventTimeMs])).toEqual([
      [{ control: "deck-cue", deck: "B", value: true }, 100],
      [{ control: "deck-cue", deck: "B", value: false }, 400],
    ]);
  });

  it("BEAT SYNC toggles SYNC; its long press toggles MASTER TEMPO; SHIFT + it cycles the tempo range", () => {
    const { port, sent } = rig();
    port.midi([0x90, 0x58, 0x7f]);
    port.midi([0x90, 0x58, 0x00]);
    port.midi([0x90, 0x5c, 0x7f]);
    port.midi([0x90, 0x60, 0x7f]);
    expect(commands(sent)).toEqual([
      { control: "sync", deck: "A", value: true },
      { control: "master-tempo", deck: "A", value: true },
      { control: "tempo-range", deck: "A", value: 16 },
    ]);
  });

  it("channel CUE toggles the headphone cue", () => {
    const { port, sent } = rig();
    port.midi([0x91, 0x54, 0x7f]);
    port.midi([0x91, 0x54, 0x00]);
    port.midi([0x91, 0x54, 0x7f]);
    expect(commands(sent)).toEqual([
      { control: "headphone-cue", deck: "B", value: true },
      { control: "headphone-cue", deck: "B", value: false },
    ]);
  });

  it("SHIFT is held on the deck while the button is", () => {
    const { port, session } = rig();
    port.midi([0x91, 0x3f, 0x7f]);
    expect(session.snapshot().shiftHeld.B).toBe(true);
    port.midi([0x91, 0x3f, 0x00]);
    expect(session.snapshot().shiftHeld.B).toBe(false);
  });

  it("the BROWSE press is TAP", () => {
    const { port, sent } = rig();
    port.midi([0x96, 0x41, 0x7f], 777);
    expect(sent).toEqual([{ command: { control: "tap" }, input: { device: "midi", eventTimeMs: 777, gestureEnd: true } }]);
  });

  it("HOT CUE pads store and trigger hot cues; SHIFT + pad erases", () => {
    const { port, session, sent } = rig();
    port.midi([0x97, 0x02, 0x7f]);
    expect(session.snapshot().hotCues.A[2]).toBe(12.5);
    port.midi([0x97, 0x02, 0x7f]);
    expect(commands(sent)).toEqual([
      { control: "seek", deck: "A", value: 12.5 },
      { control: "play", deck: "A" },
    ]);
    port.midi([0x98, 0x02, 0x7f]);
    expect(session.snapshot().hotCues.A[2]).toBeNull();
  });
});

describe("TAP borrows the controls a Learner has not been handed yet", () => {
  // Lesson 2 (beats-and-bars): TAP is unlocked, the pads and Beat FX are not.
  const lesson2 = new Set<ControlId>(["tap", "A.play", "A.channel-fader"]);
  const tapAt = (eventTimeMs: number) => ({ command: { control: "tap" }, input: { device: "midi", eventTimeMs, gestureEnd: true } });

  it("any performance pad, on either deck, in any pad mode, with or without SHIFT, is TAP while the pads are locked", () => {
    const { port, sent, session } = rig(lesson2);
    port.midi([0x97, 0x00, 0x7f], 501);
    port.midi([0x97, 0x00, 0x00], 502);
    port.midi([0x99, 0x07, 0x7f], 503);
    port.midi([0x98, 0x03, 0x7f], 504);
    port.midi([0x97, 0x32, 0x7f], 505);
    expect(sent).toEqual([tapAt(501), tapAt(503), tapAt(504), tapAt(505)]);
    expect(session.snapshot().notYet).toBeNull();
  });

  it("pads are hot cues, not TAP, once the pads are unlocked", () => {
    const { port, sent } = rig(new Set<ControlId>([...lesson2, "A.hot-cue", "B.hot-cue"]));
    port.midi([0x97, 0x02, 0x7f]);
    port.midi([0x97, 0x02, 0x7f]);
    expect(commands(sent).map((command) => command.control)).toEqual(["seek", "play"]);
  });

  it("BEAT ◀ and BEAT ▶ (TAP printed under it), with or without SHIFT, are TAP while Beat FX is locked", () => {
    const { port, sent } = rig(lesson2);
    port.midi([0x94, 0x4b, 0x7f], 601);
    port.midi([0x94, 0x4b, 0x00], 602);
    port.midi([0x94, 0x6b, 0x7f], 603);
    port.midi([0x94, 0x4a, 0x7f], 604);
    port.midi([0x94, 0x66, 0x7f], 605);
    expect(sent).toEqual([tapAt(601), tapAt(603), tapAt(604), tapAt(605)]);
  });

  it("plain BEAT ◀ / ▶ do not tap once Beat FX's beat buttons are unlocked; SHIFT + BEAT ▶ (the panel's TAP) still does", () => {
    const { port, sent } = rig(new Set<ControlId>([...lesson2, "beat-fx-beat" as string as ControlId]));
    port.midi([0x94, 0x4b, 0x7f]);
    port.midi([0x94, 0x4a, 0x7f]);
    port.midi([0x94, 0x66, 0x7f]);
    expect(sent).toEqual([]);
    port.midi([0x94, 0x6b, 0x7f], 701);
    expect(sent).toEqual([tapAt(701)]);
  });

  it("BEAT SYNC is never TAP", () => {
    const { port, sent } = rig(lesson2);
    port.midi([0x90, 0x58, 0x7f]);
    expect(sent).toEqual([]);
  });

  it("borrowed pads stay lit, and the pad tapped blinks when the Lesson judges that tap on the beat", () => {
    let judged: ((onBeat: boolean) => void) | null = null;
    const { port, fire } = rig(lesson2, {
      tapJudged: (listener) => {
        judged = listener;
        return () => undefined;
      },
    });
    const padLed = (status: number, note: number) => port.out.filter((message) => message[0] === status && message[1] === note).at(-1)?.[2];
    expect(padLed(0x97, 0x05)).toBe(0x7f);
    expect(padLed(0x99, 0x00)).toBe(0x7f);
    port.midi([0x97, 0x05, 0x7f]);
    (judged as ((onBeat: boolean) => void) | null)?.(false);
    expect(padLed(0x97, 0x05)).toBe(0x7f);
    port.midi([0x97, 0x05, 0x7f]);
    (judged as ((onBeat: boolean) => void) | null)?.(true);
    expect(padLed(0x97, 0x05)).toBe(0);
    fire();
    expect(padLed(0x97, 0x05)).toBe(0x7f);
  });

  it("names the hardware TAP for captions: the panel's TAP and the pads, then the TAP alone; nothing without a controller or TAP", () => {
    const names: (string | null)[] = [];
    const { session, port } = rig(lesson2, { publishTap: (name) => names.push(name) });
    expect(names.at(-1)).toBe("SHIFT + BEAT ▶ (TAP), any pad");
    session.setUnlocks(new Set<ControlId>([...lesson2, "A.hot-cue", "B.hot-cue"]));
    expect(names.at(-1)).toBe("SHIFT + BEAT ▶ (TAP)");
    session.setUnlocks(new Set<ControlId>(["A.play"]));
    expect(names.at(-1)).toBeNull();
    session.setUnlocks(lesson2);
    port.setConnected(false);
    expect(names.at(-1)).toBeNull();
  });
});

describe("Lesson keys from the hardware", () => {
  it("LOAD is Enter, SHIFT + LOAD is P, SHIFT + BROWSE press is R", () => {
    const { port, keys, sent } = rig();
    port.midi([0x96, 0x46, 0x7f]);
    port.midi([0x96, 0x46, 0x00]);
    port.midi([0x96, 0x47, 0x7f]);
    port.midi([0x96, 0x68, 0x7f]);
    port.midi([0x96, 0x42, 0x7f]);
    expect(keys).toEqual(["Enter", "Enter", "KeyP", "KeyR"]);
    expect(sent).toEqual([]);
  });
});

describe("locks", () => {
  it("a locked button does nothing and shows 'not yet' on its control for a moment", () => {
    const { port, sent, session, fire } = rig(new Set<ControlId>(["A.channel-fader"]));
    port.midi([0x90, 0x0b, 0x7f]);
    expect(sent).toEqual([]);
    expect(session.snapshot().notYet).toBe("A.play");
    fire(NOT_YET_MS);
    expect(session.snapshot().notYet).toBeNull();
  });

  it("a locked fader moves nothing and says 'not yet'", () => {
    const { port, sent, session } = rig(new Set<ControlId>(["A.play"]));
    for (const message of fourteenBit(0xb0, 0x13, 0)) port.midi(message);
    expect(sent).toEqual([]);
    expect(session.snapshot().notYet).toBe("A.channel-fader");
  });

  it("a locked jog says 'not yet' and sends nothing", () => {
    const { port, sent, session } = rig(new Set<ControlId>(["A.play"]));
    port.midi([0xb0, 0x21, 0x42]);
    expect(sent).toEqual([]);
    expect(session.snapshot().notYet).toBe("A.jog");
  });

  it("a release still goes through after the control locked mid-hold", () => {
    const { port, sent, session } = rig();
    port.midi([0x90, 0x0c, 0x7f], 1);
    session.setUnlocks(new Set());
    port.midi([0x90, 0x0c, 0x00], 2);
    expect(commands(sent)).toEqual([
      { control: "deck-cue", deck: "A", value: true },
      { control: "deck-cue", deck: "A", value: false },
    ]);
  });
});

describe("faders and knobs, with soft takeover", () => {
  it("a fader that starts at the app's value drives it at once, with a gestureEnd once it rests", () => {
    const { port, sent, fire } = rig();
    for (const message of fourteenBit(0xb0, 0x13, 0.005)) port.midi(message, 10);
    for (const message of fourteenBit(0xb0, 0x13, 0.6)) port.midi(message, 20);
    expect(sent.map((entry) => [entry.command, entry.input])).toEqual([
      [{ control: "channel-fader", deck: "A", value: expect.closeTo(0.005, 3) as unknown }, { device: "midi", eventTimeMs: 10, gestureEnd: false }],
      [{ control: "channel-fader", deck: "A", value: expect.closeTo(0.6, 3) as unknown }, { device: "midi", eventTimeMs: 20, gestureEnd: false }],
    ]);
    fire(HARDWARE_SETTLE_MS);
    expect(sent.at(-1)?.input).toEqual({ device: "midi", eventTimeMs: 20, gestureEnd: true });
  });

  it("a fader away from the value does not jump it: the pickup shows until it gets there", () => {
    const { port, sent, session } = rig();
    // The app's channel fader is at 0; the physical one is near the top.
    for (const message of fourteenBit(0xb0, 0x13, 0.9)) port.midi(message);
    expect(sent).toEqual([]);
    expect(session.snapshot().pickup["A.channel-fader"]).toBeCloseTo(0.9, 3);
    for (const message of fourteenBit(0xb0, 0x13, 0.4)) port.midi(message);
    expect(sent).toEqual([]);
    for (const message of fourteenBit(0xb0, 0x13, 0.01)) port.midi(message);
    expect(commands(sent)).toEqual([{ control: "channel-fader", deck: "A", value: expect.closeTo(0.01, 3) as unknown }]);
    expect(session.snapshot().pickup["A.channel-fader"]).toBeUndefined();
  });

  it("lets go when the screen moves the value, and shows the pickup again", () => {
    const { port, session } = rig();
    for (const message of fourteenBit(0xb6, 0x1f, 0.5)) port.midi(message);
    expect(session.snapshot().pickup.crossfader).toBeUndefined();
    session.setValue("crossfader", 0, { device: "trackpad" });
    expect(session.snapshot().pickup.crossfader).toBeCloseTo(0.5, 3);
  });

  it("maps centred knobs to −1…1, snapping the physical centre click to exactly 0", () => {
    const { port, sent } = rig();
    port.midi([0xb1, 0x04, 0x40]);
    port.midi([0xb1, 0x24, 0x00]);
    expect(commands(sent)).toEqual([{ control: "trim", deck: "B", value: 0 }]);
  });

  it("maps every mixer control to its app control", () => {
    const { port, sent } = rig();
    const send = (status: number, cc: number, value01: number) => {
      for (const message of fourteenBit(status, cc, value01)) port.midi(message);
    };
    send(0xb0, 0x07, 0.5); // EQ HI A
    send(0xb0, 0x0b, 0.5); // EQ MID A
    send(0xb0, 0x0f, 0.5); // EQ LOW A
    send(0xb6, 0x17, 0.5); // CFX A
    send(0xb6, 0x08, 0.5); // MASTER LEVEL
    send(0xb6, 0x0c, 0.0); // HEADPHONE MIX
    send(0xb6, 0x0d, 0.5); // HEADPHONE LEVEL
    send(0xb0, 0x00, 0.5); // TEMPO A
    expect(commands(sent).map((command) => ("deck" in command ? `${command.deck}.${command.control}` : command.control))).toEqual([
      "A.eq-high",
      "A.eq-mid",
      "A.eq-low",
      "A.filter",
      "master-level",
      "cue-mix",
      "headphone-level",
      "A.tempo",
    ]);
  });

  it("reads the tempo fader's '−' end as the slowest tempo", () => {
    const { port, session, sent } = rig();
    for (const message of fourteenBit(0xb0, 0x00, 0.5)) port.midi(message);
    for (const message of fourteenBit(0xb0, 0x00, 0)) port.midi(message);
    expect(commands(sent).at(-1)).toEqual({ control: "tempo", deck: "A", value: -1 });
    expect(session.valueOf("A.tempo")).toBe(-1);
  });
});

describe("jog wheel", () => {
  it("searches a paused deck by the platter turned", () => {
    const { port, sent } = rig();
    port.midi([0xb0, 0x22, 0x40 + 36], 1000);
    const search = sent.find((entry) => entry.command.control === "jog-search");
    // 36 ticks = 1/20 revolution.
    expect(search?.command).toEqual({ control: "jog-search", deck: "A", value: expect.closeTo((2 * Math.PI * HARDWARE_JOG.searchSecPerRadian) / 20, 6) as unknown });
    expect(search?.input).toEqual({ device: "midi", eventTimeMs: 1000, gestureEnd: false });
  });

  it("bends a playing deck when jog-bend is unlocked, and lets go when the wheel stops", () => {
    const { port, sent, fire } = rig();
    port.midi([0x90, 0x0b, 0x7f], 900);
    port.midi([0xb0, 0x21, 0x40 + 4], 1000);
    port.midi([0xb0, 0x21, 0x40 + 4], 1020);
    const bends = () => sent.filter((entry) => entry.command.control === "jog-bend").map((entry) => entry.command as { value: number });
    expect(bends().at(-1)?.value).toBeGreaterThan(0);
    fire();
    expect(bends().at(-1)?.value).toBe(0);
  });

  it("does not bend a playing deck while jog-bend is locked", () => {
    const { port, sent } = rig(new Set<ControlId>(["A.play", "A.jog"]));
    port.midi([0x90, 0x0b, 0x7f], 900);
    port.midi([0xb0, 0x21, 0x44], 1000);
    port.midi([0xb0, 0x21, 0x44], 1020);
    expect(sent.filter((entry) => entry.command.control === "jog-bend")).toEqual([]);
  });

  it("shows the platter being touched", () => {
    const { port, session } = rig();
    port.midi([0x91, 0x36, 0x7f]);
    expect(session.snapshot().jogTouched.B).toBe(true);
    port.midi([0x91, 0x36, 0x00]);
    expect(session.snapshot().jogTouched.B).toBe(false);
  });
});

describe("LEDs", () => {
  const lastValue = (out: readonly number[][], status: number, note: number) => out.filter((message) => message[0] === status && message[1] === note).at(-1)?.[2];

  it("on connect, clears every LED and lights what is on now", () => {
    const { port } = rig();
    expect(lastValue(port.out, 0x90, 0x0b)).toBe(0);
    expect(lastValue(port.out, 0x90, 0x0c)).toBe(0x7f);
  });

  it("follows the engine: PLAY lights when the deck plays, SYNC and MASTER TEMPO with their state", () => {
    const { port } = rig();
    port.midi([0x90, 0x0b, 0x7f]);
    expect(lastValue(port.out, 0x90, 0x0b)).toBe(0x7f);
    expect(lastValue(port.out, 0x90, 0x0c)).toBe(0);
    port.midi([0x91, 0x58, 0x7f]);
    expect(lastValue(port.out, 0x91, 0x58)).toBe(0x7f);
    port.midi([0x91, 0x5c, 0x7f]);
    expect(lastValue(port.out, 0x91, 0x60)).toBe(0x7f);
  });

  it("lights a hot cue pad once it is set, on both layers", () => {
    const { port } = rig();
    port.midi([0x99, 0x04, 0x7f]);
    expect(lastValue(port.out, 0x99, 0x04)).toBe(0x7f);
    expect(lastValue(port.out, 0x9a, 0x04)).toBe(0x7f);
  });

  it("keeps locked controls dark, and blinks a control's LED when a Lesson unlocks it", () => {
    const { port, session, fire } = rig(new Set<ControlId>());
    expect(lastValue(port.out, 0x90, 0x0c)).toBe(0);
    session.setUnlocks(new Set<ControlId>(["A.cue"]));
    const blinks = () => port.out.filter((message) => message[0] === 0x90 && message[1] === 0x0c).length;
    const before = blinks();
    for (let step = 0; step < 12; step += 1) fire();
    expect(blinks() - before).toBeGreaterThanOrEqual(4);
    // The blink ends on the state: CUE lit on a paused deck.
    expect(lastValue(port.out, 0x90, 0x0c)).toBe(0x7f);
  });

  it("sends only changes", () => {
    const { port } = rig();
    const count = port.out.length;
    port.midi([0x91, 0x3f, 0x7f]);
    port.midi([0x91, 0x3f, 0x00]);
    expect(port.out.length).toBe(count);
  });

  it("drives each deck's level meter from its meter frames", () => {
    const { port, emit } = rig();
    emit("meter", { bus: "A", ctx: 1, samplePeakDb: 0, momentaryLufs: -10 } as EngineEvents["meter"]);
    expect(lastValue(port.out, 0xb0, 0x02)).toBe(0x77);
    emit("meter", { bus: "B", ctx: 1, samplePeakDb: Number.NEGATIVE_INFINITY, momentaryLufs: -70 } as EngineEvents["meter"]);
    expect(lastValue(port.out, 0xb1, 0x02)).toBe(0);
  });

  it("turns every LED off when detached", () => {
    const { port, detach } = rig();
    port.midi([0x90, 0x0b, 0x7f]);
    detach();
    expect(lastValue(port.out, 0x90, 0x0b)).toBe(0);
  });
});

describe("the controller going away", () => {
  it("lets go of a held CUE and resets pickup when the FLX4 is unplugged", () => {
    const { port, sent, session } = rig();
    port.midi([0x90, 0x0c, 0x7f], 1);
    for (const message of fourteenBit(0xb0, 0x13, 0.9)) port.midi(message);
    port.setConnected(false);
    expect(commands(sent).at(-1)).toEqual({ control: "deck-cue", deck: "A", value: false });
    expect(session.snapshot().pickup).toEqual({});
  });
});
