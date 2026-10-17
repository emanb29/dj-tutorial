// The controller's input layer, outside React: turns key presses, pointer drags, wheel turns and button
// presses into engine commands, with the right input device and gestureEnd on release. It is the single
// place that checks locks, so a locked control cannot reach the engine whatever the DOM does.
// It also owns the UI-side state the engine does not have: hot cue slots and SHIFT.

import { TEMPO_RANGES, type AudioEngine, type CommandInput, type DeckId, type EngineCommand, type EngineDeckSnapshot, type EngineMixerSnapshot, type InputDevice, type Result } from "@audio";
import { deckControl, type ControlId, type ControllerUnlocks } from "./control-ids.ts";
import { commandFor, continuousSpec, dragValue, nudgeValue, wheelTravelPx, wheelValue, type ContinuousControlId } from "./gestures.ts";
import { InputDeviceDetector, type WheelDeltas } from "./input-device.ts";
import { bindingFor, type KeyAction, type KeyModifiers } from "./keymap.ts";

/** The part of the audio engine the controller uses. */
export type ControllerEngine = Pick<AudioEngine, "command" | "on" | "deckState" | "mixerState" | "playhead" | "trackHistory">;

export const HOT_CUE_SLOTS = 8;
/** A wheel gesture ends once no wheel event has arrived for this long. */
export const WHEEL_GESTURE_END_MS = 180;
/** Jog bend per radian-per-second of platter speed, and its cap, so a flick stays a nudge. */
const JOG_GAIN = 0.04;
const JOG_MAX_BEND = 0.25;
/**
 * Jog search on a paused deck: track seconds per radian of platter turn. One turn is about 0.94 s (two
 * beats at 128 BPM); a trackpad scroll moves it about 2.5 ms per pixel, fine enough to land on a kick.
 */
export const JOG_SEARCH_SEC_PER_RADIAN = 0.15;
/** Bend changes smaller than this are not sent; the engine asks for jog-bend to be throttled. */
const JOG_MIN_STEP = 0.005;
/** At most one jog bend per frame (about 60 Hz). */
const JOG_MIN_INTERVAL_MS = 16;
const NO_MODIFIERS: KeyModifiers = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

export interface ControllerSnapshot {
  readonly decks: Readonly<Record<DeckId, EngineDeckSnapshot>>;
  readonly mixer: EngineMixerSnapshot;
  /** Track position of each hot cue, null when the pad is empty. */
  readonly hotCues: Readonly<Record<DeckId, readonly (number | null)[]>>;
  readonly shiftHeld: Readonly<Record<DeckId, boolean>>;

  /** Heard BPM from the loaded track's grid and the tempo fader, null without a grid. */
  readonly bpm: Readonly<Record<DeckId, number | null>>;
}

export interface KeyboardEventLike extends KeyModifiers {
  readonly code: string;
  readonly repeat: boolean;
  readonly timeStamp: number;
}

export interface GestureTiming {
  readonly eventTimeMs: number;
}

/**
 * A press or gesture that has started and not yet ended: a drag, a wheel burst, a jog turn or a held
 * CUE. `finish` sends its final command (gestureEnd, or CUE released) exactly once, without a lock
 * check, because the gesture began while the control was unlocked.
 */
interface OpenGesture {
  readonly control: ControlId;
  readonly finish: (eventTimeMs: number | undefined) => void;
}

export interface DragGesture {
  /** `travelPx` is the total screen travel since the drag began, positive up or right. */
  move(travelPx: number, options: { fine: boolean } & GestureTiming): void;
  end(timing: GestureTiming): void;
}

export interface JogGesture {
  /** `angleRad` turned since the last call, clockwise positive, over `elapsedMs`. */
  turn(angleRad: number, elapsedMs: number, timing: GestureTiming): void;
  end(timing: GestureTiming): void;
}

export type Schedule = (run: () => void, delayMs: number) => () => void;

export interface ControllerSessionOptions {
  readonly unlocks: ControllerUnlocks;
  /**
   * On a Mac, the pointer is assumed to be the built-in trackpad, and scrolling is assumed to be
   * natural (macOS's default, for mice too). Elsewhere a wheel is assumed classic. Browsers do not
   * report the scrolling setting, so this is a best guess.
   */
  readonly macPlatform: boolean;
  /** Timer for ending wheel gestures; tests pass a manual one. */
  readonly schedule?: Schedule;
}

const browserSchedule: Schedule = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

