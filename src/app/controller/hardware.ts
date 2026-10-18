// The DDJ-FLX4 as an input device of the controller session: decoded MIDI goes through the same
// session methods as the screen and the keyboard (one lock check, one command path), recorded with
// device "midi" at the MIDI message's own timestamp, which is on the performance.now() clock like a key
// press's, so heard time and grading leeway are the same. Absolute faders and knobs use soft takeover;
// a locked control does nothing and says "not yet" on screen. LEDs follow the session and the engine.
//
// Mapping decisions beyond AlphaTheta's list (docs/research/flx4-midi.md):
// - BEAT SYNC long press = MASTER TEMPO (the FLX4 has no MASTER TEMPO button); SHIFT + BEAT SYNC = tempo range.
// - BROWSE press = TAP (no TAP button; the knob sits where the screen's TAP is).
// - LOAD = Enter (into the Check / again), SHIFT + LOAD = P (practice), SHIFT + BROWSE press = R (Ready):
//   pressed as the Lesson keys, so Lessons have one path for them.
//
// TODO(lessons-17-19): map LOOP IN / OUT / 4 BEAT-EXIT (and their LEDs), Beat FX (FX SELECT, BEAT ◀ ▶,
// LEVEL/DEPTH, ON/OFF, the CH SELECT lever, the FX ON LED) and the other pad modes once those control
// ids and session methods are on main. Until then they show in the Controller page's monitor only.

import type { DeckId, EngineEvents } from "@audio";
import { allLedsOff, Flx4Decoder, JogDriver, ledMessages, levelMeterMessage, SoftTakeover, type ContinuousName, type Flx4Input, type LedId, type MidiMessage } from "@midi";
import { deckControl, type ControlId } from "./control-ids.ts";
import { meterFraction } from "./displays.tsx";
import { continuousSpec, type ContinuousControlId } from "./gestures.ts";
import type { ControllerEngine, ControllerSession, JogFeel, Schedule } from "./session.ts";

/** What the bridge needs from the MIDI connection. */
export interface HardwarePort {
  onMessage(listener: (message: MidiMessage) => void): () => void;
  send(messages: readonly (readonly number[])[]): boolean;
  subscribe(listener: () => void): () => void;
  readonly connected: boolean;
}

/**
 * The hardware jog: one revolution searches 1.8 s, as a record at 33⅓ rpm does, so 720 ticks land
 * within 2.5 ms of a kick. Bending is gentler than on screen: half a turn a second bends about 6%.
 */
export const HARDWARE_JOG: JogFeel = { bendGain: 0.02, searchSecPerRadian: 1.8 / (2 * Math.PI) };
/** A centred knob or the tempo fader within this fraction of its span of the centre is at the centre (the physical click). */
const CENTRE_SNAP_FRACTION = 0.01;
const FLASH_STEP_MS = 150;
const FLASH_STEPS = 6;

const DECKS: readonly DeckId[] = ["A", "B"];

const DECK_CONTINUOUS: Partial<Record<ContinuousName, "tempo" | "trim" | "eq-high" | "eq-mid" | "eq-low" | "filter" | "channel-fader">> = {
  tempo: "tempo",
  trim: "trim",
  "eq-high": "eq-high",
  "eq-mid": "eq-mid",
  "eq-low": "eq-low",
  filter: "filter",
  "channel-fader": "channel-fader",
};
const SHARED_CONTINUOUS: Partial<Record<ContinuousName, "crossfader" | "master-level" | "cue-mix" | "headphone-level">> = {
  crossfader: "crossfader",
  "master-level": "master-level",
  "headphone-mix": "cue-mix",
  "headphone-level": "headphone-level",
};

/** The app control a hardware fader or knob drives, or null (MIC LEVEL; LEVEL/DEPTH until Beat FX lands). */
export function continuousTarget(input: Extract<Flx4Input, { kind: "continuous" }>): ContinuousControlId | null {
  if (input.deck !== null) {
    const part = DECK_CONTINUOUS[input.control];
    return part === undefined ? null : `${input.deck}.${part}`;
  }
  return SHARED_CONTINUOUS[input.control] ?? null;
}

