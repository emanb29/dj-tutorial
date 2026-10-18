// The public shapes of mix grading (ISS-96). Structured-clone safe: they cross the worker boundary.
// Nothing here holds audio.

import type { AnalysisMethod, MethodPreference } from "../types.ts";

export type { MethodPreference };

/**
 * Pass marks, one owner. They follow the Lessons' standing criteria (src/checks/standing*.ts) where
 * audio alone can measure the same thing, and say where they differ.
 */
export const MIX_THRESHOLDS = {
  /** standing.on-phrase: the new track starts within 1 beat of a phrase start (8 bars). */
  onPhraseBeats: 1,
  /** standing.drift: the two tracks' beats stay within 25 ms of each other in at least 85 % of the blend's beats. */
  driftHoldMs: 25,
  driftHoldShare: 0.85,
  /**
   * standing.level-match is 2 dB on the decks' own meters; here it is the whole mix before and after a
   * transition, where the tracks' own sections differ too, so 3 dB.
   */
  levelJumpDb: 3,
  /** standing.no-clip: no samples at full scale. Up to 10 ms of single overs is tolerated. */
  clippedSec: 0.01,
  /** standing.no-dead-air: no silence of 1 s or more. */
  deadAirSec: 1,
  /** standing.one-bass is 1 beat on the EQ knobs; read from the sound alone, 1 bar. */
  bassClashBeats: 4,
} as const;

/** A transition read from the sound: where the next track became audible, and where the last one was gone. */
export interface MixTransition {
  /** 1-based, in order. */
  readonly number: number;
  /** When the incoming track became audible, on the outgoing track's beat grid. */
  readonly startSec: number;
  /** When the outgoing track was gone. Equal to startSec for a cut. */
  readonly endSec: number;
  /** A cut swaps tracks within one bar; a blend plays both for longer. */
  readonly kind: "cut" | "blend";
  /** Beats per minute of the outgoing track, or null when no beat grid was found for it. */
  readonly bpm: number | null;
  /**
   * Beats from the nearest phrase start (every 8 bars, counted from when the outgoing track came in),
   * signed: positive is late. Null when the outgoing track has no beat grid.
   */
  readonly phraseOffsetBeats: number | null;
  /** Blends only: the share of the blend's beats that stayed within driftHoldMs, and the worst gap in ms. */
  readonly drift: { readonly holdShare: number; readonly worstMs: number } | null;
  /** Loudness after the transition minus before it, in dB. Null when either side is too short to measure. */
  readonly levelJumpDb: number | null;
  /** Time at full scale (clipped) from 4 s before the transition to 4 s after it. */
  readonly clippedSec: number;
  /** The longest silence from 4 s before the transition to 4 s after it. */
  readonly deadAirSec: number;
  /** Blends only: beats in which both basslines played at more than half their own level. Null when they cannot be told apart. */
  readonly bassClashBeats: number | null;
}

export interface SilenceSpan {
  readonly fromSec: number;
  readonly toSec: number;
}

export type MixWarning =
  | { readonly kind: "model-missing"; readonly fix: string }
  | { readonly kind: "model-failed"; readonly message: string }
  | { readonly kind: "no-beat-grid"; readonly track: number };

export interface MixReport {
  readonly durationSec: number;
  /** How the beats were found: Beat This!, or the dj-core fallback when the model could not run. */
  readonly method: AnalysisMethod;
  readonly transitions: readonly MixTransition[];
  /** Every silence of deadAirSec or more between the first and the last sound. */
  readonly deadAir: readonly SilenceSpan[];
  /** Time at full scale over the whole mix, and its peak. */
  readonly clippedSec: number;
  readonly peakDbfs: number;
  readonly warnings: readonly MixWarning[];
}

export type MixError =
  | { readonly kind: "invalid-audio"; readonly problems: readonly string[] }
  | { readonly kind: "too-short"; readonly durationSec: number; readonly minimumSec: number }
  | { readonly kind: "too-long"; readonly durationSec: number; readonly maximumSec: number }
  | { readonly kind: "model-missing"; readonly modelUrl: string; readonly fix: string }
  | { readonly kind: "model-failed"; readonly message: string }
  | { readonly kind: "worker-crashed"; readonly message: string }
  | { readonly kind: "aborted" };

export type MixOutcome = { readonly ok: true; readonly report: MixReport } | { readonly ok: false; readonly error: MixError };

export type MixStage = "preparing" | "beats" | "transitions" | "checks";

export interface MixProgress {
  readonly stage: MixStage;
  /** Overall progress, 0-1, never decreasing. */
  readonly fraction: number;
}
