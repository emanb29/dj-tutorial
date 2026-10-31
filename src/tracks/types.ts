// The common shapes every track source shares. See index.ts for how to use them.
import type { TrackAnalysis } from "@analysis/types.ts";

export type TrackSourceKind = "starter-pack" | "local-file" | "audius" | "original";

export interface Attribution {
  /** e.g. `"Brothers" by Kay Grove, CC BY-NC-ND 2.5, via the Internet Archive`. Show it on the deck. */
  readonly text: string;
  /** Where the credit links: the item, track or artist page. null when there is nowhere to link. */
  readonly url: string | null;
}

export interface Track {
  /** Unique within its source; `source` + `id` is unique across sources. */
  readonly id: string;
  readonly source: TrackSourceKind;
  readonly title: string;
  readonly artist: string;
  /** A tempo someone else measured or declared. The analysis decides; this only helps choose tracks. */
  readonly bpmHint?: number;
  readonly keyHint?: string;
  readonly genre?: string;
  /** e.g. "deep house", where the source tags one (Originals). */
  readonly subgenre?: string;
  /** Licence URL or name as the source gives it, e.g. a Creative Commons URL. */
  readonly licence?: string;
  readonly attribution: Attribution;
  /** May a recorded mix with this track be shared? false for ND licences, Audius and unknown licences. */
  readonly shareable: boolean;
  readonly durationSec?: number;
  /** Stars, 1-5, where the Learner rated it (rekordbox). */
  readonly rating?: number;
  /** How often the Learner played it, where their DJ software counts (rekordbox). */
  readonly playCount?: number;
  /**
   * Key for the analysis cache (shared/track-hash.ts). It depends on the file's bytes, so it is null
   * until the track is loaded; `load()` returns the track with it filled in.
   */
  readonly analysisCacheKey: string | null;
  /**
   * `session-only`: the audio, and anything computed from it, must not outlive the session (no
   * IndexedDB, no Cache Storage, no server). Audius's API terms require it.
   */
  readonly retention: "persistable" | "session-only";
}

/**
 * An exact beat grid the source already knows (an Original's generator, or the grid the Learner set
 * in rekordbox), so the track needs no analysis to grade on. The grid
 * fields are `TrackAnalysis`'s own (src/analysis/types.ts), so a deck can use either. Bar 1 is
 * always known, so `downbeatPhase` is never null. Phrases are named sections from the generator,
 * not the analysis's energy-change `phraseHints`.
 */
export type KnownBeatGrid = Pick<TrackAnalysis, "bpm" | "durationSec" | "firstBeatSec" | "beatGrid"> & {
  readonly origin: "generator-meta" | "rekordbox";
  readonly downbeatPhase: NonNullable<TrackAnalysis["downbeatPhase"]>;
  readonly phrases: readonly KnownPhrase[];
};

export interface KnownPhrase {
  readonly startSec: number;
  /** 1-based bar number, as DJs count (the generator's 0-based startBar plus 1). */
  readonly bar: number;
  readonly lengthBars: number;
  /** e.g. intro, build, drop, breakdown, outro. */
  readonly section: string;
}

export interface LoadedTrack {
  /** The track with `analysisCacheKey` (and `durationSec`) set from the decoded audio. */
  readonly track: Track;
  readonly audio: AudioBuffer;
  /** SHA-256 key of the encoded bytes (shared/track-hash.ts); the same as `track.analysisCacheKey`. */
  readonly contentHash: string;
  readonly knownGrid?: KnownBeatGrid;
  /** Cue points the Learner set in their DJ software (rekordbox): hot cues go on the pads. */
  readonly cues?: readonly TrackCue[];
}

export interface TrackCue {
  /** Hot cues are on pads; memory cues are not. */
  readonly kind: "hot" | "memory";
  /** 0-based pad (A = 0); null for a memory cue. */
  readonly slot: number | null;
  readonly startSec: number;
  readonly name: string;
}

export type LoadStage = "fetching" | "decoding" | "hashing";

export interface LoadProgress {
  readonly stage: LoadStage;
  readonly loadedBytes: number;
  /** null when the server sent no length. */
  readonly totalBytes: number | null;
  /** Overall progress, 0-1, never decreasing. Fetching is 0-0.8; decoding and hashing the rest. */
  readonly fraction: number;
}

export interface LoadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: LoadProgress) => void;
}

export interface SearchOptions {
  readonly signal?: AbortSignal;
}

/** Expected reasons a source cannot list or load a track. Values, never throws; each says how to fix it. */
export type TrackError =
  | { readonly kind: "aborted"; readonly message: string; readonly fix: string }
  | { readonly kind: "network"; readonly message: string; readonly fix: string }
  | { readonly kind: "http"; readonly status: number; readonly message: string; readonly fix: string }
  | { readonly kind: "decode-failed"; readonly message: string; readonly fix: string }
  | { readonly kind: "not-found"; readonly message: string; readonly fix: string }
  | { readonly kind: "not-streamable"; readonly message: string; readonly fix: string }
  | { readonly kind: "rate-limited"; readonly message: string; readonly fix: string }
  | { readonly kind: "unsupported"; readonly message: string; readonly fix: string }
  | { readonly kind: "permission-denied"; readonly message: string; readonly fix: string }
  | { readonly kind: "bad-response"; readonly message: string; readonly fix: string; readonly problems: readonly string[] };

export type Result<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: TrackError };

export interface TrackSource {
  readonly kind: TrackSourceKind;
  /** The tracks this source offers now (for Audius and local files: what was searched or added this session). */
  list(options?: SearchOptions): Promise<Result<readonly Track[]>>;
  /** Tracks whose title, artist or genre match `query`. */
  search(query: string, options?: SearchOptions): Promise<Result<readonly Track[]>>;
  /** Fetches (or reads) and decodes the track, and computes its content hash. */
  load(track: Track, options?: LoadOptions): Promise<Result<LoadedTrack>>;
}
