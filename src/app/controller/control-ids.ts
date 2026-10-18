// Every part of the virtual controller that a Lesson can unlock, pulse or caption.
// Layout follows the AlphaTheta DDJ-FLX4 (research/entry-level-controllers §3): two deck columns and a
// centre mixer. Displays (meters, BPM, phase meter) are listed too, because Lessons reveal or cover them.

import type { DeckId } from "@audio";

const DECK_PARTS = [
  "play",
  "cue",
  "sync",
  "shift",
  "jog",
  /** Turning the jog on a playing deck bends pitch (the nudge-phase Lesson); `jog` alone is search while paused. */
  "jog-bend",
  "hot-cue",
  /** The loop buttons: LOOP IN (SHIFT: ½X), LOOP OUT (SHIFT: 2X) and 4 BEAT/EXIT. */
  "loop-in",
  "loop-out",
  "loop-exit",
  "tempo",
  "tempo-range",
  "master-tempo",
  "bpm",
  "trim",
  "eq-high",
  "eq-mid",
  "eq-low",
  "filter",
  "headphone-cue",
  "level-meter",
  "channel-fader",
] as const;

export type DeckPart = (typeof DECK_PARTS)[number];
export type DeckControlId = `${DeckId}.${DeckPart}`;

const SHARED_PARTS = [
  "crossfader",
  "master-level",
  "master-meter",
  "headphone-level",
  "cue-mix",
  "phase-meter",
  "tap",
  /** Beat FX: the effect shown (ECHO only in v1), CH SELECT, BEAT ◀/▶, LEVEL/DEPTH and ON/OFF. */
  "beat-fx-select",
  "beat-fx-channel",
  "beat-fx-beat",
  "beat-fx-depth",
  "beat-fx-on",
] as const;
export type SharedControlId = (typeof SHARED_PARTS)[number];

export type ControlId = DeckControlId | SharedControlId;

/** The controls a Learner may use now. Anything not in the set is shown dimmed and ignores input. */
export type ControllerUnlocks = ReadonlySet<ControlId>;

export function deckControl(deck: DeckId, part: DeckPart): DeckControlId {
  return `${deck}.${part}`;
}

export const ALL_CONTROL_IDS: readonly ControlId[] = [
  ...DECK_PARTS.map((part) => deckControl("A", part)),
  ...DECK_PARTS.map((part) => deckControl("B", part)),
  ...SHARED_PARTS,
];

const KNOWN_IDS: ReadonlySet<string> = new Set(ALL_CONTROL_IDS);

export function isControlId(text: string): text is ControlId {
  return KNOWN_IDS.has(text);
}

/** Parses a comma-separated list of control ids, collecting every unknown id rather than stopping at the first. */
export function parseControlIds(text: string): { ids: ControlId[]; unknown: string[] } {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { ids: parts.filter(isControlId), unknown: parts.filter((part) => !isControlId(part)) };
}
