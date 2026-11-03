// Where a Mix Plan's tracks play: on decks A and B in turn, each tempo-matched to the one before it
// with the decks' own SYNC arithmetic (src/audio/sync.ts). Turning lanes into commands is the
// Execution plan's and the Render's job (ISS-189, ISS-190); this is only the layout they start from.
import { syncTempo } from "@audio/sync.ts";
import type { TempoRangePercent } from "@audio/tempo.ts";
import type { DeckId } from "@audio/types.ts";
import type { PlanGrid } from "@shared/mix-plan.ts";

/** Track 1 on deck A, track 2 on B, track 3 on A again, and so on. */
export function deckOf(trackIndex: number): DeckId {
  return trackIndex % 2 === 0 ? "A" : "B";
}

export interface TrackTempo {
  /** Playback rate, as a deck's tempo fader sets it (1 is the track's own tempo). */
  readonly rate: number;
  /** The BPM heard. */
  readonly heardBpm: number;
  /** Where the tempo fader sits for that rate, −1…1; null when the rate is outside the fader's range (a Render plays it anyway). */
  readonly fader: number | null;
}

/** Each track matched to the heard tempo of the one before it; the first plays at its own tempo. */
export function matchedTempos(grids: readonly Pick<PlanGrid, "bpm">[], rangePercent: TempoRangePercent): TrackTempo[] {
  const tempos: TrackTempo[] = [];
  let leader: { readonly bpm: number; readonly rate: number } | null = null;
  for (const grid of grids) {
    if (leader === null) {
      tempos.push({ rate: 1, heardBpm: grid.bpm, fader: 0 });
    } else {
      const synced = syncTempo({ leaderGrid: syncGrid(leader.bpm), leaderRate: leader.rate, followerGrid: syncGrid(grid.bpm), followerRangePercent: rangePercent });
      // Outside the fader's range the match is the same arithmetic; only the fader cannot reach it.
      const rate = synced.ok ? synced.rate : (leader.bpm * leader.rate) / grid.bpm;
      tempos.push({ rate, heardBpm: grid.bpm * rate, fader: synced.ok ? synced.fader : null });
    }
    leader = { bpm: grid.bpm, rate: tempos.at(-1)?.rate ?? 1 };
  }
  return tempos;
}

/** syncTempo reads only the tempo of the grids it is given. */
const syncGrid = (bpm: number) => ({ bpm, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 0 });
