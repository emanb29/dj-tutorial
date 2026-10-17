// Live feedback during the hook and practice: where a tap landed on the playing track's grid.
// The Check grades taps itself, on the recorded attempt; this is only what the strip shows.
import { TAP_TOLERANCE_MS } from "@checks";
import type { BeatGrid } from "@shared/attempt.ts";
import type { Observation } from "./types.ts";

const BEATS_PER_BAR = 4;

/** A tap heard at track position `positionSec`, placed on the grid. */
export function classifyTap(grid: BeatGrid, phraseStarts: readonly number[], positionSec: number): Extract<Observation, { kind: "tap" }> {
  const beatLength = 60 / grid.bpm;
  const beat = (positionSec - grid.firstBeat) / beatLength;
  const nearest = Math.round(beat);
  const offsetMs = Math.round((beat - nearest) * beatLength * 1000 * 10) / 10;
  const onBeat = Math.abs(offsetMs) <= TAP_TOLERANCE_MS;
  const inBar = (((nearest - grid.downbeatIndex) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  return {
    kind: "tap",
    offsetMs,
    onBeat,
    onDownbeat: onBeat && inBar === 0,
    onPhraseStart: phraseStarts.some((start) => Math.abs(positionSec - start) <= beatLength),
  };
}
