// Analysis results are cached per track, keyed by a content hash. Only the analysis is stored,
// never audio (Audius audio must not be persisted; ADR 0001).

import { sha256Hex } from "./model.ts";
import { ANALYSIS_VERSION, type DecodedAudio, type TrackAnalysis } from "./types.ts";

export interface AnalysisCache {
  /** The cached analysis, or null when there is none for this hash or it is from another pipeline version. */
  get(contentHash: string): Promise<TrackAnalysis | null>;
  put(contentHash: string, analysis: TrackAnalysis): Promise<void>;
  delete(contentHash: string): Promise<void>;
}

/** Enough of the file to tell tracks apart without reading all of a long one. */
export const CONTENT_HASH_PREFIX_BYTES = 4 * 1024 * 1024;

async function hashPrefixWith(bytes: Uint8Array, suffix: string): Promise<string> {
  const prefix = bytes.subarray(0, CONTENT_HASH_PREFIX_BYTES);
  const tail = new TextEncoder().encode(`|${suffix}`);
  const message = new Uint8Array(prefix.length + tail.length);
  message.set(prefix);
  message.set(tail, prefix.length);
  return sha256Hex(message);
}

/** SHA-256 of the first CONTENT_HASH_PREFIX_BYTES of the encoded file plus its duration (to the ms).
 * Prefer this: it does not depend on the rate the file was decoded at. */
export function hashTrackBytes(bytes: ArrayBuffer | ArrayBufferView, durationSec: number): Promise<string> {
  const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return hashPrefixWith(view, `duration-ms=${String(Math.round(durationSec * 1000))}`);
}

/** The same, over the first channel's decoded samples, for callers that no longer have the file.
 * The same file decoded at another rate hashes differently (a cache miss, never a wrong hit). */
export function hashDecodedAudio(audio: DecodedAudio): Promise<string> {
  const first = audio.channels[0] ?? new Float32Array(0);
  const view = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return hashPrefixWith(view, `pcm|rate=${String(audio.sampleRate)}|samples=${String(first.length)}`);
}

export const isCurrentVersion = (analysis: TrackAnalysis) => analysis.analysisVersion === ANALYSIS_VERSION;

export class MemoryAnalysisCache implements AnalysisCache {
  private readonly entries = new Map<string, TrackAnalysis>();

  get(contentHash: string): Promise<TrackAnalysis | null> {
    const analysis = this.entries.get(contentHash);
    return Promise.resolve(analysis && isCurrentVersion(analysis) ? analysis : null);
  }

  put(contentHash: string, analysis: TrackAnalysis): Promise<void> {
    this.entries.set(contentHash, analysis);
    return Promise.resolve();
  }

  delete(contentHash: string): Promise<void> {
    this.entries.delete(contentHash);
    return Promise.resolve();
  }
}
