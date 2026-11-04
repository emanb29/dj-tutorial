// The Creative Commons starter pack: tracks/starter-pack.json (see tracks/README.md), bundled into
// the app, streamed from archive.org at load time. archive.org sends ACAO * on both redirect hops,
// so a `mode: "cors"` fetch works on the COEP-credentialless page.
import { z } from "zod";
import { describeIssues } from "@shared/learner.ts";
import manifest from "../../tracks/starter-pack.json";
import { describeLicence } from "./licence.ts";
import { decodeAndHash, decodeOffline, fetchBytes, matchesQuery, type AudioDecoder } from "./load-audio.ts";
import type { Track, TrackSource } from "./types.ts";

const StarterPackEntrySchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  licence: z.string().min(1),
  artist: z.string().min(1),
  title: z.string().min(1),
  durationSec: z.number().positive(),
  genre: z.string().min(1),
  bpmEstimate: z.number().positive(),
  introBars: z.number().int().nonnegative(),
  outroBars: z.number().int().nonnegative(),
});

export interface StarterPackOptions {
  readonly fetch?: typeof fetch;
  readonly decode?: AudioDecoder;
}

function parseManifest(): readonly { readonly track: Track; readonly url: string }[] {
  const parsed = z.array(StarterPackEntrySchema).safeParse(manifest);
  // The manifest ships inside the bundle, so a bad one is a build bug, not a runtime condition.
  if (!parsed.success) {
    throw new Error(`tracks/starter-pack.json does not match its schema; fix it:\n- ${describeIssues(parsed.error).join("\n- ")}`);
  }
  return parsed.data.map((entry) => {
    const licence = describeLicence(entry.licence);
    const item = entry.id.split("/")[0] ?? entry.id;
    const track: Track = {
      id: entry.id,
      source: "starter-pack",
      title: entry.title,
      artist: entry.artist,
      bpmHint: entry.bpmEstimate,
      genre: entry.genre,
      licence: entry.licence,
      attribution: {
        text: `"${entry.title}" by ${entry.artist}, ${licence.name}, via the Internet Archive`,
        url: `https://archive.org/details/${item}`,
      },
      shareable: licence.shareable,
      durationSec: entry.durationSec,
      analysisCacheKey: null,
      retention: "persistable",
    };
    return { track, url: entry.url };
  });
}

export function createStarterPackSource(options: StarterPackOptions = {}): TrackSource {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const decode = options.decode ?? decodeOffline;
  const entries = parseManifest();
  const tracks = entries.map((entry) => entry.track);
  const urls = new Map(entries.map((entry) => [entry.track.id, entry.url]));

  return {
    kind: "starter-pack",
    list: () => Promise.resolve({ ok: true, value: tracks }),
    search: (query) => Promise.resolve({ ok: true, value: tracks.filter((track) => matchesQuery(track, query)) }),
    async load(track, loadOptions = {}) {
      const url = urls.get(track.id);
      if (track.source !== "starter-pack" || url === undefined) {
        return {
          ok: false,
          error: { kind: "not-found", message: `"${track.title}" is not in the starter pack.`, fix: "Load it from the source that listed it." },
        };
      }
      const bytes = await fetchBytes(fetchFn, url, { mode: "cors", credentials: "omit" }, "archive.org", loadOptions);
      if (!bytes.ok) return bytes;
      return decodeAndHash(track, bytes.value, decode, loadOptions);
    },
    // archive.org serves byte ranges, so a preview streams the file.
    preview(track) {
      const url = track.source === "starter-pack" ? urls.get(track.id) : undefined;
      if (url === undefined) return null;
      return { media: { kind: "url", url }, hints: () => Promise.resolve(track.durationSec === undefined ? {} : { durationSec: track.durationSec }) };
    },
  };
}
