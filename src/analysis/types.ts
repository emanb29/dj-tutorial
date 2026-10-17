// The public shapes of track analysis. Everything here is structured-clone safe, so it crosses the
// worker boundary and goes into IndexedDB unchanged. Nothing here holds audio.

/** Bump when the pipeline changes what it produces; cached analyses from other versions are ignored. */
export const ANALYSIS_VERSION = 1;

export type AnalysisMethod = "beat-this" | "dj-core-fallback";

/** What the caller asks for. `auto` runs Beat This! and falls back to the dj-core port only when
 * the model cannot run; `beat-this` never falls back; `dj-core` skips the model. */
export type MethodPreference = "auto" | "beat-this" | "dj-core";

/** Decoded PCM, as an AudioBuffer gives it: one Float32Array per channel, all the same length. */
export interface DecodedAudio {
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
}

/** A min/max and 3-band energy summary for drawing the waveform, one value per bucket (~10 ms). */
export interface WaveformOverview {
  /** Exact bucket length in seconds (a whole number of samples, so close to but not exactly 0.01). */
  readonly bucketSec: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
  /** RMS of the signal below 200 Hz, between 200 Hz and 2 kHz, and above 2 kHz, per bucket. */
  readonly low: Float32Array;
  readonly mid: Float32Array;
  readonly high: Float32Array;
}

/** An 8-bar boundary with how much the level changes across it. A hint, not a detected section. */
export interface PhraseHint {
  readonly timeSec: number;
  /** 1-based bar number of the bar that starts here. */
  readonly bar: number;
  /** RMS level of the 8 bars after over the 8 bars before, in dB. */
  readonly energyChangeDb: number;
  readonly kind: "energy-up" | "energy-down" | "steady";
}

/** Something the learner or developer should know about a result that is still usable. */
export type AnalysisWarning =
  | { readonly kind: "four-on-the-floor-only"; readonly message: string }
  | { readonly kind: "model-missing"; readonly modelUrl: string; readonly fix: string }
  | { readonly kind: "model-failed"; readonly message: string }
  | { readonly kind: "single-thread"; readonly message: string }
  | { readonly kind: "possible-off-beat"; readonly lowOnBeatVsOffBeat: number; readonly message: string }
  | { readonly kind: "weak-phase-alignment"; readonly contrast: number; readonly message: string };

export interface AnalysisDiagnostics {
  /** Beats the model detected, and how many of them the fitted grid explains (null for dj-core). */
  readonly detectedBeats: number | null;
  readonly inlierBeats: number | null;
  readonly offBeats: number | null;
  readonly downbeatAgreement: number | null;
  /** Shift the phase refiner applied, in ms (0 when it was not confident enough to apply one). */
  readonly phaseShiftMs: number;
  readonly phaseContrast: number;
  readonly lowOnBeatVsOffBeat: number;
  readonly threads: number | null;
  readonly timingsMs: Readonly<Record<string, number>>;
}

export interface TrackAnalysis {
  readonly analysisVersion: number;
  readonly method: AnalysisMethod;
  /** Which model produced the beats, e.g. "beat-this-small0@b95c8ab", or the dj-core port's version. */
  readonly modelVersion: string;
  readonly durationSec: number;
  readonly bpm: number;
  /** First grid beat at or after -50 ms. */
  readonly firstBeatSec: number;
  /** Index (0-3) of bar 1 among the grid beats; null when the method finds no downbeats (dj-core). */
  readonly downbeatPhase: number | null;
  /** Every beat of the constant-tempo grid inside the track, in seconds. */
  readonly beatGrid: readonly number[];
  /** RMS distance of the detected beats from the grid (null for dj-core, which detects none). */
  readonly residualRmsMs: number | null;
  /** 0-1. How far to trust the grid; see confidence.ts for what goes into it. */
  readonly confidence: number;
  readonly phraseHints: readonly PhraseHint[];
  readonly waveformOverview: WaveformOverview;
  readonly warnings: readonly AnalysisWarning[];
  readonly diagnostics: AnalysisDiagnostics;
}

/** Expected reasons an analysis produces no grid. Values, never throws. */
export type AnalysisError =
  | { readonly kind: "invalid-audio"; readonly problems: readonly string[] }
  | { readonly kind: "too-short"; readonly durationSec: number; readonly minimumSec: number }
  | { readonly kind: "no-steady-beat"; readonly message: string }
  | { readonly kind: "model-missing"; readonly modelUrl: string; readonly fix: string }
  | { readonly kind: "model-failed"; readonly message: string }
  | { readonly kind: "worker-crashed"; readonly message: string }
  | { readonly kind: "aborted" };

export type AnalysisOutcome =
  | { readonly ok: true; readonly analysis: TrackAnalysis; readonly fromCache: boolean }
  | { readonly ok: false; readonly error: AnalysisError };

export type AnalysisStage = "preparing" | "features" | "loading-model" | "inference" | "fitting" | "refining" | "overview";

export interface AnalysisProgress {
  readonly stage: AnalysisStage;
  /** Overall progress, 0-1, never decreasing. */
  readonly fraction: number;
}
