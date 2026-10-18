// LED output for the DDJ-FLX4, from the MIDI-OUT column of AlphaTheta's list (docs/research/flx4-midi.md).
// The unit shows a button's SHIFT-layer LED while SHIFT is held, so a LED that means the same with and
// without SHIFT is written to both layers.

import type { DeckId } from "@audio";

const ON = 0x7f;
const OFF = 0x00;

type DeckLed = "play" | "cue" | "sync" | "master-tempo" | "headphone-cue" | "loop-in" | "loop-out" | "pad-mode-hot-cue" | `pad-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export type LedId = `${DeckId}.${DeckLed}` | "fx-on";

/** Note numbers on the deck's channel, every layer that shows the same state. */
const DECK_LED_NOTES: Readonly<Record<Exclude<DeckLed, `pad-${number}`>, readonly number[]>> = {
  play: [0x0b, 0x0e],
  cue: [0x0c, 0x48],
  sync: [0x58],
  // The FLX4 has no MASTER TEMPO button: BEAT SYNC's SHIFT-layer LED shows it (an app decision).
  "master-tempo": [0x60],
  "headphone-cue": [0x54, 0x68],
  "loop-in": [0x10, 0x4c],
  "loop-out": [0x11, 0x4e],
  "pad-mode-hot-cue": [0x1b],
};

const DECK_STATUS: Readonly<Record<DeckId, number>> = { A: 0x90, B: 0x91 };
/** HOT CUE pads: the deck's pad channel and its SHIFT channel; the pad's note is its 0-based number. */
const PAD_STATUSES: Readonly<Record<DeckId, readonly number[]>> = { A: [0x97, 0x98], B: [0x99, 0x9a] };
const DECKS: readonly DeckId[] = ["A", "B"];
const PADS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const ALL_LEDS: readonly LedId[] = [
  ...DECKS.flatMap((deck) => [...Object.keys(DECK_LED_NOTES), ...PADS.map((pad) => `pad-${String(pad)}`)].map((led) => `${deck}.${led}` as LedId)),
  "fx-on",
];

export function ledMessages(id: LedId, on: boolean): number[][] {
  const value = on ? ON : OFF;
  // FX ON/OFF: note 4 of the list, a NOTE ON makes it blink (effect on), a NOTE OFF value lights it.
  if (id === "fx-on") return [[0x94, 0x47, value]];
  const deck: DeckId = id.startsWith("A.") ? "A" : "B";
  const led = id.slice(2) as DeckLed;
  const pad = /^pad-([1-8])$/.exec(led)?.[1];
  if (pad !== undefined) return PAD_STATUSES[deck].map((status) => [status, Number(pad) - 1, value]);
  return DECK_LED_NOTES[led as Exclude<DeckLed, `pad-${number}`>].map((note) => [DECK_STATUS[deck], note, value]);
}

/** One value per LED step (green 1, green 2, orange 1, orange 2, red), each the bottom of its range in the list. */
const METER_STEPS = [0x26, 0x41, 0x57, 0x65] as const;
const METER_RED = 0x77;

/**
 * The level meter value for a meter height (0…1, the virtual meter's own fraction, where 1 is clipping).
 * Quantized to the five LEDs, so a meter that moves within one LED sends nothing new.
 */
export function levelMeterValue(fraction: number): number {
  if (fraction >= 1) return METER_RED;
  if (fraction <= 0) return OFF;
  const step = Math.min(METER_STEPS.length - 1, Math.floor(fraction * METER_STEPS.length));
  return METER_STEPS[step] ?? OFF;
}

export function levelMeterMessage(deck: DeckId, fraction: number): number[] {
  return [deck === "A" ? 0xb0 : 0xb1, 0x02, levelMeterValue(fraction)];
}

/** "Track Load Illumination": the jog ring's load animation on one deck. */
export function trackLoadedMessage(deck: DeckId): number[] {
  return [0x9f, deck === "A" ? 0x00 : 0x01, ON];
}

/** Every LED and both level meters off: on disconnect, and before the app takes over. */
export function allLedsOff(): number[][] {
  return [...ALL_LEDS.flatMap((id) => ledMessages(id, false)), levelMeterMessage("A", 0), levelMeterMessage("B", 0)];
}