const emptySlots = (): (number | null)[] => Array.from({ length: HOT_CUE_SLOTS }, () => null);

export class ControllerSession {
  readonly devices: InputDeviceDetector;
  readonly naturalScrolling: boolean;
  private unlocks: ControllerUnlocks;
  private readonly schedule: Schedule;
  private readonly listeners = new Set<() => void>();
  private current: ControllerSnapshot;
  private readonly open = new Map<string, OpenGesture>();
  private readonly wheelTimers = new Map<string, () => void>();
  private readonly heldKeys = new Set<string>();
  private nextGestureId = 0;
  private legendToggle: (() => void) | null = null;

  constructor(
    private readonly engine: ControllerEngine,
    options: ControllerSessionOptions,
  ) {
    this.unlocks = options.unlocks;
    this.schedule = options.schedule ?? browserSchedule;
    this.devices = new InputDeviceDetector({ macPlatform: options.macPlatform });
    this.naturalScrolling = options.macPlatform;
    this.current = {
      decks: { A: engine.deckState("A"), B: engine.deckState("B") },
      mixer: engine.mixerState(),
      hotCues: { A: emptySlots(), B: emptySlots() },
      shiftHeld: { A: false, B: false },

      bpm: { A: this.bpmOf("A", engine.deckState("A")), B: this.bpmOf("B", engine.deckState("B")) },
    };
  }