/** The control each LED shows, for its lock. */
function ledControl(led: LedId): ControlId | null {
  if (led === "fx-on") return null;
  const deck: DeckId = led.startsWith("A.") ? "A" : "B";
  const part = led.slice(2);
  if (part.startsWith("pad")) return deckControl(deck, "hot-cue");
  if (part === "play" || part === "cue" || part === "sync" || part === "master-tempo" || part === "headphone-cue") return deckControl(deck, part);
  return null;
}

const LEDS: readonly LedId[] = DECKS.flatMap((deck) => [
  `${deck}.play` as const,
  `${deck}.cue` as const,
  `${deck}.sync` as const,
  `${deck}.master-tempo` as const,
  `${deck}.headphone-cue` as const,
  `${deck}.pad-mode-hot-cue` as const,
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((pad) => `${deck}.pad-${String(pad)}` as LedId),
]);

export interface HardwareBridgeOptions {
  readonly schedule?: Schedule;
  /** Presses a Lesson key (Enter, KeyP, KeyR). Defaults to a key press on the window. */
  readonly lessonKey?: (code: string) => void;
}

const browserSchedule: Schedule = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

function pressLessonKey(code: string): void {
  const key = code === "Enter" ? "Enter" : code.replace(/^Key/, "").toLowerCase();
  window.dispatchEvent(new KeyboardEvent("keydown", { code, key }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code, key }));
}

export class HardwareBridge {
  private readonly decoder = new Flx4Decoder();
  private readonly takeover = new SoftTakeover();
  private readonly schedule: Schedule;
  private readonly lessonKey: (code: string) => void;
  private readonly jogs: Readonly<Record<DeckId, JogDriver>>;
  /** Continuous controls the hardware has moved, whose pickup the screen may need to show. */
  private readonly moved = new Set<ContinuousControlId>();
  private readonly cueHeld: Record<DeckId, boolean> = { A: false, B: false };
  private readonly sentLeds = new Map<LedId, boolean>();
  private readonly sentMeters = new Map<DeckId, number>();
  private unlockedLeds = new Set<LedId>();
  private readonly flashing = new Map<LedId, number>();
  private cancelFlash: (() => void) | null = null;
  private wasConnected = false;

  constructor(
    private readonly session: ControllerSession,
    private readonly engine: Pick<ControllerEngine, "on">,
    private readonly port: HardwarePort,
    options: HardwareBridgeOptions = {},
  ) {
    this.schedule = options.schedule ?? browserSchedule;
    this.lessonKey = options.lessonKey ?? pressLessonKey;
    const jog = (deck: DeckId) =>
      new JogDriver({
        begin: () => this.session.beginJog(deck, "midi", HARDWARE_JOG),
        refused: () => {
          this.session.refuse(deckControl(deck, "jog"));
        },
        schedule: this.schedule,
      });
    this.jogs = { A: jog("A"), B: jog("B") };
  }

  /** Starts listening and lighting; the returned function stops both and turns the LEDs off. */
  attach(): () => void {
    this.unlockedLeds = new Set(LEDS.filter((led) => this.ledUnlocked(led)));
    const stops = [
      this.port.onMessage((message) => {
        this.handle(message);
      }),
      this.port.subscribe(() => {
        this.connectionChanged();
      }),
      this.session.subscribe(() => {
        this.sessionChanged();
      }),
      this.engine.on("meter", (frame: EngineEvents["meter"]) => {
        if (frame.bus !== "master") this.meter(frame.bus, meterFraction(frame.samplePeakDb));
      }),
    ];
    this.connectionChanged();
    return () => {
      for (const stop of stops) stop();
      this.letGo();
      this.cancelFlash?.();
      this.cancelFlash = null;
      if (this.port.connected) this.port.send(allLedsOff());
      this.sentLeds.clear();
      this.sentMeters.clear();
    };
  }

