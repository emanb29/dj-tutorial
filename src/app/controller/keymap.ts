// Keyboard bindings for timing-critical actions (check-design "Input leeway"): a key press is the most
// precise input a laptop has. Bindings use KeyboardEvent.code, the physical key, so they sit in the same
// place on any layout. Deck A is under the left hand, deck B under the right.

import type { DeckId } from "@audio";
import { deckControl, type ControlId } from "./control-ids.ts";

export type KeyAction =
  | { kind: "play-pause"; deck: DeckId }
  /** Held: the deck CUE button is down while the key is. */
  | { kind: "deck-cue"; deck: DeckId }
  | { kind: "tap" }
  /** `slot` is 0-based. With `erase`, the hot cue is deleted instead of triggered (SHIFT + pad). */
  | { kind: "hot-cue"; deck: DeckId; slot: number; erase: boolean }
  /** Snap the channel fader fully open or fully closed. */
  | { kind: "cut"; deck: DeckId; open: boolean }
  /** Snap the crossfader fully to one side (a crossfader cut). */
  | { kind: "crossfader-cut"; side: DeckId }
  /** Held: bends the playing deck slower or faster, as a jog wheel nudge (Shift for a smaller bend). */
  | { kind: "jog-nudge"; deck: DeckId; faster: boolean }
  /** LOOP IN and LOOP OUT. With SHIFT (IN ADJ, OUT ADJ: not in v1) they say "not yet". */
  | { kind: "loop-in" | "loop-out"; deck: DeckId; shift: boolean }
  /** CUE/LOOP CALL ◀ (-1, ½X) or ▶ (+1, 2X). With SHIFT (cue delete, memory: not in v1) they say "not yet". */
  | { kind: "loop-call"; deck: DeckId; step: -1 | 1; shift: boolean }
  /** 4 BEAT/EXIT: a 4-beat loop, or out of the loop playing now. */
  | { kind: "loop-button"; deck: DeckId }
  | { kind: "beat-fx-on" }
  /** BEAT ◀ (-1) or ▶ (+1); with SHIFT, AUTO (◀) and TAP (▶), the Beat FX tempo. */
  | { kind: "beat-fx-beat"; step: -1 | 1; shift: boolean }
  | { kind: "toggle-legend" };

type ShiftedKind = "hot-cue" | "loop-in" | "loop-out" | "loop-call" | "beat-fx-beat";
type BoundAction =
  | Exclude<KeyAction, { kind: ShiftedKind }>
  | { kind: "hot-cue"; deck: DeckId; slot: number }
  | { kind: "loop-in" | "loop-out"; deck: DeckId }
  | { kind: "loop-call"; deck: DeckId; step: -1 | 1 }
  | { kind: "beat-fx-beat"; step: -1 | 1 };

export interface KeyBinding {
  readonly code: string;
  /** What the key cap says, for the legend. */
  readonly label: string;
  readonly action: BoundAction;
  /** The control that must be unlocked for the key to work; null for the legend toggle. */
  readonly control: ControlId | null;
  readonly description: string;
}

function controlOf(action: BoundAction): ControlId | null {
  switch (action.kind) {
    case "play-pause":
      return deckControl(action.deck, "play");
    case "deck-cue":
      return deckControl(action.deck, "cue");
    case "hot-cue":
      return deckControl(action.deck, "hot-cue");
    case "cut":
      return deckControl(action.deck, "channel-fader");
    case "crossfader-cut":
      return "crossfader";
    case "jog-nudge":
      return deckControl(action.deck, "jog-bend");
    case "loop-in":
    case "loop-out":
      return deckControl(action.deck, action.kind);
    case "loop-button":
      return deckControl(action.deck, "loop-exit");
    case "loop-call":
      return deckControl(action.deck, action.step < 0 ? "loop-halve" : "loop-double");
    case "beat-fx-on":
      return "beat-fx-on";
    case "beat-fx-beat":
      return "beat-fx-beat";
    case "tap":
      return "tap";
    case "toggle-legend":
      return null;
  }
}

function bind(code: string, label: string, action: BoundAction, description: string): KeyBinding {
  return { code, label, action, control: controlOf(action), description };
}

const hotCueKeys = (deck: DeckId, digits: readonly string[]) =>
  digits.map((digit, slot) => bind(`Digit${digit}`, digit, { kind: "hot-cue", deck, slot }, `Hot cue ${String(slot + 1)}`));

