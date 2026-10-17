// How far to trust a grid, 0-1. A product of independent penalties, so any one weak sign pulls it
// down. The thresholds come from the spike (spike/beat-this RESULTS.md): good grids there had a fit
// residual of 4-9 ms, a phase contrast well above MIN_PHASE_CONTRAST, and a kick ratio above 1.

/** Below this phase-refine contrast the refiner's shift is not applied (the unrefined fit is within ~30 ms). */
export const MIN_PHASE_CONTRAST = 1.2;

export interface ConfidenceInputs {
  /** Share of detected beats the grid explains (null for dj-core, which detects none). */
  readonly inlierShare: number | null;
  readonly residualRmsMs: number | null;
  readonly downbeatAgreement: number | null;
  readonly phaseContrast: number;
  readonly lowOnBeatVsOffBeat: number;
  readonly method: "beat-this" | "dj-core-fallback";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function confidence(inputs: ConfidenceInputs): number {
  const phase = inputs.phaseContrast >= MIN_PHASE_CONTRAST ? 1 : 0.6;
  const kick = inputs.lowOnBeatVsOffBeat >= 1 ? 1 : 0.6;
  if (inputs.method === "dj-core-fallback") {
    // Four-on-the-floor only and no downbeats: never more than a coin-flip's worth of trust.
    return 0.5 * phase * kick;
  }
  const inliers = inputs.inlierShare ?? 0;
  // 5 ms or less of residual is as good as the model's frame grid allows; 30 ms is not a grid.
  const residual = inputs.residualRmsMs === null ? 0.5 : clamp01(1 - (inputs.residualRmsMs - 5) / 25);
  // A correct bar 1 had 53-87 % agreement on the spike's real tracks.
  const downbeat = inputs.downbeatAgreement === null ? 0.7 : 0.7 + 0.3 * inputs.downbeatAgreement;
  return clamp01(inliers * residual * downbeat * phase * kick);
}