  /** One MIDI message from the controller. */
  handle(message: MidiMessage): void {
    const input = this.decoder.decode(message.data);
    if (input === null) return;
    const timeMs = message.timeStamp;
    switch (input.kind) {
      case "button":
        this.button(input, timeMs);
        return;
      case "pad":
        if (!input.pressed) return;
        if (input.mode !== "hot-cue") {
          // TODO(lessons-17-19): BEAT LOOP and the other pad modes. For now only HOT CUE does anything.
          this.session.refuse(deckControl(input.deck, "hot-cue"));
          return;
        }
        if (!this.unlockedOrRefuse(deckControl(input.deck, "hot-cue"))) return;
        this.session.hotCue(input.deck, input.pad, input.shift, this.input(timeMs));
        return;
      case "continuous":
        this.continuous(input, timeMs);
        return;
      case "jog-turn":
        this.jogs[input.deck].ticks(input.ticks, timeMs);
        return;
      case "jog-touch":
        this.session.setJogTouched(input.deck, input.touched);
        this.jogs[input.deck].touch(input.touched, timeMs);
        return;
      case "browse-turn":
      case "fx-channel":
      case "unknown":
        return;
    }
  }

  private button(input: Extract<Flx4Input, { kind: "button" }>, timeMs: number): void {
    const timed = this.input(timeMs);
    if (input.deck === null) {
      if (input.control === "browse-press" && input.pressed) {
        if (input.shift) this.lessonKey("KeyR");
        else if (this.unlockedOrRefuse("tap")) this.session.tap(timed);
      }
      return;
    }
    const { deck } = input;
    switch (input.control) {
      case "shift":
        this.session.setShift(deck, input.pressed);
        return;
      case "cue":
        if (!input.pressed) {
          this.cueHeld[deck] = false;
          this.session.deckCue(deck, false, timed);
        } else if (this.unlockedOrRefuse(deckControl(deck, "cue"))) {
          this.cueHeld[deck] = true;
          this.session.deckCue(deck, true, timed);
        }
        return;
      case "load":
        if (input.pressed) this.lessonKey(input.shift ? "KeyP" : "Enter");
        return;
      default:
        break;
    }
    if (!input.pressed) return;
    switch (input.control) {
      case "play":
        if (this.unlockedOrRefuse(deckControl(deck, "play"))) this.session.playPause(deck, timed);
        return;
      case "sync":
        if (input.shift) {
          if (this.unlockedOrRefuse(deckControl(deck, "tempo-range"))) this.session.cycleTempoRange(deck, timed);
        } else if (this.unlockedOrRefuse(deckControl(deck, "sync"))) this.session.toggle(deck, "sync", timed);
        return;
      case "sync-long":
        if (this.unlockedOrRefuse(deckControl(deck, "master-tempo"))) this.session.toggle(deck, "master-tempo", timed);
        return;
      case "headphone-cue":
        if (this.unlockedOrRefuse(deckControl(deck, "headphone-cue"))) this.session.toggle(deck, "headphone-cue", timed);
        return;
      default:
        // TODO(lessons-17-19): loop-in, loop-out, loop-exit and the pad-mode buttons.
        return;
    }
  }

  private continuous(input: Extract<Flx4Input, { kind: "continuous" }>, timeMs: number): void {
    const id = continuousTarget(input);
    if (id === null) return;
    if (!this.unlockedOrRefuse(id)) return;
    this.moved.add(id);
    const spec = continuousSpec(id);
    const move = this.takeover.move(id, input.value, this.normalized(id));
    if (move.kind === "send") {
      this.session.hardwareValue(id, this.appValue(id, move.value), timeMs);
      this.session.setPickup(id, null);
    } else {
      this.session.setPickup(id, spec.min + move.hardware * (spec.max - spec.min));
    }
  }

  /** The app value for a hardware position (0…1), with the centre click snapped to the centre. */
  private appValue(id: ContinuousControlId, hardware: number): number {
    const spec = continuousSpec(id);
    const span = spec.max - spec.min;
    const value = spec.min + hardware * span;
    return spec.centreDetent && Math.abs(value - spec.resetValue) < CENTRE_SNAP_FRACTION * span ? spec.resetValue : value;
  }

  private normalized(id: ContinuousControlId): number {
    const spec = continuousSpec(id);
    return (this.session.valueOf(id) - spec.min) / (spec.max - spec.min);
  }

  private unlockedOrRefuse(control: ControlId): boolean {
    if (this.session.isUnlocked(control)) return true;
    this.session.refuse(control);
    return false;
  }

