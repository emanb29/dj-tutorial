// Shared vocabulary of the audio engine. Attempt-facing types come from the canonical contract.

import type { DeckId, InputDevice } from "@shared/attempt.ts";

export type { CtxTime, DeckId, InputDevice } from "@shared/attempt.ts";

export const DECK_IDS: readonly DeckId[] = ["A", "B"];

export function otherDeck(deck: DeckId): DeckId {
  return deck === "A" ? "B" : "A";
}

export const INPUT_DEVICES: readonly InputDevice[] = ["keyboard", "trackpad", "mouse", "touch", "midi"];
