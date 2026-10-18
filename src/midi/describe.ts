// Words for the Controller page: what a decoded message was, in the panel's own labels, and the list
// of every physical control for the "move every control" check.

import type { DeckId } from "@audio";
import type { Flx4Input, PadMode } from "./decoder.ts";

const PAD_MODE_NAMES: Readonly<Record<PadMode, string>> = {
  "hot-cue": "HOT CUE",
  "pad-fx-1": "PAD FX1",
  "beat-jump": "BEAT JUMP",
  sampler: "SAMPLER",
  keyboard: "KEYBOARD",
  "pad-fx-2": "PAD FX2",
  "beat-loop": "BEAT LOOP",
  "key-shift": "KEY SHIFT",
};

const BUTTON_NAMES: Readonly<Record<string, string>> = {
  play: "PLAY/PAUSE",
  cue: "CUE",
  shift: "SHIFT",
  sync: "BEAT SYNC",
  "sync-long": "BEAT SYNC (held)",
  "headphone-cue": "channel CUE",
  "loop-in": "IN",
  "loop-out": "OUT",
  "loop-exit": "4 BEAT/EXIT",
  "call-back": "CUE/LOOP CALL ◀",
  "call-forward": "CUE/LOOP CALL ▶",
  load: "LOAD",
  "fader-start": "fader start",
  "master-cue": "MASTER CUE",
  "smart-cfx": "SMART CFX",
  "smart-fader": "SMART FADER",
  "mono-stereo": "MONO/STEREO switch",
  "browse-press": "BROWSE (press)",
  "fx-select": "FX SELECT",
  "fx-beat-back": "BEAT ◀",
  "fx-beat-forward": "BEAT ▶ (TAP)",
  "fx-on": "FX ON/OFF",
};

const CONTINUOUS_NAMES: Readonly<Record<string, string>> = {
  tempo: "TEMPO",
  trim: "TRIM",
  "eq-high": "HI",
  "eq-mid": "MID",
  "eq-low": "LOW",
  filter: "CFX",
  "channel-fader": "channel fader",
  crossfader: "crossfader",
  "master-level": "MASTER LEVEL",
  "mic-level": "MIC LEVEL",
  "headphone-mix": "HEADPHONES MIXING",
  "headphone-level": "HEADPHONES LEVEL",
  "beat-fx-depth": "LEVEL/DEPTH",
};

const deckPrefix = (deck: DeckId | null) => (deck === null ? "" : `Deck ${deck} `);
const shiftPrefix = (shift: boolean) => (shift ? "SHIFT + " : "");
const hex = (bytes: readonly number[]) => bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");

/** One line for the MIDI monitor: "Deck A PLAY/PAUSE pressed", "crossfader 43%". */
export function describeInput(input: Flx4Input): string {
  switch (input.kind) {
    case "button": {
      const name = input.control === "pad-mode" ? `${PAD_MODE_NAMES[input.mode]} mode` : (BUTTON_NAMES[input.control] ?? input.control);
      const what = input.control === "mono-stereo" ? (input.pressed ? "MONO" : "STEREO") : input.pressed ? "pressed" : "released";
      const shift = input.control === "pad-mode" || input.control === "sync-long" ? "" : shiftPrefix(input.shift);
      return `${deckPrefix(input.deck)}${shift}${name} ${what}`;
    }
    case "pad":
      return `Deck ${input.deck} ${shiftPrefix(input.shift)}pad ${String(input.pad + 1)} (${PAD_MODE_NAMES[input.mode]}) ${input.pressed ? "pressed" : "released"}`;
    case "continuous":
      return `${deckPrefix(input.deck)}${CONTINUOUS_NAMES[input.control] ?? input.control} ${String(Math.round(input.value * 100))}%`;
    case "jog-turn":
      return `Deck ${input.deck} ${shiftPrefix(input.shift)}jog ${input.surface === "side" ? "side" : "platter"} ${input.ticks > 0 ? "+" : ""}${String(input.ticks)}`;
    case "jog-touch":
      return `Deck ${input.deck} jog ${input.touched ? "touched" : "let go"}`;
    case "browse-turn":
      return `${shiftPrefix(input.shift)}BROWSE ${input.ticks > 0 ? "+" : ""}${String(input.ticks)}`;
    case "fx-channel":
      return `FX CH SELECT ${input.channels === "1&2" ? "1&2" : `CH${input.channels}`}`;
    case "unknown":
      return `Not in the FLX4 list: ${hex(input.bytes)}`;
  }
}

export interface ChecklistItem {
  /** physicalControlOf's id. */
  readonly id: string;
  readonly label: string;
  readonly group: string;
}

const deckItems = (deck: DeckId): ChecklistItem[] => {
  const group = `Deck ${deck}`;
  const item = (part: string, label: string) => ({ id: `${deck}.${part}`, label, group });
  return [
    item("play", "PLAY/PAUSE"),
    item("cue", "CUE"),
    item("shift", "SHIFT"),
    item("sync", "BEAT SYNC"),
    item("jog", "Jog wheel"),
    item("loop-in", "IN"),
    item("loop-out", "OUT"),
    item("loop-exit", "4 BEAT/EXIT"),
    item("call-back", "CUE/LOOP CALL ◀"),
    item("call-forward", "CUE/LOOP CALL ▶"),
    item("tempo", "TEMPO"),
    item("pad-mode-hot-cue", "HOT CUE"),
    item("pad-mode-pad-fx-1", "PAD FX1"),
    item("pad-mode-beat-jump", "BEAT JUMP"),
    item("pad-mode-sampler", "SAMPLER"),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((pad) => item(`pad-${String(pad)}`, `Pad ${String(pad)}`)),
    item("load", "LOAD"),
    item("trim", "TRIM"),
    item("eq-high", "HI"),
    item("eq-mid", "MID"),
    item("eq-low", "LOW"),
    item("filter", "CFX"),
    item("headphone-cue", "CUE (headphones)"),
    item("channel-fader", "Channel fader"),
  ];
};

const shared = (id: string, label: string, group: string): ChecklistItem => ({ id, label, group });

/** Every physical control on the DDJ-FLX4, grouped as on the panel. */
export const CHECKLIST: readonly ChecklistItem[] = [
  ...deckItems("A"),
  ...deckItems("B"),
  shared("master-level", "MASTER LEVEL", "Mixer"),
  shared("master-cue", "MASTER CUE", "Mixer"),
  shared("crossfader", "Crossfader", "Mixer"),
  shared("headphone-mix", "HEADPHONES MIXING", "Mixer"),
  shared("headphone-level", "HEADPHONES LEVEL", "Mixer"),
  shared("mic-level", "MIC LEVEL", "Mixer"),
  shared("smart-cfx", "SMART CFX", "Mixer"),
  shared("smart-fader", "SMART FADER", "Mixer"),
  shared("browse", "BROWSE (turn and press)", "Mixer"),
  shared("fx-select", "FX SELECT", "Beat FX"),
  shared("fx-beat-back", "BEAT ◀", "Beat FX"),
  shared("fx-beat-forward", "BEAT ▶ (TAP)", "Beat FX"),
  shared("beat-fx-depth", "LEVEL/DEPTH", "Beat FX"),
  shared("fx-channel", "CH SELECT lever", "Beat FX"),
  shared("fx-on", "FX ON/OFF", "Beat FX"),
  shared("mono-stereo", "MONO/STEREO switch (back)", "Back panel"),
];
