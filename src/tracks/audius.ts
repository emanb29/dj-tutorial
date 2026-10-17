/**
 * Audius: search and stream tracks through the public API (docs/research on branch
 * research/audius-terms has the terms behind these rules).
 *
 * - Search: `GET {baseUrl}/v1/tracks/search?query=…&app_name=learn-to-dj`. Only tracks that are
 *   freely streamable come back: `is_streamable`, not `is_stream_gated`, no `stream_conditions`,
 *   `access.stream` not false, not deleted or unavailable. Gating is never worked around.
 * - Load: `GET {baseUrl}/v1/tracks/{id}/stream?app_name=…&skip_play_count=true`. It redirects to a
 *   content node; every hop sends ACAO *, so a `mode: "cors"` fetch works on the COEP page.
 * - Session only (API terms, "Content and data protection"): the audio lives in memory as the
 *   returned AudioBuffer and nowhere else. The fetch uses `cache: "no-store"`; this module never
 *   touches IndexedDB or Cache Storage. Tracks carry `retention: "session-only"` so callers know not
 *   to persist anything computed from them (including analysis results).
 * - At most 2 requests a second from this client (searches and streams share the limiter).
 * - Show `termsNotice()` wherever Audius search is offered: the API terms require giving users
 *   Audius's privacy policy and API terms. Show the attribution (artist, link) on the deck.
 *
 * `baseUrl` defaults to https://api.audius.co, Audius's gateway, which routes to a healthy
 * discovery node. Pass a specific discovery node's URL to pin one.
 */
import { z } from "zod";
import { decodeAndHash, decodeOffline, fetchBytes, fetchJson, type AudioDecoder } from "./load-audio.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limiter.ts";
import type { Result, Track, TrackSource } from "./types.ts";

export const AUDIUS_APP_NAME = "learn-to-dj";
export const AUDIUS_DEFAULT_BASE_URL = "https://api.audius.co";
export const AUDIUS_PRIVACY_POLICY_URL = "https://audius.co/legal/privacy-policy";
export const AUDIUS_API_TERMS_URL = "https://audius.co/legal/api-terms";
/** Tracks remembered from this session's searches; the oldest are forgotten past this. */
const MAX_REMEMBERED_TRACKS = 500;

const AudiusTrackSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  user: z.object({ name: z.string(), handle: z.string().optional() }),
  duration: z.number().nullish(),
  genre: z.string().nullish(),
  bpm: z.number().nullish(),
  musical_key: z.string().nullish(),
  license: z.string().nullish(),
  permalink: z.string().nullish(),
  is_streamable: z.boolean().nullish(),
  is_stream_gated: z.boolean().nullish(),
  stream_conditions: z.unknown().nullish(),
  access: z.object({ stream: z.boolean() }).partial().nullish(),
  is_delete: z.boolean().nullish(),
  is_available: z.boolean().nullish(),
});
type AudiusTrack = z.infer<typeof AudiusTrackSchema>;

const SearchResponseSchema = z.object({ data: z.array(z.unknown()) });

export interface AudiusOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly decode?: AudioDecoder;
  readonly limiter?: RateLimiter;
}

export interface AudiusSource extends TrackSource {
  /** The notice the API terms require: links to Audius's privacy policy and API terms. */
  termsNotice(): string;
}

function isFreelyStreamable(track: AudiusTrack): boolean {
  return (
    track.is_streamable === true &&
    track.is_stream_gated !== true &&
    track.stream_conditions == null &&
    track.access?.stream !== false &&
    track.is_delete !== true &&
    track.is_available !== false
  );
}

