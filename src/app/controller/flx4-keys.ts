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
// | BROWSE press, a track| a library: preview it, play / pause (the mini player)  | Space           |
// | SHIFT + BROWSE turn  | a library: jump the preview 16 bars (30 s, no grid)    | ← / →           |
//
// Freestyle, the rekordbox way: BROWSE turns through the library's tracks, and LOAD A / LOAD B load the
// one with the ring onto that deck (a playing deck refuses, as on screen). A page takes LOAD over by
// handling the FLX4_LOAD_EVENT (focus-navigation.ts); everywhere else LOAD is Enter and R.
//
// The library's mini player (src/app/library-browser): BROWSE press with the ring on a track previews
// it (a track row has no button of its own to press), and SHIFT + BROWSE turn jumps the preview that
// plays. A page takes SHIFT + BROWSE turn by handling FLX4_PREVIEW_JUMP_EVENT; with no preview playing
// it moves the ring, as BROWSE turn does.
//
// The panel's controls a planned Transition plays (FLX4_LAYOUT, below) are here too: their names and
// which side of the unit each sits on, which the Mix Editor's Execution plan reads to name a move and
// pick its hand.

import type { DeckId } from "@audio";
import type { Flx4Input } from "@midi";
import type { DeckPart, SharedControlId } from "./control-ids.ts";

/** A key the app's pages listen for, pressed from the FLX4 (the page's own key handler does the rest). */
export type ControllerKeyCode = "Enter" | "KeyR" | "KeyP" | "KeyN" | "Escape";

export type Flx4Command =
  /** BROWSE turn: `step` buttons on (negative: back), or a list's or slider's value while it is changed. */
  | { readonly kind: "move"; readonly step: number }
  /** SHIFT + BROWSE turn: jump the library preview `step` times 16 bars; with none playing, a move. */
  | { readonly kind: "jump"; readonly step: number }
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

/** The library's mini player, with the ring on a track (src/app/library-browser). */
export const PREVIEW_BUTTONS = {
  play: { button: "BROWSE press", does: "On a track in a library: preview it (play / pause)", key: "Space" },
  jump: { button: "SHIFT + BROWSE turn", does: "Jump the preview 16 bars (30 s with no grid)", key: "← / →" },
} as const;

/** Moving around a page, listed before the keys. */
export const NAVIGATION_BUTTONS: readonly { readonly button: string; readonly does: string; readonly key: string }[] = [
  { button: "BROWSE turn", does: "Move the ring between buttons", key: "Tab" },
  { button: "BROWSE press", does: "Press the button with the ring", key: "Space" },
  PREVIEW_BUTTONS.play,
  PREVIEW_BUTTONS.jump,
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
  if (input.kind === "browse-turn") return input.ticks === 0 ? null : { kind: input.shift ? "jump" : "move", step: input.ticks };
  if (input.kind !== "button" || !input.pressed) return null;
  if (input.control !== "load" && input.control !== "browse-press") return null;
  const entry = CONTROLLER_KEYS.find(({ press }) => press.control === input.control && press.deck === input.deck && press.shift === input.shift);
  if (entry !== undefined) return input.control === "load" && !input.shift ? { kind: "key", code: entry.code, loadDeck: input.deck } : { kind: "key", code: entry.code };
  return input.control === "browse-press" ? { kind: "select" } : null;
}

/** The deck controls a planned move can use, with their names as printed on the panel. */
const PLANNED_DECK_PARTS = {
  play: "PLAY",
  cue: "CUE",
  tempo: "TEMPO",
  "eq-high": "HI",
  "eq-mid": "MID",
  "eq-low": "LOW",
  filter: "CFX",
  "channel-fader": "fader",
  "loop-in": "LOOP IN",
  "loop-out": "LOOP OUT",
  "loop-exit": "4 BEAT/EXIT",
} as const satisfies Partial<Record<DeckPart, string>>;

/** Where a control sits: deck A's half, deck B's half (Beat FX included), or the middle (the crossfader). */
export type LayoutSide = "left" | "right" | "centre";

/**
 * The mixer controls a planned move can use: the crossfader, and Beat FX (ECHO in v1) with CH SELECT, BEAT ◀/▶
 * (one control here, as on screen), LEVEL/DEPTH and ON/OFF. Beat FX sits in the mixer's right column.
 */
const PLANNED_SHARED_PARTS = {
  crossfader: { name: "crossfader", side: "centre", physical: ["crossfader"] },
  "beat-fx-on": { name: "BEAT FX ON", side: "right", physical: ["fx-on"] },
  "beat-fx-depth": { name: "LEVEL/DEPTH", side: "right", physical: ["beat-fx-depth"] },
  "beat-fx-channel": { name: "CH SELECT", side: "right", physical: ["fx-channel"] },
  "beat-fx-beat": { name: "BEAT ◀/▶", side: "right", physical: ["fx-beat-back", "fx-beat-forward"] },
} as const satisfies Partial<Record<SharedControlId, { name: string; side: LayoutSide; physical: readonly string[] }>>;

export type PlannedDeckPart = keyof typeof PLANNED_DECK_PARTS;
type PlannedSharedPart = keyof typeof PLANNED_SHARED_PARTS;
/** A control on the FLX4 that a planned move can use, by the app's control id (what a Lesson unlocks). */
export type Flx4Control = `${DeckId}.${PlannedDeckPart}` | PlannedSharedPart;

export interface Flx4LayoutControl {
  readonly id: Flx4Control;
  /** As captions print it: "LOW B", "fader A", "crossfader". */
  readonly name: string;
  readonly side: LayoutSide;
  readonly deck: DeckId | null;
  /** The MIDI decoder's ids for it (`physicalControlOf`): two for BEAT ◀/▶. */
  readonly physical: readonly string[];
}

const DECK_SIDES: Readonly<Record<DeckId, LayoutSide>> = { A: "left", B: "right" };

const deckLayout = (deck: DeckId): Flx4LayoutControl[] =>
  (Object.keys(PLANNED_DECK_PARTS) as PlannedDeckPart[]).map((part) => ({
    id: `${deck}.${part}`,
    name: `${PLANNED_DECK_PARTS[part]} ${deck}`,
    side: DECK_SIDES[deck],
    deck,
    physical: [`${deck}.${part}`],
  }));

/** Every control a planned move can use: deck A's, deck B's, then the mixer's. */
export const FLX4_LAYOUT: readonly Flx4LayoutControl[] = [
  ...deckLayout("A"),
  ...deckLayout("B"),
  ...(Object.keys(PLANNED_SHARED_PARTS) as PlannedSharedPart[]).map((id) => ({ id, deck: null, ...PLANNED_SHARED_PARTS[id] })),
];

const LAYOUT_BY_ID: ReadonlyMap<Flx4Control, Flx4LayoutControl> = new Map(FLX4_LAYOUT.map((control) => [control.id, control]));

/** A planned control's name and side. */
export function flx4LayoutControl(id: Flx4Control): Flx4LayoutControl {
  const control = LAYOUT_BY_ID.get(id);
  if (control === undefined) throw new Error(`${id} is not in FLX4_LAYOUT: add it to PLANNED_DECK_PARTS or PLANNED_SHARED_PARTS.`);
  return control;
}

/** A deck control's id, typed for the layout ("B", "eq-low" → "B.eq-low"). */
export function deckLayoutId(deck: DeckId, part: PlannedDeckPart): Flx4Control {
  return `${deck}.${part}`;
}
