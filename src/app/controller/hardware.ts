// The DDJ-FLX4 as an input device of the controller session: decoded MIDI goes through the same
// session methods as the screen and the keyboard (one lock check, one command path), recorded with
// device "midi" at the MIDI message's own timestamp, which is on the performance.now() clock like a key
// press's, so heard time and grading leeway are the same. Absolute faders and knobs use soft takeover;
// a locked control does nothing and says "not yet" on screen. LEDs follow the session and the engine.
//
// Mapping decisions beyond AlphaTheta's list (docs/research/flx4-midi.md):
// - BEAT SYNC long press = MASTER TEMPO (the FLX4 has no MASTER TEMPO button); SHIFT + BEAT SYNC = tempo range.
// - TAP: SHIFT + BEAT ▶ always (the panel prints TAP under BEAT ▶ as its SHIFT function), and the
//   BROWSE press always. Tapping is a Lesson's ear-training input, so TAP also borrows controls the
//   Learner has not been handed yet: any performance pad while the pads are locked (before hot cues),
//   and plain BEAT ◀ / BEAT ▶ while Beat FX is locked. Never BEAT SYNC. Borrowed pads light while they
//   are TAP, and the pad pressed blinks when its tap lands on the beat.
// - LOAD = Enter (into the Check / again), SHIFT + LOAD = P (practice), SHIFT + BROWSE press = R (Ready):
//   pressed as the Lesson keys, so Lessons have one path for them.
//
// - LOOP IN (SHIFT: ½X), LOOP OUT (SHIFT: 2X) and 4 BEAT/EXIT, as the on-screen loop buttons; LOOP IN
//   lights while an in point waits for OUT, LOOP OUT while the deck loops.
// - Beat FX: ON/OFF (its LED shows it), BEAT ◀/▶ (SHIFT: AUTO / TAP, the echo's tempo), LEVEL/DEPTH, and the CH SELECT lever (CH1 = deck A,
//   CH2 = deck B, CH1&CH2 = MASTER, the one place both channels go through). FX SELECT stays on ECHO, the
//   only effect in v1; 4 BEAT/EXIT's SHIFT layer (RELOOP) and the pad modes other than HOT CUE are out
//   of v1: they are refused, so the screen shows the control is not there yet.
// - Positions: AlphaTheta's list has no way to ask where the faders and knobs are. A fader or knob that
//   has moved in this tab (src/midi/positions.ts) shows its dashed pickup mark as soon as a controller
//   appears on screen; a locked one moved shows the mark too. When the Learner allowed SysEx, the bridge
//   sends the unofficial position request on connect, and what the unit answers within
//   POSITION_SYNC_MS sets the unlocked controls outright (no pickup): the screen starts where the
//   hardware is.

import type { BeatFxChannel, DeckId, EngineEvents } from "@audio";
import { allLedsOff, Flx4Decoder, hardwarePositions, JogDriver, ledMessages, levelMeterMessage, SoftTakeover, type ContinuousName, type Flx4Input, type KnownPosition, type LedId, type MidiMessage } from "@midi";
import { deckControl, type ControlId } from "./control-ids.ts";
import { onTapJudged, publishTapOnHardware } from "./tap-feedback.ts";
import { meterFraction } from "./displays.tsx";
import { continuousSpec, type ContinuousControlId } from "./gestures.ts";
import type { ControllerEngine, ControllerSession, JogFeel, Schedule } from "./session.ts";

/** What the bridge needs from the MIDI connection. */
export interface HardwarePort {
  onMessage(listener: (message: MidiMessage) => void): () => void;
  send(messages: readonly (readonly number[])[]): boolean;
  subscribe(listener: () => void): () => void;
  readonly connected: boolean;
  /** Sends the unofficial position request (SysEx); false when not allowed. */
  requestPositions?(): boolean;
}

/** How long after the position request the unit's answers set the controls outright. */
export const POSITION_SYNC_MS = 600;

/**
 * The hardware jog: one revolution searches 1.8 s, as a record at 33⅓ rpm does, so 720 ticks land
 * within 2.5 ms of a kick. Bending is gentler than on screen: half a turn a second bends about 6%.
 */
export const HARDWARE_JOG: JogFeel = { bendGain: 0.02, searchSecPerRadian: 1.8 / (2 * Math.PI) };
/** A centred knob or the tempo fader within this fraction of its span of the centre is at the centre (the physical click). */
const CENTRE_SNAP_FRACTION = 0.01;
const FLASH_STEP_MS = 150;
const FLASH_STEPS = 6;
/** How long a pad goes dark when its tap lands on the beat. */
const TAP_BLINK_MS = 90;

