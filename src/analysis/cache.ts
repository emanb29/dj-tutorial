// Analysis results are cached per track, keyed by a content hash. Only the analysis is stored,
// never audio (Audius audio must not be persisted; ADR 0001).

import { hashPrefixWith } from "@shared/track-hash.ts";
import { ANALYSIS_VERSION, type DecodedAudio, type MethodPreference, type TrackAnalysis } from "./types.ts";

// The file-bytes key lives in shared/ so the track sources compute exactly the same one.
export { CONTENT_HASH_PREFIX_BYTES, hashTrackBytes } from "@shared/track-hash.ts";

export interface AnalysisCache {
  /** The cached analysis, or null when there is none for this hash or it is from another pipeline version. */
  get(contentHash: string): Promise<TrackAnalysis | null>;
  put(contentHash: string, analysis: TrackAnalysis): Promise<void>;
  delete(contentHash: string): Promise<void>;
}

/** The same, over the first channel's decoded samples, for callers that no longer have the file.
 * The same file decoded at another rate hashes differently (a cache miss, never a wrong hit). */
export function hashDecodedAudio(audio: DecodedAudio): Promise<string> {
  const first = audio.channels[0] ?? new Float32Array(0);
  const view = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return hashPrefixWith(view, `pcm|rate=${String(audio.sampleRate)}|samples=${String(first.length)}`);
}

/**
 * Where analyseTrack keeps a track's analysis: its content hash and the method asked for, so a dj-core
 * result never answers a request for Beat This!. Read the cache with this key, never the bare hash.
 */
export function analysisCacheKey(contentHash: string, method: MethodPreference = "auto"): string {
  return `${contentHash}|${method}`;
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
