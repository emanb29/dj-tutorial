// The analysis pipeline, independent of where it runs (the Web Worker, or Node in the dev scripts):
//
//   downmix -> resample to 22 050 Hz -> log-mel -> Beat This! per 30 s window -> minimal peak
//   picking -> least-squares grid fit with downbeat vote -> phase refine against the audio's own
//   energy rises -> beat grid, waveform overview, phrase hints, confidence.
//
// The dj-core port replaces the model steps only when the model cannot run (method "auto") or when
// asked (method "dj-core"), and the result says it is four-on-the-floor only.

import { confidence, MIN_PHASE_CONTRAST } from "./confidence.ts";
import { estimateGrid } from "./dj-core.ts";
import { fitGrid, gridBeats, type FittedGrid } from "./grid-fit.ts";
import { FRAMES_PER_SECOND, frameCount, logMel, MODEL_SAMPLE_RATE } from "./mel.ts";
import type { BeatModel, ModelLoad } from "./model.ts";
import { refinePhase, type PhaseRefinement } from "./phase.ts";
import { phraseHints } from "./phrases.ts";
import { aggregate, minimalPostprocess, splitPiece } from "./postprocess.ts";
import { downmixMean, resample } from "./resample.ts";
import {
  ANALYSIS_VERSION,
  type AnalysisError,
  type AnalysisProgress,
  type AnalysisStage,
  type AnalysisWarning,
  type DecodedAudio,
  type MethodPreference,
  type TrackAnalysis,
} from "./types.ts";
import { waveformOverview } from "./waveform.ts";

export const MINIMUM_DURATION_SEC = 8;
export const DJ_CORE_VERSION = "dj-core-port@spike-beat-this";

export interface PipelineOptions {
  readonly method: MethodPreference;
  /** Called at most once, and never for method "dj-core". */
  readonly loadModel: () => Promise<ModelLoad>;
  readonly onProgress?: (progress: AnalysisProgress) => void;
  /** Warnings about the environment (e.g. single-thread) to carry into the result. */
  readonly environmentWarnings?: readonly AnalysisWarning[];
}

export type PipelineOutcome =
  | { readonly ok: true; readonly analysis: TrackAnalysis }
  | { readonly ok: false; readonly error: AnalysisError };

/** Rough share of total time per stage, from the spike's 6-minute timings (inference dominates). */
const STAGE_SPANS: Readonly<Record<AnalysisStage, readonly [number, number]>> = {
  preparing: [0, 0.04],
  features: [0.04, 0.12],
  "loading-model": [0.12, 0.15],
  inference: [0.15, 0.85],
  fitting: [0.85, 0.87],
  refining: [0.87, 0.95],
  overview: [0.95, 1],
};

const FOUR_ON_THE_FLOOR_ONLY: AnalysisWarning = {
  kind: "four-on-the-floor-only",
  message:
    "This grid comes from the dj-core fallback, which only handles four-on-the-floor music: on " +
    "breakbeat, UK garage, DnB or half-time it can pick 2/3 of the tempo or the off-beat. It finds no bar 1.",
};

function validate(audio: DecodedAudio): AnalysisError | null {
  const problems: string[] = [];
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !Number.isInteger(audio.sampleRate)) {
    problems.push(`sampleRate is ${String(audio.sampleRate)}; pass the AudioBuffer's sampleRate (a whole number of Hz).`);
  }
  const lengths = new Set(audio.channels.map((c) => c.length));
  if (audio.channels.length === 0) problems.push("There are no channels; pass at least one Float32Array of samples.");
  else if (lengths.size > 1) {
    problems.push(`The channels have different lengths (${[...lengths].join(", ")}); pass the channels of one AudioBuffer.`);
  }
  return problems.length > 0 ? { kind: "invalid-audio", problems } : null;
}

class Progress {
  private last = 0;
  constructor(private readonly report: ((progress: AnalysisProgress) => void) | undefined) {}

  /** `within` is progress through the stage, 0-1. */
  at(stage: AnalysisStage, within = 0): void {
    const [from, to] = STAGE_SPANS[stage];
    this.last = Math.max(this.last, from + (to - from) * Math.min(1, Math.max(0, within)));
    this.report?.({ stage, fraction: this.last });
  }
}

/** Moves a grid by a refinement's shift, keeping beat 0 the first beat at or after -50 ms and bar 1
 * on the same beat. */