export const KEY_BINDINGS: readonly KeyBinding[] = [
  bind("KeyZ", "Z", { kind: "deck-cue", deck: "A" }, "CUE (hold)"),
  bind("KeyX", "X", { kind: "play-pause", deck: "A" }, "PLAY/PAUSE"),
  bind("KeyW", "W", { kind: "cut", deck: "A", open: true }, "Fader open"),
  bind("KeyS", "S", { kind: "cut", deck: "A", open: false }, "Fader closed"),
  ...hotCueKeys("A", ["1", "2", "3", "4"]),
  bind("KeyQ", "Q", { kind: "jog-nudge", deck: "A", faster: false }, "Nudge slower (hold)"),
  bind("KeyE", "E", { kind: "jog-nudge", deck: "A", faster: true }, "Nudge faster (hold)"),
  bind("KeyD", "D", { kind: "loop-in", deck: "A" }, "LOOP IN"),
  bind("KeyF", "F", { kind: "loop-out", deck: "A" }, "LOOP OUT"),
  bind("KeyG", "G", { kind: "loop-button", deck: "A" }, "4 BEAT/EXIT"),
  // CUE/LOOP CALL: on the number row after the deck's hot cues, ◀ then ▶ as on the panel.
  bind("Digit5", "5", { kind: "loop-call", deck: "A", step: -1 }, "½X (CUE/LOOP CALL ◀)"),
  bind("Digit6", "6", { kind: "loop-call", deck: "A", step: 1 }, "2X (CUE/LOOP CALL ▶)"),
  bind("KeyM", "M", { kind: "deck-cue", deck: "B" }, "CUE (hold)"),
  bind("Comma", ",", { kind: "play-pause", deck: "B" }, "PLAY/PAUSE"),
  bind("KeyO", "O", { kind: "cut", deck: "B", open: true }, "Fader open"),
  bind("KeyL", "L", { kind: "cut", deck: "B", open: false }, "Fader closed"),
  ...hotCueKeys("B", ["7", "8", "9", "0"]),
  bind("ArrowLeft", "←", { kind: "jog-nudge", deck: "B", faster: false }, "Nudge slower (hold)"),
  bind("ArrowRight", "→", { kind: "jog-nudge", deck: "B", faster: true }, "Nudge faster (hold)"),
  bind("KeyY", "Y", { kind: "loop-in", deck: "B" }, "LOOP IN"),
  bind("KeyU", "U", { kind: "loop-out", deck: "B" }, "LOOP OUT"),
  bind("KeyJ", "J", { kind: "loop-button", deck: "B" }, "4 BEAT/EXIT"),
  bind("Minus", "-", { kind: "loop-call", deck: "B", step: -1 }, "½X (CUE/LOOP CALL ◀)"),
  bind("Equal", "=", { kind: "loop-call", deck: "B", step: 1 }, "2X (CUE/LOOP CALL ▶)"),
  bind("KeyC", "C", { kind: "crossfader-cut", side: "A" }, "Crossfader to A"),
  bind("KeyN", "N", { kind: "crossfader-cut", side: "B" }, "Crossfader to B"),
  bind("KeyV", "V", { kind: "beat-fx-on" }, "BEAT FX ON/OFF"),
  bind("BracketLeft", "[", { kind: "beat-fx-beat", step: -1 }, "BEAT ◀ (Shift: AUTO)"),
  bind("BracketRight", "]", { kind: "beat-fx-beat", step: 1 }, "BEAT ▶ (Shift: TAP)"),
  bind("Space", "Space", { kind: "tap" }, "Tap the beat"),
  bind("Slash", "?", { kind: "toggle-legend" }, "Show or hide keys"),
];

const BY_CODE: ReadonlyMap<string, KeyBinding> = new Map(KEY_BINDINGS.map((binding) => [binding.code, binding]));

export interface KeyModifiers {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** The binding for a physical key, or null. Keys held with Ctrl, Cmd or Alt stay browser shortcuts. */
export function bindingFor(code: string, modifiers: KeyModifiers): KeyBinding | null {
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return null;
  return BY_CODE.get(code) ?? null;
}

/** What the global key handler needs to know about the focused element. */
export interface FocusedElement {
  readonly tagName: string;
  readonly role: string | null;
  readonly isContentEditable: boolean;
}

const TEXT_ENTRY_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const ACTIVATION_KEYS: ReadonlySet<string> = new Set(["Space", "Enter", "NumpadEnter"]);
const SLIDER_KEYS: ReadonlySet<string> = new Set([...ACTIVATION_KEYS, "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * Whether a global key binding may act on a key press, given the focused element. Text entry and IME
 * composition keep every key. A focused button, link or slider keeps the keys it uses itself (Space and
 * Enter; a slider also its arrows), but deck keys still work: hardware buttons do not take focus on a
 * click (ControlButton), so these cases only arise when the Learner tabs to a control.
 */
export function globalKeyAllowed(focused: FocusedElement | null, code: string, isComposing: boolean): boolean {
  if (isComposing) return false;
  if (focused === null) return true;
  if (focused.isContentEditable || TEXT_ENTRY_TAGS.has(focused.tagName)) return false;
  if (focused.role === "slider") return !SLIDER_KEYS.has(code);
  if (focused.tagName === "BUTTON" || focused.tagName === "A" || focused.role === "button") return !ACTIVATION_KEYS.has(code);
  return true;
}

/** Key cap labels bound to a control, for hints on the controller ("W/S" for a channel fader). */
export function keyHintFor(control: ControlId): string | null {
  const labels = KEY_BINDINGS.filter((binding) => binding.control === control && binding.action.kind !== "hot-cue").map((binding) => binding.label);
  return labels.length === 0 ? null : labels.join("/");
}

/** The key cap for one hot cue pad (0-based slot), if it has one. */
export function hotCueKeyHint(deck: DeckId, slot: number): string | null {
  const binding = KEY_BINDINGS.find((candidate) => candidate.action.kind === "hot-cue" && candidate.action.deck === deck && candidate.action.slot === slot);
  return binding?.label ?? null;
}

export function resolveKey(code: string, modifiers: KeyModifiers): KeyAction | null {
  const binding = bindingFor(code, modifiers);
  if (binding === null) return null;
  return withShift(binding.action, modifiers.shiftKey);
}

/** A bound action with the Shift key's meaning: erase a hot cue; a loop button's SHIFT layer. */
export function withShift(action: BoundAction, shiftKey: boolean): KeyAction {
  switch (action.kind) {
    case "hot-cue":
      return { ...action, erase: shiftKey };
    case "loop-in":
    case "loop-out":
    case "loop-call":
    case "beat-fx-beat":
      return { ...action, shift: shiftKey };
    default:
      return action;
  }
}