  /** Follows engine events until the returned function is called. */
  connect(): () => void {
    const stops = [
      this.engine.on("deck", (deck) => {
        this.update({
          decks: { ...this.current.decks, [deck.deck]: deck },
          bpm: { ...this.current.bpm, [deck.deck]: this.bpmOf(deck.deck, deck) },
        });
      }),
      this.engine.on("command", (event) => {
        if (event.rejected === null) this.update({ mixer: this.engine.mixerState() });
      }),
      this.engine.on("track-loaded", ({ deck }) => {
        this.update({ hotCues: { ...this.current.hotCues, [deck]: emptySlots() } });
      }),
    ];
    this.update({ decks: { A: this.engine.deckState("A"), B: this.engine.deckState("B") }, mixer: this.engine.mixerState() });
    return () => {
      for (const stop of stops) stop();
      this.releaseAll();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): ControllerSnapshot => this.current;

  /** Changes the unlocked controls. Anything held on a control that just locked is released. */
  setUnlocks(unlocks: ControllerUnlocks): void {
    this.unlocks = unlocks;
    for (const [key, gesture] of [...this.open]) {
      if (!unlocks.has(gesture.control)) this.close(key, undefined);
    }
    for (const deck of ["A", "B"] as const) {
      if (!unlocks.has(deckControl(deck, "shift"))) this.setShift(deck, false);
    }
  }

  /**
   * Ends every open gesture and releases every hold (CUE, SHIFT, held keys). Call it when the page
   * loses focus or is hidden, so a release the page never sees cannot leave a deck previewing.
   */
  releaseAll(): void {
    for (const key of [...this.open.keys()]) this.close(key, undefined);
    this.heldKeys.clear();
    this.setShift("A", false);
    this.setShift("B", false);
  }

  onLegendToggle(toggle: (() => void) | null): void {
    this.legendToggle = toggle;
  }

  isUnlocked(id: ControlId): boolean {
    return this.unlocks.has(id);
  }

  valueOf(id: ContinuousControlId): number {
    const { mixer, decks } = this.current;
    switch (id) {
      case "crossfader":
        return mixer.crossfader;
      case "master-level":
        return mixer.masterLevel;
      case "cue-mix":
        return mixer.cueMix;
      case "headphone-level":
        return mixer.headphoneLevel;
      default: {
        const deck: DeckId = id.startsWith("A.") ? "A" : "B";
        const part = id.slice(2) as Exclude<ContinuousControlId, "crossfader" | "master-level" | "cue-mix" | "headphone-level"> extends `${DeckId}.${infer P}` ? P : never;
        return part === "tempo" ? decks[deck].tempoFader : mixer.channels[deck][part];
      }
    }
  }

  // ---- continuous controls -------------------------------------------------------------------

  setValue(id: ContinuousControlId, value: number, input: CommandInput): void {
    if (!this.isUnlocked(id)) return;
    this.sendValue(id, value, input);
  }

  private sendValue(id: ContinuousControlId, value: number, input: CommandInput): void {
    const command = commandFor(id, value);
    if (command !== null) this.send(command, input);
  }

  beginDrag(id: ContinuousControlId, device: InputDevice): DragGesture | null {
    if (!this.isUnlocked(id)) return null;
    const spec = continuousSpec(id);
    const startValue = this.valueOf(id);
    const key = `drag:${String(this.nextGestureId++)}`;
    let last: number | null = null;
    this.open.set(key, {
      control: id,
      finish: (eventTimeMs) => {
        if (last !== null) this.sendValue(id, last, withTime({ device, gestureEnd: true }, eventTimeMs));
      },
    });
    return {
      move: (travelPx, options) => {
        if (!this.open.has(key)) return;
        const value = dragValue(spec, startValue, travelPx, options);
        if (value === last) return;
        last = value;
        this.sendValue(id, value, { device, eventTimeMs: options.eventTimeMs, gestureEnd: false });
      },
      end: (timing) => {
        this.close(key, timing.eventTimeMs);
      },
    };
  }

  wheel(id: ContinuousControlId, deltas: WheelDeltas, options: { fine: boolean } & GestureTiming): void {
    if (!this.isUnlocked(id)) return;
    const device = this.devices.observeWheel(deltas);
    const travel = wheelTravelPx(deltas, { natural: this.naturalScrolling });
    const value = wheelValue(continuousSpec(id), this.valueOf(id), travel, options);
    this.sendValue(id, value, { device, eventTimeMs: options.eventTimeMs, gestureEnd: false });
    // One gesture per burst of wheel events: each event pushes the end back.
    const key = `wheel:${id}`;
    this.wheelTimers.get(key)?.();
    this.open.set(key, {
      control: id,
      finish: (eventTimeMs) => {
        this.wheelTimers.get(key)?.();
        this.wheelTimers.delete(key);
        this.sendValue(id, value, withTime({ device, gestureEnd: true }, eventTimeMs));
      },
    });
    this.wheelTimers.set(
      key,
      this.schedule(() => {
        this.close(key, undefined);
      }, WHEEL_GESTURE_END_MS),
    );
  }

  /** Arrow, Page and Home/End keys on a focused control. Returns whether the key was handled. */
  nudge(id: ContinuousControlId, key: string, options: { fine: boolean } & GestureTiming): boolean {
    if (!this.isUnlocked(id)) return false;
    const value = nudgeValue(continuousSpec(id), this.valueOf(id), key, options);
    if (value === null) return false;
    this.setValue(id, value, { device: "keyboard", eventTimeMs: options.eventTimeMs, gestureEnd: true });
    return true;
  }

  reset(id: ContinuousControlId, input: { device: InputDevice; eventTimeMs?: number }): void {
    this.setValue(id, continuousSpec(id).resetValue, withTime({ device: input.device, gestureEnd: true }, input.eventTimeMs));
  }

  // ---- jog wheel -----------------------------------------------------------------------------

  /**
   * A jog turn. On a paused deck it searches (`jog-search`, needs `jog` unlocked); on a playing deck it
   * bends pitch (`jog-bend`, needs `jog-bend` unlocked too). The mode is chosen per turn, so a deck that
   * starts or stops mid-gesture switches with it.
   */
  beginJog(deck: DeckId, device: InputDevice): JogGesture | null {
    const control = deckControl(deck, "jog");
    if (!this.isUnlocked(control)) return null;
    const key = `jog:${String(this.nextGestureId++)}`;
    let lastBend = 0;
    let bent = false;
    let lastSentMs = Number.NEGATIVE_INFINITY;
    // Search distance not yet sent (throttled): summed, never dropped.
    let pendingSearchSec = 0;
    let lastSearchMs = Number.NEGATIVE_INFINITY;
    const flushSearch = (input: CommandInput) => {
      if (pendingSearchSec === 0) return;
      const value = pendingSearchSec;
      pendingSearchSec = 0;
      this.send({ control: "jog-search", deck, value }, input);
    };
    this.open.set(key, {
      control,
      finish: (eventTimeMs) => {
        flushSearch(withTime({ device, gestureEnd: true }, eventTimeMs));
        if (bent) this.send({ control: "jog-bend", deck, value: 0 }, withTime({ device, gestureEnd: true }, eventTimeMs));
      },
    });
    return {
      turn: (angleRad, elapsedMs, timing) => {
        if (!this.open.has(key)) return;
        const state = this.current.decks[deck];
        if (!state.playing) {
          pendingSearchSec += angleRad * JOG_SEARCH_SEC_PER_RADIAN;
          if (timing.eventTimeMs - lastSearchMs < JOG_MIN_INTERVAL_MS) return;
          lastSearchMs = timing.eventTimeMs;
          flushSearch({ device, eventTimeMs: timing.eventTimeMs, gestureEnd: false });
          return;
        }
        if (!this.isUnlocked(deckControl(deck, "jog-bend"))) return;
        // Coalesced pointer events can arrive with no time between them; they carry no speed.
        if (elapsedMs <= 0) return;
        if (timing.eventTimeMs - lastSentMs < JOG_MIN_INTERVAL_MS) return;
        const speed = (angleRad / elapsedMs) * 1000;
        const bend = Math.max(-JOG_MAX_BEND, Math.min(JOG_MAX_BEND, speed * JOG_GAIN));
        if (Math.abs(bend - lastBend) < JOG_MIN_STEP) return;
        lastBend = bend;
        bent = true;
        lastSentMs = timing.eventTimeMs;
        this.send({ control: "jog-bend", deck, value: bend }, { device, eventTimeMs: timing.eventTimeMs, gestureEnd: false });
      },
      end: (timing) => {
        this.close(key, timing.eventTimeMs);
      },
    };
  }

  // ---- buttons -------------------------------------------------------------------------------

  playPause(deck: DeckId, input: CommandInput): void {
    if (!this.isUnlocked(deckControl(deck, "play"))) return;
    const state = this.current.decks[deck];
    const playing = state.playing && !state.previewing;
    this.send({ control: playing ? "pause" : "play", deck }, { ...input, gestureEnd: true });
  }

  /** Deck CUE down or up. A release is sent once for each accepted press, even if CUE locked meanwhile. */
  deckCue(deck: DeckId, pressed: boolean, input: CommandInput): void {
    const key = `cue:${deck}`;
    if (!pressed) {
      this.close(key, input.eventTimeMs);
      return;
    }
    const control = deckControl(deck, "cue");
    if (!this.isUnlocked(control) || this.open.has(key)) return;
    const sent = this.send({ control: "deck-cue", deck, value: true }, { ...input, gestureEnd: false });
    if (!sent.ok) return;
    this.open.set(key, {
      control,
      finish: (eventTimeMs) => {
        this.send({ control: "deck-cue", deck, value: false }, withTime({ device: input.device, gestureEnd: true }, eventTimeMs));
      },
    });
  }

  toggle(deck: DeckId, control: "sync" | "headphone-cue" | "master-tempo", input: CommandInput): void {
    if (!this.isUnlocked(deckControl(deck, control))) return;
    const on = control === "sync" ? this.current.decks[deck].syncOn : control === "master-tempo" ? this.current.decks[deck].masterTempo : this.current.mixer.channels[deck].cue;
    this.send({ control, deck, value: !on }, { ...input, gestureEnd: true });
  }

  /** The MASTER TEMPO button: SHIFT + it cycles the tempo range (6, 10, 16%), as on the DDJ-FLX4. */
  masterTempoButton(deck: DeckId, input: CommandInput): void {
    if (this.current.shiftHeld[deck]) this.cycleTempoRange(deck, input);
    else this.toggle(deck, "master-tempo", input);
  }

  cycleTempoRange(deck: DeckId, input: CommandInput): void {
    if (!this.isUnlocked(deckControl(deck, "tempo-range"))) return;
    const index = TEMPO_RANGES.indexOf(this.current.decks[deck].tempoRangePercent);
    const next = TEMPO_RANGES[(index + 1) % TEMPO_RANGES.length] ?? TEMPO_RANGES[0];
    if (next === undefined) return;
    this.send({ control: "tempo-range", deck, value: next }, { ...input, gestureEnd: true });
  }

  setShift(deck: DeckId, held: boolean): void {
    if (!this.isUnlocked(deckControl(deck, "shift")) && held) return;
    if (this.current.shiftHeld[deck] === held) return;
    this.update({ shiftHeld: { ...this.current.shiftHeld, [deck]: held } });
  }

  tap(input: CommandInput): void {
    if (!this.isUnlocked("tap")) return;
    this.send({ control: "tap" }, { ...input, gestureEnd: true });
  }

  cut(deck: DeckId, open: boolean, input: CommandInput): void {
    this.setValue(deckControl(deck, "channel-fader") as ContinuousControlId, open ? 1 : 0, { ...input, gestureEnd: true });
  }

  /**
   * A hot cue pad. Empty: store the heard playhead there. Set: jump there and play. With `erase`
   * (SHIFT + pad), empty it. The engine has no hot cue command yet, so a trigger is recorded as a seek.
   */
  hotCue(deck: DeckId, slot: number, erase: boolean, input: CommandInput): void {
    if (!this.isUnlocked(deckControl(deck, "hot-cue"))) return;
    const slots = this.current.hotCues[deck];
    const stored = slots[slot] ?? null;
    if (erase || stored === null) {
      let position: number | null = null;
      if (!erase) {
        const reading = this.engine.playhead(deck, input.eventTimeMs);
        if (!reading.ok) return;
        position = reading.positionSec;
      }
      const next = slots.map((value, index) => (index === slot ? position : value));
      this.update({ hotCues: { ...this.current.hotCues, [deck]: next } });
      return;
    }
    const sent = this.send({ control: "seek", deck, value: stored }, { ...input, gestureEnd: true });
    // Starting playback is PLAY's job; with PLAY locked the pad only jumps.
    const mayPlay = this.isUnlocked(deckControl(deck, "play"));
    if (sent.ok && mayPlay && !this.current.decks[deck].playing) this.send({ control: "play", deck }, { ...input, gestureEnd: true });
  }

  // ---- keyboard ------------------------------------------------------------------------------

  /**
   * Handles a global key press. Returns true when the key acted (or is an auto-repeat of a key that
   * did), so the caller can preventDefault. A key for a locked control is left to the browser.
   */
  keyDown(event: KeyboardEventLike): boolean {
    const binding = bindingFor(event.code, event);
    if (binding === null) return false;
    if (binding.control !== null && !this.isUnlocked(binding.control)) return false;
    if (event.repeat) return true;
    this.heldKeys.add(event.code);
    const action: KeyAction = binding.action.kind === "hot-cue" ? { ...binding.action, erase: event.shiftKey } : binding.action;
    const input: CommandInput = { device: "keyboard", eventTimeMs: event.timeStamp };
    switch (action.kind) {
      case "play-pause":
        this.playPause(action.deck, input);
        break;
      case "deck-cue":
        this.deckCue(action.deck, true, input);
        break;
      case "tap":
        this.tap(input);
        break;
      case "hot-cue":
        this.hotCue(action.deck, action.slot, action.erase, input);
        break;
      case "cut":
        this.cut(action.deck, action.open, input);
        break;
      case "toggle-legend":
        this.legendToggle?.();
        break;
    }
    return true;
  }

  /** Handles a key release. Modifiers are ignored, so releasing Z while holding Cmd still releases CUE. */
  keyUp(event: Pick<KeyboardEventLike, "code" | "timeStamp">): boolean {
    const binding = bindingFor(event.code, NO_MODIFIERS);
    // Only a key whose press was accepted is released.
    if (binding === null || !this.heldKeys.delete(event.code)) return false;
    if (binding.action.kind === "deck-cue") this.deckCue(binding.action.deck, false, { device: "keyboard", eventTimeMs: event.timeStamp });
    return true;
  }

  // ---- internals -----------------------------------------------------------------------------

  /** Finishes an open gesture once; returns whether it was open. */
  private close(key: string, eventTimeMs: number | undefined): boolean {
    const gesture = this.open.get(key);
    if (gesture === undefined) return false;
    this.open.delete(key);
    gesture.finish(eventTimeMs);
    return true;
  }

  private send(command: EngineCommand, input: CommandInput): Result {
    const result = this.engine.command(command, { ...input, gestureEnd: input.gestureEnd ?? false });
    if (!result.ok) console.warn(`[controller] ${command.control} was refused: ${result.error.kind}`);
    return result;
  }

  private bpmOf(deck: DeckId, state: EngineDeckSnapshot): number | null {
    const grid = this.engine.trackHistory(deck).at(-1)?.grid ?? null;
    return grid === null || state.trackId === null ? null : grid.bpm * state.tempoRate;
  }

  private update(changes: Partial<ControllerSnapshot>): void {
    this.current = { ...this.current, ...changes };
    for (const listener of this.listeners) listener();
  }
}

/** A command input with the event time when there is one; without it the engine uses "now". */
function withTime(input: { device: InputDevice; gestureEnd: boolean }, eventTimeMs: number | undefined): CommandInput {
  return eventTimeMs === undefined ? input : { ...input, eventTimeMs };
}
