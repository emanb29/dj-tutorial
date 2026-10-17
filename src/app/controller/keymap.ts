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
  | { kind: "toggle-legend" };

type BoundAction = Exclude<KeyAction, { kind: "hot-cue" }> | { kind: "hot-cue"; deck: DeckId; slot: number };

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
  bind("KeyM", "M", { kind: "deck-cue", deck: "B" }, "CUE (hold)"),
  bind("Comma", ",", { kind: "play-pause", deck: "B" }, "PLAY/PAUSE"),
  bind("KeyO", "O", { kind: "cut", deck: "B", open: true }, "Fader open"),
  bind("KeyL", "L", { kind: "cut", deck: "B", open: false }, "Fader closed"),
  ...hotCueKeys("B", ["7", "8", "9", "0"]),
  bind("KeyC", "C", { kind: "crossfader-cut", side: "A" }, "Crossfader to A"),
  bind("KeyN", "N", { kind: "crossfader-cut", side: "B" }, "Crossfader to B"),
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
  const { action } = binding;
  return action.kind === "hot-cue" ? { ...action, erase: modifiers.shiftKey } : action;
}
