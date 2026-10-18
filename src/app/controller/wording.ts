// Captions are authored for the keyboard ("Press X", "Push the fader up (W)"). On a touchscreen a key
// means nothing, so the same caption is reworded at render time to name the control ("Tap PLAY").
// The key-to-control map is the keyboard's own (keymap.ts); nothing here repeats it.
//
// Which wording to use: touch wording on a coarse primary pointer (a phone or tablet), key wording on a
// fine one (a trackpad or mouse). It follows the Learner's hands afterwards: a key press switches to key
// wording (a tablet with a keyboard), a finger on the screen switches to touch wording.

import { useSyncExternalStore } from "react";
import { KEY_BINDINGS, type KeyBinding } from "./keymap.ts";

export type Wording = "keys" | "touch";

/** How a key's action reads on a touchscreen. */
interface TouchWords {
  /** Replaces "Press K" (or "Tap K"): a whole instruction. */
  readonly press: string;
  /** Replaces " (K)"; null drops the aside, when the caption already says what to do. */
  readonly aside: string | null;
  /** Replaces a bare K in a sentence ("…then W right away"). */
  readonly bare: string;
}

function touchWords(binding: KeyBinding): TouchWords | null {
  const { action } = binding;
  const onDeck = (deck: "A" | "B") => (deck === "B" ? " on deck B" : "");
  switch (action.kind) {
    case "play-pause": {
      const name = `PLAY${onDeck(action.deck)}`;
      return { press: `Tap ${name}`, aside: name, bare: name };
    }
    case "deck-cue": {
      const name = `CUE${onDeck(action.deck)}`;
      return { press: `Hold ${name}`, aside: name, bare: name };
    }
    case "tap":
      return { press: "Tap TAP", aside: "TAP", bare: "TAP" };
    case "hot-cue": {
      const name = `pad ${String(action.slot + 1)}${onDeck(action.deck)}`;
      return { press: `Tap ${name}`, aside: name, bare: name };
    }
    case "cut": {
      const fader = action.deck === "A" ? "the fader" : "fader B";
      const deed = action.open ? `push ${fader} up` : `pull ${fader} down`;
      return { press: deed.charAt(0).toUpperCase() + deed.slice(1), aside: null, bare: deed };
    }
    case "crossfader-cut": {
      const deed = `snap the crossfader to ${action.side}`;
      return { press: deed.charAt(0).toUpperCase() + deed.slice(1), aside: null, bare: deed };
    }
    case "jog-nudge": {
      const jog = `jog ${action.deck}`;
      return { press: `Turn ${jog} ${action.faster ? "forward" : "back"}`, aside: null, bare: jog };
    }
    case "loop-in":
    case "loop-out": {
      const name = `${action.kind === "loop-in" ? "LOOP IN" : "LOOP OUT"}${onDeck(action.deck)}`;
      return { press: `Tap ${name}`, aside: null, bare: name };
    }
    case "loop-button": {
      const name = `4 BEAT/EXIT${onDeck(action.deck)}`;
      return { press: `Tap ${name}`, aside: null, bare: name };
    }
    case "loop-call": {
      const name = `${action.step < 0 ? "½X" : "2X"}${onDeck(action.deck)}`;
      return { press: `Tap ${name}`, aside: null, bare: name };
    }
    case "beat-fx-on":
      return { press: "Tap BEAT FX ON", aside: null, bare: "BEAT FX ON" };
    case "beat-fx-beat": {
      const name = action.step < 0 ? "BEAT ◀" : "BEAT ▶";
      return { press: `Tap ${name}`, aside: null, bare: name };
    }
    case "toggle-legend":
      return null;
  }
}

/**
 * B's two nudge keys named together, as captions give them: "Turn jog B (← →)". On a touchscreen the
 * jog wheel is the way to nudge, and the caption already names it.
 */
const NUDGE_KEYS_B = "← →";
const NUDGE_WORDS_B: TouchWords = { press: "Turn jog B", aside: null, bare: "jog B" };

