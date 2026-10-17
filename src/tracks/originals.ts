// Originals: tracks the owner's generator made, served by the API (server/originals.ts). Their
// meta.json holds the exact grid and phrases, so load() returns a KnownBeatGrid and the track needs
// no analysis.
import { z } from "zod";
import { ORIGINALS_PATH, OriginalMetaSchema, OriginalSummarySchema, type OriginalMeta, type OriginalSummary } from "@shared/originals.ts";
import { decodeAndHash, decodeOffline, fetchBytes, fetchJson, matchesQuery, type AudioDecoder } from "./load-audio.ts";
import type { KnownBeatGrid, Result, Track, TrackSource } from "./types.ts";

const BEATS_PER_BAR = 4;

export interface OriginalsOptions {
  readonly fetch?: typeof fetch;
  readonly decode?: AudioDecoder;
  /** Prefix for the API, "" (same origin) by default. */
  readonly apiBase?: string;
}

const envelope = <Schema extends z.ZodType>(data: Schema) => z.object({ success: z.literal(true), data });

function toTrack(summary: OriginalSummary): Track {
  const keyHint =
    summary.camelot !== undefined && summary.key !== undefined ? `${summary.camelot} (${summary.key})` : (summary.camelot ?? summary.key);
  return {
    id: summary.id,
    source: "original",
    title: summary.title,
    artist: "learn-to-dj original",
    bpmHint: summary.bpm,
    ...(keyHint === undefined ? {} : { keyHint }),
    genre: summary.genre,
    licence: "Original, made for this app",
    attribution: { text: `"${summary.title}", an original made for learn-to-dj`, url: null },
    shareable: true,
    durationSec: summary.durationSec,
    analysisCacheKey: null,
    retention: "persistable",
  };
}

/** The constant-tempo 4/4 grid the generator rendered: every beat from bar 1 to the end of the track. */
export function knownGridFromMeta(meta: OriginalMeta): KnownBeatGrid {
  const beatSec = 60 / meta.bpm;
  const lastBeat = Math.min(meta.bars * BEATS_PER_BAR, Math.floor((meta.durationSec - meta.firstDownbeatSec) / beatSec) + 1);
  return {
    origin: "generator-meta",
    bpm: meta.bpm,
    durationSec: meta.durationSec,
    firstBeatSec: meta.firstDownbeatSec,
    downbeatPhase: 0,
    beatGrid: Array.from({ length: Math.max(0, lastBeat) }, (_, beat) => meta.firstDownbeatSec + beat * beatSec),
    phrases: meta.phrases.map((phrase) => ({
      startSec: meta.firstDownbeatSec + phrase.startBar * BEATS_PER_BAR * beatSec,
      bar: phrase.startBar + 1,
      lengthBars: phrase.lengthBars,
      section: phrase.section,
    })),
  };
}

export function createOriginalsSource(options: OriginalsOptions = {}): TrackSource {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const decode = options.decode ?? decodeOffline;
  const base = `${options.apiBase ?? ""}${ORIGINALS_PATH}`;
  const what = "the app's API (Originals)";

  async function list(signal?: AbortSignal): Promise<Result<readonly Track[]>> {
    const listed = await fetchJson(fetchFn, base, { credentials: "same-origin" }, what, envelope(z.array(OriginalSummarySchema)), signal);
    return listed.ok ? { ok: true, value: listed.value.data.map(toTrack) } : listed;
  }

  return {
    kind: "original",
    list: (searchOptions = {}) => list(searchOptions.signal),
    async search(query, searchOptions = {}) {
      const listed = await list(searchOptions.signal);
      return listed.ok ? { ok: true, value: listed.value.filter((track) => matchesQuery(track, query)) } : listed;
    },
    async load(track, loadOptions = {}) {
      const id = encodeURIComponent(track.id);
      const meta = await fetchJson(fetchFn, `${base}/${id}/meta`, { credentials: "same-origin" }, what, envelope(OriginalMetaSchema), loadOptions.signal);
      if (!meta.ok) return meta;
      const bytes = await fetchBytes(fetchFn, `${base}/${id}/audio`, { credentials: "same-origin" }, what, loadOptions);
      if (!bytes.ok) return bytes;
      return decodeAndHash(track, bytes.value, decode, loadOptions, { knownGrid: knownGridFromMeta(meta.value.data) });
    },
  };
}
