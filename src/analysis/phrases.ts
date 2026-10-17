// Phrase hints: dance music moves in 8-bar phrases, so every 8-bar boundary from bar 1 is a
// candidate. Each hint carries the level change across it (8 bars after vs 8 bars before), which
// is where drops and breakdowns show up. These are hints for the UI and the Coach, not detected
// sections.

import type { PhraseHint, WaveformOverview } from "./types.ts";

const BARS_PER_PHRASE = 8;
const BEATS_PER_BAR = 4;
/** Level changes smaller than this count as steady. */
const STEADY_DB = 3;

interface BarGrid {
  readonly bpm: number;
  readonly firstBeatSec: number;
  readonly downbeatPhase: number | null;
}

/** Mean power (all three bands) over the buckets in [fromSec, toSec). */
function meanPower(overview: WaveformOverview, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.floor(fromSec / overview.bucketSec));
  const to = Math.min(overview.low.length, Math.floor(toSec / overview.bucketSec));
  let sum = 0;
  for (let b = from; b < to; b++) {
    sum += (overview.low[b] ?? 0) ** 2 + (overview.mid[b] ?? 0) ** 2 + (overview.high[b] ?? 0) ** 2;
  }
  return to > from ? sum / (to - from) : 0;
}

export function phraseHints(grid: BarGrid, overview: WaveformOverview, durationSec: number): PhraseHint[] {
  const beatSec = 60 / grid.bpm;
  const phraseSec = BARS_PER_PHRASE * BEATS_PER_BAR * beatSec;
  const bar1Sec = grid.firstBeatSec + (grid.downbeatPhase ?? 0) * beatSec;
  const count = Math.floor((durationSec - bar1Sec) / phraseSec);
  // Boundary k starts bar 1 + 8k; it needs a whole phrase before it and after it.
  const boundaries = Array.from({ length: Math.max(0, count - 1) }, (_, i) => i + 1).filter(
    // A first beat may sit up to 50 ms before the track starts (grid-fit.ts START_TOLERANCE_SEC).
    (k) => bar1Sec + (k - 1) * phraseSec >= -0.06 && bar1Sec + (k + 1) * phraseSec <= durationSec + 1e-9,
  );
  return boundaries.map((k) => {
    const timeSec = bar1Sec + k * phraseSec;
    const before = meanPower(overview, timeSec - phraseSec, timeSec);
    const after = meanPower(overview, timeSec, timeSec + phraseSec);
    const energyChangeDb = 10 * Math.log10((after + 1e-12) / (before + 1e-12));
    const kind = energyChangeDb >= STEADY_DB ? "energy-up" : energyChangeDb <= -STEADY_DB ? "energy-down" : "steady";
    return { timeSec, bar: 1 + k * BARS_PER_PHRASE, energyChangeDb, kind };
  });
}