  private input(timeMs: number) {
    return { device: "midi" as const, eventTimeMs: timeMs };
  }

  private connectionChanged(): void {
    const connected = this.port.connected;
    if (connected && !this.wasConnected) {
      this.sentLeds.clear();
      this.sentMeters.clear();
      this.port.send(allLedsOff());
      this.refreshLeds();
    }
    if (!connected && this.wasConnected) this.letGo();
    this.wasConnected = connected;
  }

  /** Releases whatever the hardware holds: a CUE, a jog; forgets where the faders were. */
  private letGo(): void {
    for (const deck of DECKS) {
      this.jogs[deck].release();
      this.session.setJogTouched(deck, false);
      if (this.cueHeld[deck]) {
        this.cueHeld[deck] = false;
        this.session.deckCue(deck, false, { device: "midi" });
      }
    }
    this.takeover.reset();
    for (const id of this.moved) this.session.setPickup(id, null);
    this.moved.clear();
  }

  private sessionChanged(): void {
    // The value moved by something else (the screen, a Lesson): the hardware may have to pick it up again.
    for (const id of this.moved) {
      const status = this.takeover.status(id, this.normalized(id));
      const spec = continuousSpec(id);
      this.session.setPickup(id, status.caught || status.hardware === null ? null : spec.min + status.hardware * (spec.max - spec.min));
    }
    const unlockedNow = new Set(LEDS.filter((led) => this.ledUnlocked(led)));
    for (const led of unlockedNow) if (!this.unlockedLeds.has(led)) this.flash(led);
    this.unlockedLeds = unlockedNow;
    this.refreshLeds();
  }

  private ledUnlocked(led: LedId): boolean {
    const control = ledControl(led);
    return control !== null && this.session.isUnlocked(control);
  }

  /** A part a Lesson just unlocked blinks a few times: the hardware gets the reward too. */
  private flash(led: LedId): void {
    this.flashing.set(led, FLASH_STEPS);
    if (this.cancelFlash !== null) return;
    const step = () => {
      this.cancelFlash = null;
      for (const [id, left] of [...this.flashing]) {
        if (left <= 1) this.flashing.delete(id);
        else this.flashing.set(id, left - 1);
      }
      this.refreshLeds();
      if (this.flashing.size > 0) this.cancelFlash = this.schedule(step, FLASH_STEP_MS);
    };
    this.cancelFlash = this.schedule(step, FLASH_STEP_MS);
  }

  private ledState(led: LedId): boolean {
    const flashing = this.flashing.get(led);
    if (flashing !== undefined) return flashing % 2 === 0;
    if (!this.ledUnlocked(led)) return false;
    const { decks, mixer, hotCues } = this.session.snapshot();
    const deck: DeckId = led.startsWith("A.") ? "A" : "B";
    const state = decks[deck];
    const part = led.slice(2);
    switch (part) {
      case "play":
        return state.playing && !state.previewing;
      case "cue":
        return state.previewing || (!state.playing && state.trackId !== null);
      case "sync":
        return state.syncOn;
      case "master-tempo":
        return state.masterTempo;
      case "headphone-cue":
        return mixer.channels[deck].cue;
      case "pad-mode-hot-cue":
        return true;
      default: {
        const pad = Number(/^pad-(\d)$/.exec(part)?.[1] ?? Number.NaN);
        return Number.isInteger(pad) && (hotCues[deck][pad - 1] ?? null) !== null;
      }
    }
  }

  private refreshLeds(): void {
    if (!this.port.connected) return;
    const changes = LEDS.flatMap((led) => {
      const on = this.ledState(led);
      if (this.sentLeds.get(led) === on) return [];
      this.sentLeds.set(led, on);
      return ledMessages(led, on);
    });
    if (changes.length > 0) this.port.send(changes);
  }

  private meter(deck: DeckId, fraction: number): void {
    if (!this.port.connected) return;
    const message = levelMeterMessage(deck, this.session.isUnlocked(deckControl(deck, "level-meter")) ? fraction : 0);
    const value = message[2] ?? 0;
    if (this.sentMeters.get(deck) === value) return;
    this.sentMeters.set(deck, value);
    this.port.send([message]);
  }
}
