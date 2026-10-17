// A small, valid TrackAnalysis for tests of code that stores or displays analyses.

import { ANALYSIS_VERSION, type TrackAnalysis } from "./types.ts";

export function sampleAnalysis(): TrackAnalysis {
  const buckets = 4;
  return {
    analysisVersion: ANALYSIS_VERSION,
    method: "beat-this",
    modelVersion: "beat-this-small0@b95c8ab",
    durationSec: 2,
    bpm: 120,
    firstBeatSec: 0,
    downbeatPhase: 0,
    beatGrid: [0, 0.5, 1, 1.5],
    residualRmsMs: 4.2,
    confidence: 0.9,
    phraseHints: [],
    waveformOverview: {
      bucketSec: 0.5,
      min: new Float32Array(buckets).fill(-0.5),
      max: new Float32Array(buckets).fill(0.5),
      low: new Float32Array(buckets).fill(0.3),
      mid: new Float32Array(buckets).fill(0.2),
      high: new Float32Array(buckets).fill(0.1),
    },
    warnings: [],
    diagnostics: {
      detectedBeats: 4,
      inlierBeats: 4,
      offBeats: 0,
      downbeatAgreement: 1,
      phaseShiftMs: -3,
      phaseContrast: 2,
      lowOnBeatVsOffBeat: 2,
      threads: 4,
      timingsMs: {},
    },
  };
}
