// The steps every source shares: fetch bytes with progress and abort, decode, hash. Failures are
// TrackError values with a fix; only programming errors throw.
import { z } from "zod";
import { describeIssues } from "@shared/learner.ts";
import { hashTrackBytes } from "@shared/track-hash.ts";
import type { LoadedTrack, LoadOptions, LoadProgress, Result, Track, TrackError } from "./types.ts";

/** Decodes an encoded file. It may detach the buffer it is given, so callers pass a copy. */
export type AudioDecoder = (bytes: ArrayBuffer) => Promise<AudioBuffer>;

const FETCH_SHARE = 0.8;
const DECODE_DONE = 0.95;

/**
 * Decodes through an OfflineAudioContext at `sampleRate`, so nothing can reach the speakers.
 * `decodeAudioData` resamples to the context's rate; pass the engine's rate (often 48 kHz on a Mac),
 * because the engine refuses buffers at any other rate.
 */
export function decoderAt(sampleRate: number): AudioDecoder {
  return (bytes) => new OfflineAudioContext(2, 1, sampleRate).decodeAudioData(bytes);
}

/** Decodes at 44.1 kHz. Only for callers with no engine; anything played on a deck uses `decoderAt`. */
export const decodeOffline: AudioDecoder = decoderAt(44_100);

export function abortedError(): TrackError {
  return { kind: "aborted", message: "Loading the track was cancelled.", fix: "Load it again when you want it." };
}

/** Reads `aborted` afresh; TypeScript would otherwise keep an earlier check's narrowing across awaits. */
function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function httpError(status: number, what: string): TrackError {
  const fix =
    status === 404 || status === 410
      ? "The file is gone from its host. Pick another track."
      : status === 429
        ? "The host is rate-limiting this app. Wait a minute, then try again."
        : status >= 500
          ? "The host is having trouble. Try again in a few minutes."
          : "Pick another track, or report this status if it keeps happening.";
  return { kind: "http", status, message: `${what} answered HTTP ${String(status)}.`, fix };
}

/** Fetches `url` and reads the whole body, reporting progress as it arrives. */
export async function fetchBytes(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  what: string,
  options: LoadOptions = {},
): Promise<Result<Uint8Array>> {
  const { signal, onProgress } = options;
  if (signal?.aborted === true) return { ok: false, error: abortedError() };
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    if (isAbort(error) || wasAborted(signal)) return { ok: false, error: abortedError() };
    return {
      ok: false,
      error: {
        kind: "network",
        message: `Could not reach ${what}: ${error instanceof Error ? error.message : String(error)}.`,
        fix: "Check the internet connection. If it works, the host may have stopped sending CORS headers; pick another track.",
      },
    };
  }
  if (!response.ok) return { ok: false, error: httpError(response.status, what) };

  const lengthHeader = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
  const report = (loadedBytes: number) => {
    const share = totalBytes === null ? 0 : Math.min(1, loadedBytes / totalBytes);
    onProgress?.({ stage: "fetching", loadedBytes, totalBytes, fraction: share * FETCH_SHARE });
  };
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  report(0);
  try {
    if (response.body === null) {
      const whole = new Uint8Array(await response.arrayBuffer());
      chunks.push(whole);
      loadedBytes = whole.length;
    } else {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loadedBytes += value.length;
        report(loadedBytes);
      }
    }
  } catch (error) {
    if (isAbort(error) || wasAborted(signal)) return { ok: false, error: abortedError() };
    return {
      ok: false,
      error: {
        kind: "network",
        message: `The download from ${what} broke off after ${String(loadedBytes)} bytes.`,
        fix: "Check the internet connection, then load the track again.",
      },
    };
  }
  const bytes = new Uint8Array(loadedBytes);
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  return { ok: true, value: bytes };
}

/** Decodes `bytes`, hashes them, and returns the track with its cache key and decoded duration. */
export async function decodeAndHash(
  track: Track,
  bytes: Uint8Array,
  decode: AudioDecoder,
  options: LoadOptions = {},
  extra: Pick<LoadedTrack, "knownGrid"> = {},
): Promise<Result<LoadedTrack>> {
  const { signal, onProgress } = options;
  const at = (stage: LoadProgress["stage"], fraction: number) => {
    onProgress?.({ stage, loadedBytes: bytes.length, totalBytes: bytes.length, fraction });
  };
  if (signal?.aborted === true) return { ok: false, error: abortedError() };
  at("decoding", FETCH_SHARE);
  let audio: AudioBuffer;
  try {
    // decodeAudioData detaches the buffer it gets, and the hash still needs the bytes.
    audio = await decode(bytes.slice().buffer);
  } catch (error) {
    if (wasAborted(signal)) return { ok: false, error: abortedError() };
    return {
      ok: false,
      error: {
        kind: "decode-failed",
        message: `The browser could not decode "${track.title}": ${error instanceof Error ? error.message : String(error)}.`,
        fix: "Use an MP3, WAV, FLAC, OGG or M4A file. If it plays elsewhere, convert it to MP3 or WAV and add it again.",
      },
    };
  }
  if (wasAborted(signal)) return { ok: false, error: abortedError() };
  at("hashing", DECODE_DONE);
  const contentHash = await hashTrackBytes(bytes, audio.duration);
  at("hashing", 1);
  return {
    ok: true,
    value: { track: { ...track, analysisCacheKey: contentHash, durationSec: audio.duration }, audio, contentHash, ...extra },
  };
}

/** Case-insensitive match of every word of `query` against the track's title, artist and genre. */
export function matchesQuery(track: Track, query: string): boolean {
  const haystack = `${track.title} ${track.artist} ${track.genre ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

const ApiErrorBodySchema = z.object({ error: z.string() });

/**
 * Fetches JSON and validates it with `schema`, collecting every problem. On an HTTP error, the
 * message carries the body's `error` field when it has one (our API's envelope does).
 */
export async function fetchJson<Schema extends z.ZodType>(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  what: string,
  schema: Schema,
  signal?: AbortSignal,
): Promise<Result<z.output<Schema>>> {
  if (signal?.aborted === true) return { ok: false, error: abortedError() };
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(url, { ...init, ...(signal === undefined ? {} : { signal }) });
    text = await response.text();
  } catch (error) {
    if (isAbort(error) || wasAborted(signal)) return { ok: false, error: abortedError() };
    return {
      ok: false,
      error: {
        kind: "network",
        message: `Could not reach ${what}: ${error instanceof Error ? error.message : String(error)}.`,
        fix: "Check the internet connection (for Originals, check the API server is running: npm run dev).",
      },
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const error = httpError(response.status, what);
    const serverMessage = ApiErrorBodySchema.safeParse(json);
    return { ok: false, error: serverMessage.success ? { ...error, message: `${error.message} ${serverMessage.data.error}` } : error };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const problems = json === undefined ? ["the body is not JSON"] : describeIssues(parsed.error);
    return {
      ok: false,
      error: {
        kind: "bad-response",
        message: `${what} sent a response this app does not understand (${String(problems.length)} problem(s)).`,
        fix: "Update the app; if it is current, the service may have changed its API. The problems list says what differs.",
        problems,
      },
    };
  }
  return { ok: true, value: parsed.data };
}
