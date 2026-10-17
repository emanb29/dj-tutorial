// Dev only: analyses every audio file in a folder with the same pipeline as the app (Node, with
// onnxruntime-node) and writes a JSON summary. Decodes with ffmpeg, which must be on PATH.
// Nothing is played. Point it at gitignored folders only; the summary names the files, so keep it
// under .local/ (the default) and never commit it.
//
//   npm run analyse-folder -- FOLDER [--out FILE] [--method auto|beat-this|dj-core] [--compare-dj-core] [--limit N]

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { estimateGrid } from "../src/analysis/dj-core.ts";
import { analysePcm, type PipelineOutcome } from "../src/analysis/pipeline.ts";
import type { MethodPreference, TrackAnalysis } from "../src/analysis/types.ts";
import { loadNodeModel } from "./analysis/onnx-node-model.ts";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".aiff", ".aif"]);
const DECODE_RATE = 44_100;

function decode(path: string): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  return new Promise((resolvePromise, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", String(DECODE_RATE), "-"]);
    const chunks: Buffer[] = [];
    let errors = "";
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with ${String(code)}: ${errors.trim()}`));
        return;
      }
      const all = Buffer.concat(chunks);
      const interleaved = new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4));
      const frames = interleaved.length / 2;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = interleaved[2 * i] ?? 0;
        right[i] = interleaved[2 * i + 1] ?? 0;
      }
      resolvePromise({ channels: [left, right], sampleRate: DECODE_RATE });
    });
  });
}

interface TrackSummary {
  readonly file: string;
  readonly seconds: number;
  /** "ok", "decode-error", or the AnalysisError kind. */
  readonly outcome: string;
  readonly analysis?: Omit<TrackAnalysis, "waveformOverview" | "beatGrid" | "phraseHints"> & { phraseHints: number };
  readonly djCore?: { bpm: number; firstBeatSec: number; agreesOnTempo: boolean } | { failure: string };
  readonly decodeError?: string;
}

/** The analysis without its per-beat and per-bucket arrays, to keep the summary readable. */
const summarise = (analysis: TrackAnalysis): NonNullable<TrackSummary["analysis"]> => ({
  analysisVersion: analysis.analysisVersion,
  method: analysis.method,
  modelVersion: analysis.modelVersion,
  durationSec: analysis.durationSec,
  bpm: analysis.bpm,
  firstBeatSec: analysis.firstBeatSec,
  downbeatPhase: analysis.downbeatPhase,
  residualRmsMs: analysis.residualRmsMs,
  confidence: analysis.confidence,
  warnings: analysis.warnings,
  diagnostics: analysis.diagnostics,
  phraseHints: analysis.phraseHints.length,
});

function histogram(values: readonly number[], width: number): Record<string, number> {
  const bins: Record<string, number> = {};
  for (const value of [...values].sort((a, b) => a - b)) {
    const low = Math.floor(value / width) * width;
    const key = `${low.toFixed(width < 1 ? 1 : 0)}-${(low + width).toFixed(width < 1 ? 1 : 0)}`;
    bins[key] = (bins[key] ?? 0) + 1;
  }
  return bins;
}

function quantiles(values: readonly number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return { min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), max: at(1) };
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: "string" },
      method: { type: "string", default: "auto" },
      "compare-dj-core": { type: "boolean", default: false },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });
  const folder = positionals[0];
  const methods: readonly MethodPreference[] = ["auto", "beat-this", "dj-core"];
  const method = methods.find((m) => m === values.method);
  if (folder === undefined || method === undefined) {
    console.error("usage: npm run analyse-folder -- FOLDER [--out FILE] [--method auto|beat-this|dj-core] [--compare-dj-core] [--limit N]");
    process.exit(2);
  }
  const files = readdirSync(folder)
    .filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .slice(0, values.limit === undefined ? undefined : Number(values.limit));
  const out = values.out ?? join(".local", "analysis", `${basename(resolve(folder))}.json`);
  const model = loadNodeModel();
  const tracks: TrackSummary[] = [];
  const started = performance.now();
  for (const [index, file] of files.entries()) {
    const trackStarted = performance.now();
    let audio;
    try {
      audio = await decode(join(folder, file));
    } catch (error) {
      tracks.push({ file, seconds: 0, outcome: "decode-error", decodeError: String(error) });
      continue;
    }
    const outcome: PipelineOutcome = await analysePcm(audio, { method, loadModel: () => model });
    let djCore: TrackSummary["djCore"];
    if (values["compare-dj-core"]) {
      const mono = Float32Array.from(audio.channels[0] ?? [], (v, i) => (v + (audio.channels[1]?.[i] ?? v)) / 2);
      const estimate = estimateGrid(mono, audio.sampleRate);
      djCore = estimate.ok
        ? {
            ...estimate.grid,
            agreesOnTempo: outcome.ok && Math.abs(estimate.grid.bpm / outcome.analysis.bpm - 1) < 0.01,
          }
        : { failure: estimate.failure.kind };
    }
    const seconds = (performance.now() - trackStarted) / 1000;
    tracks.push({
      file,
      seconds,
      outcome: outcome.ok ? "ok" : outcome.error.kind,
      ...(outcome.ok ? { analysis: summarise(outcome.analysis) } : {}),
      ...(djCore ? { djCore } : {}),
    });
    process.stdout.write(`\r${String(index + 1)}/${String(files.length)} analysed`);
  }
  process.stdout.write("\n");

  const analysed = tracks.flatMap((t) => (t.analysis ? [t.analysis] : []));
  const djCoreRuns = tracks.flatMap((t) => (t.djCore && "bpm" in t.djCore ? [t.djCore] : []));
  const aggregate = {
    files: files.length,
    analysed: analysed.length,
    failures: countBy(tracks.filter((t) => t.outcome !== "ok").map((t) => t.outcome)),
    methods: countBy(analysed.map((a) => a.method)),
    bpmHistogram: histogram(analysed.map((a) => a.bpm), 5),
    confidence: { histogram: histogram(analysed.map((a) => a.confidence), 0.1), quantiles: quantiles(analysed.map((a) => a.confidence)) },
    residualRmsMs: quantiles(analysed.flatMap((a) => (a.residualRmsMs === null ? [] : [a.residualRmsMs]))),
    phaseShiftMs: quantiles(analysed.map((a) => a.diagnostics.phaseShiftMs)),
    phaseContrast: quantiles(analysed.map((a) => a.diagnostics.phaseContrast)),
    kickOnBeatVsOffBeat: quantiles(analysed.map((a) => a.diagnostics.lowOnBeatVsOffBeat)),
    downbeatAgreement: quantiles(analysed.flatMap((a) => (a.diagnostics.downbeatAgreement === null ? [] : [a.diagnostics.downbeatAgreement]))),
    warnings: countBy(analysed.flatMap((a) => a.warnings.map((w) => w.kind))),
    durationSec: quantiles(analysed.map((a) => a.durationSec)),
    secondsPerTrack: quantiles(tracks.map((t) => t.seconds)),
    totalSeconds: (performance.now() - started) / 1000,
    ...(values["compare-dj-core"]
      ? { djCore: { ran: djCoreRuns.length, agreesOnTempoWithin1Percent: djCoreRuns.filter((d) => d.agreesOnTempo).length } }
      : {}),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ folder: resolve(folder), method, aggregate, tracks }, null, 2));
  // Only the aggregate goes to the terminal; per-track results (with file names) stay in the file.
  console.log(JSON.stringify(aggregate, null, 2));
  console.log(`Per-track results: ${out}`);
}

await main();
