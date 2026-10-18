// Grading a recorded mix (ISS-96), independent of where it runs (the mix worker, or Node in tests):
//
//   downmix -> beats over the whole mix (Beat This!, or none when the model cannot run) -> spectral
//   frames -> transitions (novelty peaks) -> a beat grid per track -> each transition's extent on the
//   outgoing track's grid -> per transition: phrase, drift, level jump, clipping, dead air, bass clash.
//
// Audio only: the app never sees deck state (docs/research/dj-software-integration.md), so every
// value here is read from the sound and the result card says so.

import type { BeatModel, ModelLoad } from "../model.ts";
import { detectBeats } from "../pipeline.ts";
import { downmixMean, resample } from "../resample.ts";
import type { DecodedAudio } from "../types.ts";
import { MIX_MAX_SEC, MIX_MIN_SEC } from "@shared/outside-practice.ts";
import { bassClashBeats } from "./bass.ts";
import { blendDrift } from "./drift.ts";
import { MIX_RATE, spectralFrames } from "./features.ts";
import { nearestBeat, trackGrid, type TrackGrid } from "./grids.ts";
import { audibleSpan, clipping, deadAir, levelJumpDb, longestSilenceIn } from "./levels.ts";
import { phraseOffsetBeats } from "./phrase.ts";
import { novelty, transitionExtent, transitionPeaks } from "./transitions.ts";
import type { MethodPreference, MixError, MixOutcome, MixProgress, MixReport, MixStage, MixTransition, MixWarning } from "./types.ts";

export interface MixGradeOptions {
  readonly method: MethodPreference;
  /** Called at most once, and never for method "dj-core". */
  readonly loadModel: () => Promise<ModelLoad>;
  readonly onProgress?: (progress: MixProgress) => void;
}

/** Share of the work per stage: the model's inference dominates when it runs. */
const STAGE_SPANS: Readonly<Record<MixStage, readonly [number, number]>> = {
  preparing: [0, 0.05],
  beats: [0.05, 0.75],
  transitions: [0.75, 0.9],
  checks: [0.9, 1],
};
/** A track's grid is fitted this far inside the stretch between transitions. */
const GRID_MARGIN_SEC = 12;
/** Clipping and dead air count from this long before a transition to this long after it. */
const AROUND_SEC = 4;
/** A swap within a bar is a cut. */
const CUT_MAX_BEATS = 4;
/** The old track alone, before the blend, that drift is measured against. */
const DRIFT_REFERENCE_SEC = 16;

const milliseconds = (seconds: number) => Math.round(seconds * 1000) / 1000;

function validate(audio: DecodedAudio): MixError | null {
  const problems: string[] = [];
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) problems.push(`sampleRate is ${String(audio.sampleRate)}; pass the AudioBuffer's sampleRate.`);
  if (audio.channels.length === 0) problems.push("There are no channels; pass at least one Float32Array of samples.");
  if (new Set(audio.channels.map((c) => c.length)).size > 1) problems.push("The channels have different lengths; pass the channels of one AudioBuffer.");
  if (problems.length > 0) return { kind: "invalid-audio", problems };
  const durationSec = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  if (durationSec < MIX_MIN_SEC) return { kind: "too-short", durationSec, minimumSec: MIX_MIN_SEC };
  if (durationSec > MIX_MAX_SEC) return { kind: "too-long", durationSec, maximumSec: MIX_MAX_SEC };
  return null;
}

class Progress {
  private last = 0;
  constructor(private readonly report: ((progress: MixProgress) => void) | undefined) {}

  at(stage: MixStage, within = 0): void {
    const [from, to] = STAGE_SPANS[stage];
    this.last = Math.max(this.last, from + (to - from) * Math.min(1, Math.max(0, within)));
    this.report?.({ stage, fraction: this.last });
  }
}

/** The model's beats over the whole mix, or null (with why) when it cannot run. */
async function mixBeats(
  mono: Float32Array,
  sampleRate: number,
  options: MixGradeOptions,
  progress: Progress,
): Promise<{ ok: true; beats: readonly number[] | null; warnings: MixWarning[] } | { ok: false; error: MixError }> {
  if (options.method === "dj-core") return { ok: true, beats: null, warnings: [] };
  const load = await options.loadModel();
  if (!load.ok) {
    if (options.method === "beat-this") return { ok: false, error: load.error };
    const warning: MixWarning = load.error.kind === "model-missing" ? { kind: "model-missing", fix: load.error.fix } : { kind: "model-failed", message: load.error.message };
    console.warn(`[mix] Beat This! cannot run, so the dj-core fallback finds the beats: ${load.error.kind === "model-missing" ? load.error.fix : load.error.message}`);
    return { ok: true, beats: null, warnings: [warning] };
  }
  const model: BeatModel = load.model;
  const detected = await detectBeats(mono, sampleRate, model, (within) => {
    progress.at("beats", within);
  });
  return { ok: true, beats: detected.refinedBeats, warnings: [] };
}