/** Beat FX's BEAT ◀ / ▶: TAP borrows them until echo-out unlocks it. */
const BEAT_FX_BEAT: ControlId = "beat-fx-beat";

/** Which borrowed controls TAP has on the hardware now, or null while TAP itself is locked. */
export interface HardwareTap {
  /** Every performance pad on both decks (the pads are not unlocked yet). */
  readonly pads: boolean;
  /** BEAT ◀ and BEAT ▶ (Beat FX is not unlocked yet). */
  readonly beatButtons: boolean;
}

export function hardwareTap(isUnlocked: (id: ControlId) => boolean): HardwareTap | null {
  if (!isUnlocked("tap")) return null;
  return { pads: !isUnlocked("A.hot-cue") && !isUnlocked("B.hot-cue"), beatButtons: !isUnlocked(BEAT_FX_BEAT) };
}

/** The hardware controls a caption names for TAP, before "or Space": the panel's TAP, and the pads while they are TAP. */
export function hardwareTapName(tap: HardwareTap): string {
  return tap.pads ? "SHIFT + BEAT ▶ (TAP), any pad" : "SHIFT + BEAT ▶ (TAP)";
}

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
const SHARED_CONTINUOUS: Partial<Record<ContinuousName, "crossfader" | "master-level" | "cue-mix" | "headphone-level" | "beat-fx-depth">> = {
  crossfader: "crossfader",
  "master-level": "master-level",
  "headphone-mix": "cue-mix",
  "headphone-level": "headphone-level",
  "beat-fx-depth": "beat-fx-depth",
};

/** The Beat FX CH SELECT lever's positions, as the app's channels. */
const FX_LEVER: Readonly<Record<"1" | "2" | "1&2", BeatFxChannel>> = { "1": "A", "2": "B", "1&2": "master" };

/** Every fader and knob the app maps, as the decoder would report it (for positions known before a move). */
const CONTINUOUS_INPUTS: readonly Extract<Flx4Input, { kind: "continuous" }>[] = [
  ...DECKS.flatMap((deck) => (Object.keys(DECK_CONTINUOUS) as ContinuousName[]).map((control) => ({ kind: "continuous" as const, control, deck, raw: 0, value: 0 }))),
  ...(Object.keys(SHARED_CONTINUOUS) as ContinuousName[]).map((control) => ({ kind: "continuous" as const, control, deck: null, raw: 0, value: 0 })),
];

/** The app control a hardware fader or knob drives, or null (MIC LEVEL). */
export function continuousTarget(input: Extract<Flx4Input, { kind: "continuous" }>): ContinuousControlId | null {
  if (input.deck !== null) {
    const part = DECK_CONTINUOUS[input.control];
    return part === undefined ? null : `${input.deck}.${part}`;
  }
  return SHARED_CONTINUOUS[input.control] ?? null;
}

/** The control each LED shows, for its lock. */
function ledControl(led: LedId): ControlId | null {
  if (led === "fx-on") return "beat-fx-on";
  const deck: DeckId = led.startsWith("A.") ? "A" : "B";
  const part = led.slice(2);
  if (part.startsWith("pad")) return deckControl(deck, "hot-cue");
  if (part === "play" || part === "cue" || part === "sync" || part === "master-tempo" || part === "headphone-cue" || part === "loop-in" || part === "loop-out") return deckControl(deck, part);
  return null;
}

const LEDS: readonly LedId[] = [
  ...DECKS.flatMap((deck) => [
  `${deck}.play` as const,
  `${deck}.loop-in` as const,
  `${deck}.loop-out` as const,
  `${deck}.cue` as const,
  `${deck}.sync` as const,
  `${deck}.master-tempo` as const,
  `${deck}.headphone-cue` as const,
  `${deck}.pad-mode-hot-cue` as const,
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((pad) => `${deck}.pad-${String(pad)}` as LedId),
  ]),
  "fx-on",
];

