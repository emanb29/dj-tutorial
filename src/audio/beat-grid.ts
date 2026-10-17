// Arithmetic on the canonical constant-tempo beat grid (shared/attempt.ts, check-design §1).

import type { BeatGrid } from "@shared/attempt.ts";

export type { BeatGrid } from "@shared/attempt.ts";

export const BEATS_PER_BAR = 4;

/** Fractional beat index at a track position; whole numbers are beats. */
export function beatAt(grid: BeatGrid, positionSec: number): number {
  return ((positionSec - grid.firstBeat) * grid.bpm) / 60;
}

export function positionOfBeat(grid: BeatGrid, beat: number): number {
  return grid.firstBeat + (beat * 60) / grid.bpm;
}

/** Heard beat length in seconds at a playback rate. */
export function beatLengthSec(grid: BeatGrid, rate: number): number {
  return 60 / (grid.bpm * rate);
}

/** Bar number (bar 1 starts at the first downbeat) and beat-in-bar (1–4) of the beat at or before a position. */
export function barBeatAt(grid: BeatGrid, positionSec: number): { bar: number; beatInBar: number } {
  const fromFirstDownbeat = Math.floor(beatAt(grid, positionSec)) - grid.downbeatIndex;
  return {
    bar: Math.floor(fromFirstDownbeat / BEATS_PER_BAR) + 1,
    beatInBar: modulo(fromFirstDownbeat, BEATS_PER_BAR) + 1,
  };
}

/** Every problem with a grid, so a bad analysis result is refused at load rather than mis-grading later. */
export function beatGridProblems(grid: BeatGrid): string[] {
  return [
    Number.isFinite(grid.bpm) && grid.bpm > 0 ? null : `bpm must be a finite number above 0 (got ${String(grid.bpm)})`,
    Number.isFinite(grid.firstBeat) ? null : `firstBeat must be a finite number of seconds (got ${String(grid.firstBeat)})`,
    Number.isInteger(grid.downbeatIndex) && grid.downbeatIndex >= 0 && grid.downbeatIndex <= 3
      ? null
      : `downbeatIndex must be an integer from 0 to 3 (got ${String(grid.downbeatIndex)})`,
    Number.isFinite(grid.rmsResidualMs) && grid.rmsResidualMs >= 0
      ? null
      : `rmsResidualMs must be a finite number of ms, 0 or more (got ${String(grid.rmsResidualMs)})`,
  ].filter((problem) => problem !== null);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