/** The Lesson's own Ready key (lesson-keys.ts, not a controller key): the Ready button on a touchscreen. */
const READY_WORDS: TouchWords = { press: "Tap Ready", aside: null, bare: "Ready" };

const WORDS_BY_LABEL: ReadonlyMap<string, TouchWords> = new Map([
  ...KEY_BINDINGS.flatMap((binding) => {
    const words = touchWords(binding);
    return words === null ? [] : [[binding.label, words] as const];
  }),
  ["R", READY_WORDS] as const,
  [NUDGE_KEYS_B, NUDGE_WORDS_B] as const,
]);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyLabel = [...WORDS_BY_LABEL.keys()].map(escape).join("|");
// Only letters and Space are safe to rewrite on their own: digits ("Count in: 1, 2, 3, 4") and
// punctuation also mean themselves.
const bareLabels = [...WORDS_BY_LABEL.keys()].filter((label) => /^(?:[A-Z]|Space)$/.test(label)).map(escape);

const PRESS = new RegExp(`\\b(?:Press|Hit|Tap) (${anyLabel})(?=$|[\\s.,;:!?)])`, "g");
const ASIDE = new RegExp(` \\((${anyLabel})\\)`, "g");
// Uppercase-only and whole-word, so "Deck A" (A is not bound) and words like "MASTER" never match;
// nor does the X of ½X (the loop's half).
const BARE = new RegExp(`(?<![\\w(½])(${bareLabels.join("|")})(?![\\w)])`, "g");

function wordsFor(label: string): TouchWords {
  const words = WORDS_BY_LABEL.get(label);
  if (words === undefined) throw new Error(`No touch wording for the key "${label}"; the patterns are built from the same map.`);
  return words;
}

/**
 * A caption in the wording for the Learner's input: unchanged for keys, control names for touch. With a
 * controller connected, `tapOnHardware` names its TAP controls first: "Tap SHIFT + BEAT ▶ (TAP), any
 * pad or Space on every kick", "Tap every beat (SHIFT + BEAT ▶, any pad or Space)".
 */
export function inputWording(text: string, wording: Wording, tapOnHardware: string | null = null): string {
  const tapped =
    tapOnHardware === null
      ? text
      : text.replace(/\bTap Space\b/g, `Tap ${tapOnHardware} or Space`).replace(/ \(Space\)/g, ` (${tapOnHardware.replace(" (TAP)", "")} or Space)`);
  if (wording === "keys") return tapped;
  return tapped
    .replace(PRESS, (_match, label: string) => wordsFor(label).press)
    .replace(ASIDE, (_match, label: string) => {
      const aside = wordsFor(label).aside;
      return aside === null ? "" : ` (${aside})`;
    })
    .replace(BARE, (_match, label: string) => wordsFor(label).bare);
}

export function startingWording(device: { readonly coarsePointer: boolean }): Wording {
  return device.coarsePointer ? "touch" : "keys";
}

// ---- the Learner's current wording, shared by every component that shows a caption ----------

const COARSE_POINTER = "(pointer: coarse)";
let current: Wording | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

function set(next: Wording): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function attach(): () => void {
  const media = window.matchMedia(COARSE_POINTER);
  const onKey = () => {
    set("keys");
  };
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType === "touch") set("touch");
  };
  const onMedia = () => {
    set(startingWording({ coarsePointer: media.matches }));
  };
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("pointerdown", onPointer, { capture: true });
  media.addEventListener("change", onMedia);
  return () => {
    window.removeEventListener("keydown", onKey, { capture: true });
    window.removeEventListener("pointerdown", onPointer, { capture: true });
    media.removeEventListener("change", onMedia);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  detach ??= attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach !== null) {
      detach();
      detach = null;
    }
  };
}

function snapshot(): Wording {
  current ??= startingWording({ coarsePointer: window.matchMedia(COARSE_POINTER).matches });
  return current;
}

/** The wording for the Learner's input right now; re-renders when they switch hands. */
export function useWording(): Wording {
  return useSyncExternalStore(subscribe, snapshot, () => "keys");
}