export interface HardwareBridgeOptions {
  readonly schedule?: Schedule;
  /** Presses a Lesson key (Enter, KeyP, KeyR). Defaults to a key press on the window. */
  readonly lessonKey?: (code: string) => void;
  /** Where judged taps are announced (on the beat or not). Defaults to the Lesson's announcements. */
  readonly tapJudged?: (listener: (onBeat: boolean) => void) => () => void;
  /** Where the hardware's TAP control is named for captions (null: none). Defaults to the shared one. */
  readonly publishTap?: (name: string | null) => void;
  /** Where the faders and knobs were last seen (physicalControlOf ids). Defaults to the shared record. */
  readonly positions?: { get(id: string): KnownPosition | null };
  /** The performance.now() clock. */
  readonly now?: () => number;
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
  private readonly tapJudged: (listener: (onBeat: boolean) => void) => () => void;
  private readonly publishTap: (name: string | null) => void;
  /** The pad the last tap came from, to blink when that tap is judged on the beat. */
  private tapPad: LedId | null = null;
  private readonly blinking = new Set<LedId>();
  private readonly positions: { get(id: string): KnownPosition | null };
  private readonly now: () => number;
  /** Until this time (performance.now() ms) the unit's answers to the position request set controls outright. */
  private syncUntilMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly session: ControllerSession,
    private readonly engine: Pick<ControllerEngine, "on">,
    private readonly port: HardwarePort,
    options: HardwareBridgeOptions = {},
  ) {
    this.schedule = options.schedule ?? browserSchedule;
    this.lessonKey = options.lessonKey ?? pressLessonKey;
    this.tapJudged = options.tapJudged ?? onTapJudged;
    this.publishTap = options.publishTap ?? publishTapOnHardware;
    this.positions = options.positions ?? hardwarePositions();
    this.now = options.now ?? (() => performance.now());
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
        if (frame.bus === "A" || frame.bus === "B") this.meter(frame.bus, meterFraction(frame.samplePeakDb));
      }),
      this.tapJudged((onBeat) => {
        if (onBeat && this.tapPad !== null) this.blink(this.tapPad);
        this.tapPad = null;
      }),
    ];
    this.connectionChanged();
    return () => {
      for (const stop of stops) stop();
      this.publishTap(null);
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
        if (this.tap()?.pads === true) {
          this.session.tap(this.input(timeMs));
          this.tapPad = `${input.deck}.pad-${String(input.pad + 1)}` as LedId;
          return;
        }
        if (input.mode !== "hot-cue") {
          // HOT CUE is the only pad mode in v1.
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
      case "fx-channel":
        if (this.unlockedOrRefuse("beat-fx-channel")) this.session.beatFxChannel(FX_LEVER[input.channels], this.input(timeMs));
        return;
      case "browse-turn":
      case "unknown":
        return;
    }
  }

  private button(input: Extract<Flx4Input, { kind: "button" }>, timeMs: number): void {
    const timed = this.input(timeMs);
    if (input.deck === null) {
      if (!input.pressed) return;
      switch (input.control) {
        case "browse-press":
          if (input.shift) this.lessonKey("KeyR");
          else this.tapOrRefuse(timed);
          return;
        case "fx-on":
          if (this.unlockedOrRefuse("beat-fx-on")) this.session.beatFxToggle(timed);
          return;
        case "fx-beat-back":
        case "fx-beat-forward":
          // SHIFT + BEAT ▶ is the panel's TAP: the Lesson tap always, and the echo's tap tempo once Beat FX
          // is unlocked. SHIFT + BEAT ◀ is AUTO. While Beat FX is locked, TAP borrows plain BEAT ◀ / ▶ (#39);
          // once it is unlocked they step the echo's beat length.
          if (input.shift && input.control === "fx-beat-forward") {
            this.tapOrRefuse(timed);
            if (this.session.isUnlocked(BEAT_FX_BEAT)) this.session.beatFxTap(timed);
          } else if (!this.session.isUnlocked(BEAT_FX_BEAT)) this.tapOrRefuse(timed);
          else if (input.shift) this.session.beatFxAuto(timed);
          else this.session.beatFxBeat(input.control === "fx-beat-back" ? -1 : 1, timed);
          return;
        case "fx-select":
          // ECHO is the only effect in v1: FX SELECT has nothing to choose.
          this.unlockedOrRefuse("beat-fx-select");
          return;
        default:
          return;
      }
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
      case "loop-in":
        if (this.unlockedOrRefuse(deckControl(deck, "loop-in"))) this.session.loopIn(deck, input.shift, timed);
        return;
      case "loop-out":
        if (this.unlockedOrRefuse(deckControl(deck, "loop-out"))) this.session.loopOut(deck, input.shift, timed);
        return;
      case "loop-exit":
        // SHIFT + 4 BEAT/EXIT is RELOOP on the FLX4: not in v1.
        if (input.shift) this.session.refuse(deckControl(deck, "loop-exit"));
        else if (this.unlockedOrRefuse(deckControl(deck, "loop-exit"))) this.session.loopButton(deck, timed);
        return;
      case "pad-mode":
        // HOT CUE is the only pad mode in v1; the others are not there yet.
        if (input.mode !== "hot-cue") this.session.refuse(deckControl(deck, "hot-cue"));
        return;
      default:
        return;
    }
  }

  private continuous(input: Extract<Flx4Input, { kind: "continuous" }>, timeMs: number): void {
    const id = continuousTarget(input);
    if (id === null) return;
    const syncing = timeMs <= this.syncUntilMs;
    this.moved.add(id);
    if (!this.session.isUnlocked(id)) {
      // Locked: nothing changes, but the screen shows where the hardware is (and, when touched, "not yet").
      if (!syncing) this.session.refuse(id);
      this.takeover.observe(id, input.value);
      this.showPickup(id);
      return;
    }
    if (syncing) {
      // The unit's answer to the position request: the screen starts where the hardware is.
      this.takeover.move(id, input.value, input.value);
      this.session.hardwareValue(id, this.appValue(id, input.value), timeMs);
      this.session.setPickup(id, null);
      return;
    }
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

  private tap(): HardwareTap | null {
    return hardwareTap((id) => this.session.isUnlocked(id));
  }

  private tapOrRefuse(timed: { device: "midi"; eventTimeMs: number }): void {
    this.tapPad = null;
    if (this.unlockedOrRefuse("tap")) this.session.tap(timed);
  }

  /** A pad that is TAP goes dark for a moment: that tap was on the beat. */
  private blink(led: LedId): void {
    this.blinking.add(led);
    this.refreshLeds();
    this.schedule(() => {
      this.blinking.delete(led);
      this.refreshLeds();
    }, TAP_BLINK_MS);
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
      this.seedKnownPositions();
      if (this.port.requestPositions?.() === true) this.syncUntilMs = this.now() + POSITION_SYNC_MS;
    }
    if (!connected && this.wasConnected) this.letGo();
    this.wasConnected = connected;
    this.publishTapName();
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

  /** The dashed mark where the hardware is, until it has picked up the value (none once caught). */
  private showPickup(id: ContinuousControlId): void {
    const status = this.takeover.status(id, this.normalized(id));
    const spec = continuousSpec(id);
    this.session.setPickup(id, status.caught || status.hardware === null ? null : spec.min + status.hardware * (spec.max - spec.min));
  }

  /** Faders and knobs already seen in this tab: their pickup marks show before they move again. */
  private seedKnownPositions(): void {
    for (const input of CONTINUOUS_INPUTS) {
      const id = continuousTarget(input);
      const known = this.positions.get(input.deck === null ? input.control : `${input.deck}.${input.control}`);
      if (id === null || known === null) continue;
      this.takeover.observe(id, known.value);
      this.moved.add(id);
      this.showPickup(id);
    }
  }

  private sessionChanged(): void {
    // The value moved by something else (the screen, a Lesson): the hardware may have to pick it up again.
    for (const id of this.moved) this.showPickup(id);
    const unlockedNow = new Set(LEDS.filter((led) => this.ledUnlocked(led)));
    for (const led of unlockedNow) if (!this.unlockedLeds.has(led)) this.flash(led);
    this.unlockedLeds = unlockedNow;
    this.refreshLeds();
    this.publishTapName();
  }

  private publishTapName(): void {
    const tap = this.tap();
    this.publishTap(this.port.connected && tap !== null ? hardwareTapName(tap) : null);
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
    if (/\.pad-\d$/.test(led) && this.tap()?.pads === true) return !this.blinking.has(led);
    if (!this.ledUnlocked(led)) return false;
    const { decks, mixer } = this.session.snapshot();
    if (led === "fx-on") return mixer.beatFx.on;
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
      case "loop-in":
        return state.loopInSec !== null && state.loop === null;
      case "loop-out":
        return state.loop !== null;
      case "pad-mode-hot-cue":
        return true;
      default: {
        const pad = Number(/^pad-(\d)$/.exec(part)?.[1] ?? Number.NaN);
        return Number.isInteger(pad) && (state.hotCues[pad - 1] ?? null) !== null;
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