function shiftGrid<Grid extends { bpm: number; firstBeatSec: number; downbeatPhase: number | null }>(
  grid: Grid,
  shiftSec: number,
): Grid {
  const period = 60 / grid.bpm;
  let firstBeatSec = grid.firstBeatSec + shiftSec;
  let downbeatPhase = grid.downbeatPhase;
  const step = (beats: number) => {
    firstBeatSec += beats * period;
    if (downbeatPhase !== null) downbeatPhase = (((downbeatPhase - beats) % 4) + 4) % 4;
  };
  while (firstBeatSec < -0.05) step(1);
  while (firstBeatSec - period >= -0.05) step(-1);
  return { ...grid, firstBeatSec, downbeatPhase };
}

/** Applies the refinement when it is confident, and returns the warnings it raises either way. */
function applyRefinement<Grid extends { bpm: number; firstBeatSec: number; downbeatPhase: number | null }>(
  grid: Grid,
  refinement: PhaseRefinement,
): { grid: Grid; appliedShiftSec: number; warnings: AnalysisWarning[] } {
  const confident = refinement.contrast >= MIN_PHASE_CONTRAST;
  const warnings: AnalysisWarning[] = [];
  if (!confident) {
    warnings.push({
      kind: "weak-phase-alignment",
      contrast: refinement.contrast,
      message: "No clear onsets line up with the grid, so it was not fine-tuned; beats may be up to ~30 ms late.",
    });
  }
  if (refinement.lowOnBeatVsOffBeat < 1) {
    warnings.push({
      kind: "possible-off-beat",
      lowOnBeatVsOffBeat: refinement.lowOnBeatVsOffBeat,
      message: "The kick is stronger between the grid's beats than on them: the grid may be half a beat off.",
    });
  }
  const appliedShiftSec = confident ? refinement.shiftSec : 0;
  return { grid: shiftGrid(grid, appliedShiftSec), appliedShiftSec, warnings };
}

interface ModelBeats {
  readonly fit: FittedGrid;
  readonly model: BeatModel;
  readonly threads: number | null;
}

async function runModel(
  mono: Float32Array,
  sampleRate: number,
  model: BeatModel,
  progress: Progress,
  timings: Record<string, number>,
): Promise<FittedGrid | null> {
  let started = performance.now();
  progress.at("features");
  const signal = resample(mono, sampleRate, MODEL_SAMPLE_RATE);
  const spect = logMel(signal);
  const frames = frameCount(signal.length);
  timings["featuresMs"] = performance.now() - started;

  started = performance.now();
  const chunks = splitPiece(spect, frames);
  const beatChunks: Float32Array[] = [];
  const downbeatChunks: Float32Array[] = [];
  for (const [index, chunk] of chunks.entries()) {
    progress.at("inference", index / chunks.length);
    const logits = await model.run(chunk.spect);
    beatChunks.push(logits.beat);
    downbeatChunks.push(logits.downbeat);
  }
  progress.at("inference", 1);
  timings["inferenceMs"] = performance.now() - started;

  started = performance.now();
  progress.at("fitting");
  const starts = chunks.map((c) => c.start);
  const detected = minimalPostprocess(
    aggregate(beatChunks, starts, frames),
    aggregate(downbeatChunks, starts, frames),
    FRAMES_PER_SECOND,
  );
  const fit = fitGrid(detected.refinedBeats, detected.downbeats);
  timings["fitMs"] = performance.now() - started;
  return fit.ok ? fit.grid : null;
}