function toTrack(track: AudiusTrack): Track {
  return {
    id: track.id,
    source: "audius",
    title: track.title,
    artist: track.user.name,
    ...(track.bpm == null ? {} : { bpmHint: track.bpm }),
    ...(track.musical_key == null ? {} : { keyHint: track.musical_key }),
    ...(track.genre == null || track.genre === "" ? {} : { genre: track.genre }),
    ...(track.license == null ? {} : { licence: track.license }),
    attribution: {
      text: `"${track.title}" by ${track.user.name}, on Audius`,
      url: track.permalink == null ? null : `https://audius.co${track.permalink}`,
    },
    shareable: false,
    ...(track.duration == null ? {} : { durationSec: track.duration }),
    analysisCacheKey: null,
    retention: "session-only",
  };
}

export function createAudiusSource(options: AudiusOptions = {}): AudiusSource {
  const baseUrl = (options.baseUrl ?? AUDIUS_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const decode = options.decode ?? decodeOffline;
  const limiter = options.limiter ?? createRateLimiter({ requestsPerSecond: 2, maxWaiting: 16 });
  const found = new Map<string, Track>();
  const init: RequestInit = { mode: "cors", credentials: "omit" };

  function remember(tracks: readonly Track[]) {
    for (const track of tracks) {
      found.delete(track.id);
      found.set(track.id, track);
    }
    for (const id of found.keys()) {
      if (found.size <= MAX_REMEMBERED_TRACKS) break;
      found.delete(id);
    }
  }

  async function search(query: string, signal?: AbortSignal): Promise<Result<readonly Track[]>> {
    const slot = await limiter.acquire(signal);
    if (!slot.ok) return slot;
    const params = new URLSearchParams({ query, app_name: AUDIUS_APP_NAME });
    const response = await fetchJson(fetchFn, `${baseUrl}/v1/tracks/search?${params.toString()}`, init, "Audius", SearchResponseSchema, signal);
    if (!response.ok) return response;
    const tracks = response.value.data.flatMap((item) => {
      const parsed = AudiusTrackSchema.safeParse(item);
      // A malformed result is skipped, not fatal: the rest of the search is still usable.
      if (!parsed.success) console.warn("tracks.audius.skippedResult", parsed.error.issues.length, "problem(s)");
      return parsed.success && isFreelyStreamable(parsed.data) ? [toTrack(parsed.data)] : [];
    });
    remember(tracks);
    return { ok: true, value: tracks };
  }

  return {
    kind: "audius",
    list: () => Promise.resolve({ ok: true, value: [...found.values()] }),
    search: (query, searchOptions = {}) => search(query, searchOptions.signal),
    async load(track, loadOptions = {}) {
      if (track.source !== "audius" || !found.has(track.id)) {
        return {
          ok: false,
          error: {
            kind: "not-found",
            message: `"${track.title}" was not found in this session's Audius searches.`,
            fix: "Search Audius for it again, then load it from the results.",
          },
        };
      }
      const slot = await limiter.acquire(loadOptions.signal);
      if (!slot.ok) return slot;
      const params = new URLSearchParams({ app_name: AUDIUS_APP_NAME, skip_play_count: "true" });
      const url = `${baseUrl}/v1/tracks/${encodeURIComponent(track.id)}/stream?${params.toString()}`;
      const bytes = await fetchBytes(fetchFn, url, { ...init, cache: "no-store" }, "Audius", loadOptions);
      if (!bytes.ok) {
        const { error } = bytes;
        if (error.kind === "http" && (error.status === 401 || error.status === 403)) {
          return {
            ok: false,
            error: {
              kind: "not-streamable",
              message: `Audius would not stream "${track.title}" to this app (HTTP ${String(error.status)}).`,
              fix: "The artist limits who may stream it. Pick another track.",
            },
          };
        }
        return bytes;
      }
      return decodeAndHash(track, bytes.value, decode, loadOptions);
    },
    termsNotice: () =>
      `Audius tracks stream live from Audius and are never saved. By using Audius search you agree to Audius's Privacy Policy (${AUDIUS_PRIVACY_POLICY_URL}) and API Terms (${AUDIUS_API_TERMS_URL}).`,
  };
}
