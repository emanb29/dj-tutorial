// Scoring a grid against a known one (synthetic tracks with ground truth). Used by tests and the
// dev scripts, never at runtime.

import { gridBeats } from "./grid-fit.ts";

export interface Grid {
  readonly bpm: number;
  readonly firstBeatSec: number;
  readonly downbeatPhase?: number | null;
}

export interface GroundTruth extends Grid {
  readonly downbeatPhase: number;
  readonly durationSec: number;
}

export interface GridScore {
  readonly bpmError: number;
  /** Fitted over true tempo, rounded to the nearest of 0.5, 1, 2 (or the raw ratio if none is close). */
  readonly tempoRatio: number;
  /** Distance from each fitted grid beat inside the track to the nearest true beat. */
  readonly gridErrorMeanMs: number;
  readonly gridErrorMaxMs: number;
  /** Fitted bar 1 lands on a true bar line (null when the grid has no downbeat). */
  readonly downbeatCorrect: boolean | null;
}

export function score(truth: GroundTruth, fit: Grid): GridScore {
  const truePeriod = 60 / truth.bpm;
  const distanceToTrueBeat = (time: number) => {
    const beat = (time - truth.firstBeatSec) / truePeriod;
    return Math.abs(beat - Math.round(beat)) * truePeriod;
  };
  const ratio = fit.bpm / truth.bpm;
  const tempoRatio = [0.5, 1, 2].find((r) => Math.abs(ratio / r - 1) < 0.02) ?? ratio;
  const errorsMs = gridBeats(fit, truth.durationSec).map((t) => 1000 * distanceToTrueBeat(t));
  let downbeatCorrect: boolean | null = null;
  if (fit.downbeatPhase !== undefined && fit.downbeatPhase !== null) {
    const trueBar1 = truth.firstBeatSec + truth.downbeatPhase * truePeriod;
    const fitBar1 = fit.firstBeatSec + fit.downbeatPhase * (60 / fit.bpm);
    const bars = (fitBar1 - trueBar1) / (4 * truePeriod);
    downbeatCorrect = Math.abs(bars - Math.round(bars)) * 4 < 0.5;
  }
  return {
    bpmError: fit.bpm - truth.bpm,
    tempoRatio,
    gridErrorMeanMs: errorsMs.reduce((s, v) => s + v, 0) / errorsMs.length,
    gridErrorMaxMs: Math.max(...errorsMs),
    downbeatCorrect,
  };
}