export async function analysePcm(audio: DecodedAudio, options: PipelineOptions): Promise<PipelineOutcome> {
  const invalid = validate(audio);
  if (invalid) return { ok: false, error: invalid };
  const { sampleRate } = audio;
  const durationSec = (audio.channels[0]?.length ?? 0) / sampleRate;
  if (durationSec < MINIMUM_DURATION_SEC) {
    return { ok: false, error: { kind: "too-short", durationSec, minimumSec: MINIMUM_DURATION_SEC } };
  }
  const progress = new Progress(options.onProgress);
  const timings: Record<string, number> = {};
  const warnings: AnalysisWarning[] = [...(options.environmentWarnings ?? [])];
  progress.at("preparing");
  const mono = downmixMean(audio.channels);

  let modelBeats: ModelBeats | null = null;
  if (options.method !== "dj-core") {
    progress.at("loading-model");
    const started = performance.now();
    const load = await options.loadModel();
    timings["loadModelMs"] = performance.now() - started;
    if (load.ok) {
      const fit = await runModel(mono, sampleRate, load.model, progress, timings);
      if (fit) modelBeats = { fit, model: load.model, threads: load.threads };
      else if (options.method === "beat-this") {
        return { ok: false, error: { kind: "no-steady-beat", message: "Beat This! found too few regular beats for a grid." } };
      }
    } else if (options.method === "beat-this") {
      return { ok: false, error: load.error };
    } else {
      warnings.push(load.error);
    }
  }
  // Single-thread only matters when the model ran.
  const relevantWarnings = modelBeats ? warnings : warnings.filter((w) => w.kind !== "single-thread");

  progress.at("refining");
  let started = performance.now();
  let analysisCore: Omit<TrackAnalysis, "waveformOverview" | "phraseHints" | "beatGrid" | "analysisVersion" | "durationSec">;
  if (modelBeats) {
    const { fit, model, threads } = modelBeats;
    const refinement = refinePhase(mono, sampleRate, fit);
    const refined = applyRefinement(fit, refinement);
    timings["refineMs"] = performance.now() - started;
    analysisCore = {
      method: "beat-this",
      modelVersion: model.version,
      bpm: refined.grid.bpm,
      firstBeatSec: refined.grid.firstBeatSec,
      downbeatPhase: refined.grid.downbeatPhase,
      residualRmsMs: fit.residualRmsMs,
      confidence: confidence({
        method: "beat-this",
        inlierShare: fit.inliers / fit.detected,
        residualRmsMs: fit.residualRmsMs,
        downbeatAgreement: fit.downbeatAgreement,
        phaseContrast: refinement.contrast,
        lowOnBeatVsOffBeat: refinement.lowOnBeatVsOffBeat,
      }),
      warnings: [...relevantWarnings, ...refined.warnings],
      diagnostics: {
        detectedBeats: fit.detected,
        inlierBeats: fit.inliers,
        offBeats: fit.offBeats,
        downbeatAgreement: fit.downbeatAgreement,
        phaseShiftMs: 1000 * refined.appliedShiftSec,
        phaseContrast: refinement.contrast,
        lowOnBeatVsOffBeat: refinement.lowOnBeatVsOffBeat,
        threads,
        timingsMs: timings,
      },
    };
  } else {
    const estimate = estimateGrid(mono, sampleRate);
    if (!estimate.ok) {
      return {
        ok: false,
        error: { kind: "no-steady-beat", message: "Neither Beat This! nor the dj-core fallback found a steady beat." },
      };
    }
    const grid = { ...estimate.grid, downbeatPhase: null };
    const refinement = refinePhase(mono, sampleRate, grid);
    const refined = applyRefinement(grid, refinement);
    timings["refineMs"] = performance.now() - started;
    analysisCore = {
      method: "dj-core-fallback",
      modelVersion: DJ_CORE_VERSION,
      bpm: refined.grid.bpm,
      firstBeatSec: refined.grid.firstBeatSec,
      downbeatPhase: null,
      residualRmsMs: null,
      confidence: confidence({
        method: "dj-core-fallback",
        inlierShare: null,
        residualRmsMs: null,
        downbeatAgreement: null,
        phaseContrast: refinement.contrast,
        lowOnBeatVsOffBeat: refinement.lowOnBeatVsOffBeat,
      }),
      warnings: [...relevantWarnings, FOUR_ON_THE_FLOOR_ONLY, ...refined.warnings],
      diagnostics: {
        detectedBeats: null,
        inlierBeats: null,
        offBeats: null,
        downbeatAgreement: null,
        phaseShiftMs: 1000 * refined.appliedShiftSec,
        phaseContrast: refinement.contrast,
        lowOnBeatVsOffBeat: refinement.lowOnBeatVsOffBeat,
        threads: null,
        timingsMs: timings,
      },
    };
  }

  progress.at("overview");
  started = performance.now();
  const overview = waveformOverview(mono, sampleRate);
  const hints = phraseHints(analysisCore, overview, durationSec);
  timings["overviewMs"] = performance.now() - started;
  progress.at("overview", 1);
  return {
    ok: true,
    analysis: {
      ...analysisCore,
      analysisVersion: ANALYSIS_VERSION,
      durationSec,
      beatGrid: gridBeats(analysisCore, durationSec),
      phraseHints: hints,
      waveformOverview: overview,
    },
  };
}
