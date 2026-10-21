// The DDJ-FLX4's buttons for the app around the decks: moving between the page's buttons, pressing
// one, going back, and the Lesson keys (Enter, R, P, N). The one table: the app's navigation
// (src/app/ControllerNavigation.tsx) follows it, and every caption, hint and legend that names a key
// names its button from it, so the two cannot drift. Pure, so the mapping is testable without a DOM.
//
// | FLX4                 | Does                                                   | Keyboard        |
// | -------------------- | ------------------------------------------------------ | --------------- |
// | BROWSE turn          | moves the ring to the next or previous button          | Tab / Shift+Tab |
// | BROWSE press         | presses the button with the ring (a list: change it)   | Space           |
// | SHIFT + BROWSE press | back: leaves the Lesson, closes, skips                 | Esc             |
// | LOAD A               | go: into the Check, again, next, start                 | Enter           |
// | LOAD B               | Ready                                                  | R               |
// | SHIFT + LOAD A       | practice                                               | P               |
// | SHIFT + LOAD B       | Not yet (Placement)                                    | N               |
//
// Freestyle, the rekordbox way: BROWSE turns through the library's tracks, and LOAD A / LOAD B load the
// one with the ring onto that deck (a playing deck refuses, as on screen). A page takes LOAD over by
// handling the FLX4_LOAD_EVENT (focus-navigation.ts); everywhere else LOAD is Enter and R.

import type { Flx4Input } from "@midi";

/** A key the app's pages listen for, pressed from the FLX4 (the page's own key handler does the rest). */
export type ControllerKeyCode = "Enter" | "KeyR" | "KeyP" | "KeyN" | "Escape";

export type Flx4Command =
  /** BROWSE turn: `step` buttons on (negative: back), or a list's or slider's value while it is changed. */
  | { readonly kind: "move"; readonly step: number }
  /** BROWSE press: press the button with the ring. */
  | { readonly kind: "select" }
  /**
   * A key, as if pressed: LOAD A/B with or without SHIFT, SHIFT + BROWSE press (Esc). A plain LOAD names
   * its deck: a page with a library (Freestyle) loads the track with the ring onto it instead.
   */
  | { readonly kind: "key"; readonly code: ControllerKeyCode; readonly loadDeck?: "A" | "B" };

/** The FLX4 press that is a key: LOAD on a deck, or the BROWSE press, with or without SHIFT. */
export interface ControllerPress {
  readonly control: "load" | "browse-press";
  /** LOAD's deck; null for BROWSE. */
  readonly deck: "A" | "B" | null;
  readonly shift: boolean;
}

export interface ControllerButton {
  /** The key as hints print it ("Enter", "R"). */
  readonly key: string;
  readonly code: ControllerKeyCode;
  readonly press: ControllerPress;
  /** What it does, in a few words. */
  readonly does: string;
}

/** The keys the FLX4 presses, in the order the legend lists them. */
export const CONTROLLER_KEYS: readonly ControllerButton[] = [
  { key: "Enter", code: "Enter", press: { control: "load", deck: "A", shift: false }, does: "Go: into the Check, again, next, start · Freestyle: load onto A" },
  { key: "R", code: "KeyR", press: { control: "load", deck: "B", shift: false }, does: "Ready · Freestyle: load onto B" },
  { key: "P", code: "KeyP", press: { control: "load", deck: "A", shift: true }, does: "Practice" },
  { key: "N", code: "KeyN", press: { control: "load", deck: "B", shift: true }, does: "Not yet (Placement)" },
  { key: "Esc", code: "Escape", press: { control: "browse-press", deck: null, shift: true }, does: "Back: leave, close, skip" },
];

/** A press as the panel prints it: "LOAD A", "SHIFT + LOAD B", "SHIFT + BROWSE press". */
export function pressName(press: ControllerPress): string {
  const name = press.control === "load" ? `LOAD ${press.deck ?? ""}` : "BROWSE press";
  return press.shift ? `SHIFT + ${name}` : name;
}

/** Moving around a page, listed before the keys. */
export const NAVIGATION_BUTTONS: readonly { readonly button: string; readonly does: string; readonly key: string }[] = [
  { button: "BROWSE turn", does: "Move the ring between buttons", key: "Tab" },
  { button: "BROWSE press", does: "Press the button with the ring", key: "Space" },
];

const BY_KEY: ReadonlyMap<string, ControllerButton> = new Map(CONTROLLER_KEYS.map((entry) => [entry.key, entry]));

/** The FLX4 button for a key as hints print it ("Enter" → "LOAD A"), or null for a key it has none for. */
export function buttonForKey(key: string): string | null {
  const entry = BY_KEY.get(key === "Escape" ? "Esc" : key);
  return entry === undefined ? null : pressName(entry.press);
}

/** The same, short for a hint beside the key ("SHIFT + BROWSE press" → "SHIFT + BROWSE"). */
export function shortButtonForKey(key: string): string | null {
  return buttonForKey(key)?.replace(/ press$/, "") ?? null;
}

/** What a decoded FLX4 message means for the page around the decks, or null (a deck control, a release). */
export function flx4Command(input: Flx4Input): Flx4Command | null {
  if (input.kind === "browse-turn") return input.ticks === 0 ? null : { kind: "move", step: input.ticks };
  if (input.kind !== "button" || !input.pressed) return null;
  if (input.control !== "load" && input.control !== "browse-press") return null;
  const entry = CONTROLLER_KEYS.find(({ press }) => press.control === input.control && press.deck === input.deck && press.shift === input.shift);
  if (entry !== undefined) return input.control === "load" && !input.shift ? { kind: "key", code: entry.code, loadDeck: input.deck } : { kind: "key", code: entry.code };
  return input.control === "browse-press" ? { kind: "select" } : null;
}
