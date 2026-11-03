/**
 * Track analysis: decoded audio in, beat grid out, in a Web Worker (ADR 0001). This is the spike on
 * branch `spike/beat-this` made production code; its RESULTS.md has the measurements behind each
 * choice and is not repeated here.
 *
 * ## Using it
 *
 * ```ts
 * const buffer = await new OfflineAudioContext(2, 1, 44_100).decodeAudioData(bytes.slice(0));
 * const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
 * const outcome = await analyseTrack(
 *   { channels, sampleRate: buffer.sampleRate },
 *   {
 *     cache: new IndexedDbAnalysisCache(),
 *     contentHash: await hashTrackBytes(bytes, buffer.duration),
 *     onProgress: ({ stage, fraction }) => showProgress(stage, fraction),
 *     signal, // optional AbortSignal
 *   },
 * );
 * if (outcome.ok) useGrid(outcome.analysis);
 * else showProblem(outcome.error); // typed: model-missing (with .fix), too-short, no-steady-beat, ...
 * ```
 *
 * `TrackAnalysis` is in types.ts. The worker copies the audio it is given and is terminated after
 * each analysis, the only way to give back the ~0.7 GB the WASM heap grows to.
 *
 * ## Pipeline (pipeline.ts)
 *
 * Downmix (mean) → resample to 22 050 Hz (resample.ts) → log-mel (mel.ts, checked against
 * torchaudio by mel.test.ts) → Beat This! small0 per 30 s window through onnxruntime-web WASM
 * (onnx-web.ts) → minimal peak picking (postprocess.ts) → least-squares grid fit with downbeat vote
 * (grid-fit.ts) → phase refine against the audio's energy rises (phase.ts) → grid, waveform overview
 * (waveform.ts), phrase hints (phrases.ts), confidence (confidence.ts).
 *
 * - Threads: `min(4, cores / 2)` WASM threads when the page is cross-origin isolated (COOP/COEP in
 *   vite.config.ts). Otherwise 1 thread, a console WARN, and a `single-thread` warning in the result.
 * - Fallback: with `method: "auto"` (the default), a missing or broken model makes the dj-core
 *   TypeScript port (dj-core.ts) produce the grid, and the result carries the reason (`model-missing`
 *   with the fix, or `model-failed`) plus `four-on-the-floor-only`: the port gets 2/3 tempo on UK
 *   garage and DnB and the off-beat on half-time, and finds no bar 1. Its confidence is capped at 0.5.
 *   `method: "beat-this"` returns the model problem as an error; `method: "dj-core"` skips the model.
 * - Phase refine: applied only when its contrast is at least 1.2; otherwise the unrefined fit (within
 *   about 30 ms) is kept with a `weak-phase-alignment` warning. A kick ratio below 1 adds `possible-off-beat`.
 *
 * ## Cache (cache.ts, indexeddb-cache.ts)
 *
 * Keyed by SHA-256 of the first 4 MB of the encoded file plus its duration in ms (`hashTrackBytes`).
 * Without the file, `hashDecodedAudio` hashes the first channel's samples and rate (another decode
 * rate is then a miss, never a wrong hit). Only the TrackAnalysis is stored, never audio; entries
 * from another ANALYSIS_VERSION are ignored, so bump it when the pipeline's output changes.
 *
 * ## Model files
 *
 * Not committed: public/models/ is gitignored. The worker fetches /models/beat_this_small0.onnx and
 * checks its SHA-256 (model.ts); when it is missing, the error or warning carries the fix:
 *
 *     npm run fetch-models -- --from DIR   # DIR holds beat_this_small0.onnx from an earlier export
 *     npm run fetch-models -- --export     # export it: uv venv, CPU torch 2.8.0 (~1.5 GB), beat_this @ b95c8ab
 *     npm run fetch-models                 # check what is installed
 *
 * `--export` follows the spike's recipe: scripts/model-export/export.py runs `torch.onnx.export`
 * (opset 17, fixed input [1, 1500, 128]) into .local/model-export/models (override with `--dir`).
 * There is no usable published ONNX of small0. `scripts/model-export/reference.py fixture OUT.f32`
 * regenerates fixtures/logmel-reference.f32.
 *
 * ## Tests
 *
 * Node: the DSP and fit modules, and the pipeline end to end with a stand-in model (test-signals.ts).
 * Browser (*.browser.test.ts, cross-origin isolated like the app): the worker round trip, progress,
 * abort, the cache, the typed model-missing error, IndexedDB. Tests named "[needs model file]" run
 * the real model (browser and Node) and are skipped when public/models/beat_this_small0.onnx is absent.
 *
 * ## Analysing a folder (dev only)
 *
 *     npm run analyse-folder -- FOLDER [--compare-dj-core] [--method auto|beat-this|dj-core] [--limit N] [--out FILE]
 *
 * The same pipeline in Node (onnxruntime-node, ffmpeg decode; nothing is played). It prints only
 * aggregate statistics; per-track JSON with file names goes to .local/analysis/<folder>.json. Use it
 * only on gitignored folders such as .local/tracks/ and never commit its output.
 *
 * @module
 */
export { analyseTrack, type AnalyseOptions } from "./client.ts";
export { analysisCacheKey, hashDecodedAudio, hashTrackBytes, MemoryAnalysisCache, type AnalysisCache } from "./cache.ts";
export { IndexedDbAnalysisCache } from "./indexeddb-cache.ts";
export { BEAT_THIS_SMALL0, DEFAULT_MODEL_URL, MODEL_MISSING_FIX } from "./model.ts";
export type * from "./types.ts";
export { ANALYSIS_VERSION } from "./types.ts";
