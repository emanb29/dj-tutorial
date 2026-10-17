// Beat sync arithmetic: match the leader's heard tempo, then shift the follower to the leader's beat phase.

import { beatAt, positionOfBeat, type BeatGrid } from "./beat-grid.ts";
import type { Result } from "./result.ts";
import { tempoFaderForRate, type TempoRangePercent } from "./tempo.ts";

export function syncTempo(input: {
  leaderGrid: BeatGrid;
  leaderRate: number;
  followerGrid: BeatGrid;
  followerRangePercent: TempoRangePercent;
}): Result<{ rate: number; fader: number }> {
  const rate = (input.leaderGrid.bpm * input.leaderRate) / input.followerGrid.bpm;
  const fader = tempoFaderForRate(rate, input.followerRangePercent);
  return fader.ok ? { ok: true, rate, fader: fader.fader } : fader;
}

/** The follower position nearest `followerPos` whose beat phase equals the leader's (moves at most half a beat). */
export function phaseAlignedPosition(input: {
  leaderGrid: BeatGrid;
  leaderPos: number;
  followerGrid: BeatGrid;
  followerPos: number;
}): number {
  const leaderPhase = fractionalPart(beatAt(input.leaderGrid, input.leaderPos));
  const followerBeat = beatAt(input.followerGrid, input.followerPos);
  const shiftBeats = wrapHalf(leaderPhase - fractionalPart(followerBeat));
  return positionOfBeat(input.followerGrid, followerBeat + shiftBeats);
}

function fractionalPart(value: number): number {
  return value - Math.floor(value);
}

/** Wraps a beat difference into [-0.5, 0.5). */
function wrapHalf(beats: number): number {
  return beats - Math.round(beats);
}