export async function gradeMixPcm(audio: DecodedAudio, options: MixGradeOptions): Promise<MixOutcome> {
  const invalid = validate(audio);
  if (invalid) return { ok: false, error: invalid };
  const progress = new Progress(options.onProgress);
  progress.at("preparing");
  const original = downmixMean(audio.channels);
  const mono = audio.sampleRate === MIX_RATE ? original : resample(original, audio.sampleRate, MIX_RATE);
  const durationSec = mono.length / MIX_RATE;

  const found = await mixBeats(original, audio.sampleRate, options, progress);
  if (!found.ok) return found;
  const { beats } = found;
  const warnings = [...found.warnings];
  progress.at("transitions");

  const frames = spectralFrames(mono);
  const span = audibleSpan(mono, MIX_RATE) ?? { fromSec: 0, toSec: durationSec };
  const peaks = transitionPeaks(frames, novelty(frames, beats ?? []));
  progress.at("transitions", 0.5);

  // Track i plays between peak i-1 and peak i; its grid comes from the middle of that stretch.
  const edges = [span.fromSec, ...peaks, span.toSec];
  const edge = (i: number) => edges[Math.max(0, Math.min(edges.length - 1, i))] ?? span.fromSec;
  const grids: (TrackGrid | null)[] = edges.slice(1).map((to, i) => {
    const from = edge(i);
    const inner = { fromSec: i === 0 ? from : from + GRID_MARGIN_SEC, toSec: i === peaks.length ? to : to - GRID_MARGIN_SEC };
    return trackGrid(mono, MIX_RATE, inner, beats);
  });
  grids.forEach((grid, i) => {
    if (grid === null) warnings.push({ kind: "no-beat-grid", track: i + 1 });
  });

  // A transition is measured on the outgoing track's grid, or the incoming one's when the outgoing has none.
  const measuredOn = peaks.map((_, i) => grids[i] ?? grids[i + 1] ?? null);
  const extents = peaks.map((peakSec, i) => {
    const grid = measuredOn[i] ?? null;
    return grid === null ? null : transitionExtent(frames, grid, peakSec, { fromSec: edge(i), toSec: edge(i + 2) });
  });
  progress.at("checks");

  const silences = deadAir(mono, MIX_RATE);
  const transitions: MixTransition[] = [];
  // When each track came in: the first at the first sound (on its own grid), the rest at their transition's start.
  let entrySec = grids[0] ? nearestBeat(grids[0], span.fromSec) : span.fromSec;
  let previousEndSec = span.fromSec;
  extents.forEach((extent, i) => {
    progress.at("checks", i / Math.max(1, extents.length));
    const outgoing = grids[i] ?? null;
    const grid = measuredOn[i] ?? null;
    // A transition that starts before the last one ended is the same change heard twice.
    if (extent === null || extent.startSec < previousEndSec) return;
    const { startSec, endSec } = extent;
    const beatSec = grid === null ? null : 60 / grid.bpm;
    const blend = beatSec !== null && endSec - startSec > CUT_MAX_BEATS * beatSec - 1e-6;
    const limits = { fromSec: previousEndSec, toSec: extents[i + 1]?.startSec ?? span.toSec };
    const referenceFromSec = Math.max(previousEndSec, startSec - DRIFT_REFERENCE_SEC);
    const drift = blend && grid !== null ? blendDrift(mono, MIX_RATE, grid, { startSec, endSec }, referenceFromSec) : null;
    const clash = blend && grid !== null ? bassClashBeats(frames, grid, { startSec, endSec }, { oldFromSec: referenceFromSec, newToSec: Math.min(limits.toSec, endSec + DRIFT_REFERENCE_SEC) }) : null;
    transitions.push({
      number: transitions.length + 1,
      startSec: milliseconds(startSec),
      endSec: milliseconds(endSec),
      kind: blend ? "blend" : "cut",
      bpm: outgoing === null ? null : Math.round(outgoing.bpm * 10) / 10,
      // Phrases are the outgoing track's: without its grid there is nothing to count.
      phraseOffsetBeats: outgoing === null ? null : phraseOffsetBeats(entrySec, startSec, outgoing.bpm),
      drift: drift === null ? null : { holdShare: drift.holdShare, worstMs: Math.round(drift.worstMs) },
      levelJumpDb: levelJumpDb(mono, MIX_RATE, { startSec, endSec }, limits),
      clippedSec: milliseconds(clipping(audio.channels, audio.sampleRate, startSec - AROUND_SEC, endSec + AROUND_SEC).clippedSec),
      deadAirSec: longestSilenceIn(silences, startSec - AROUND_SEC, endSec + AROUND_SEC),
      bassClashBeats: clash,
    });
    entrySec = startSec;
    previousEndSec = endSec;
  });
  const whole = clipping(audio.channels, audio.sampleRate);
  progress.at("checks", 1);
  const report: MixReport = {
    durationSec,
    method: beats === null ? "dj-core-fallback" : "beat-this",
    transitions,
    deadAir: silences,
    clippedSec: milliseconds(whole.clippedSec),
    peakDbfs: whole.peakDbfs,
    warnings,
  };
  return { ok: true, report };
}
