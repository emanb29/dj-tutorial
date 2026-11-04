/**
 * The steps, run over the store: reading the collection into it, then each step on the tracks
 * whose input or step version changed since it last ran (an incremental run).
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { NAME_PARSER_VERSION, parseTrackName, type NameParse } from "./name-parse.ts";
import { localPath, type CollectionTrack, type PathMapping } from "./rekordbox-xml.ts";
import { SOUNDCLOUD_STEP_VERSION, soundCloudProposals, type NamedCredits, type SoundCloudCache } from "./soundcloud.ts";
import type { Proposal, Store, StoreItem, TrackBase } from "./store.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

// --- The collection -------------------------------------------------------------------------------

export interface FileProbe {
  stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;
  hash(path: string): Promise<string>;
}

export interface ScanSummary {
  readonly tracks: number;
  readonly notAFile: number;
  readonly missing: number;
  readonly hashed: number;
  readonly hashReused: number;
  readonly items: number;
}

export function baseOf(track: CollectionTrack, path: string): TrackBase {
  const attribute = (name: string) => track.attributes[name] ?? "";
  return {
    trackId: track.trackId,
    name: attribute("Name"),
    fileName: basename(path),
    artist: attribute("Artist"),
    genre: attribute("Genre"),
    year: attribute("Year"),
    comments: attribute("Comments"),
    remixer: attribute("Remixer"),
    mix: attribute("Mix"),
  };
}

/** Puts every collection track whose file exists into the store, under its content hash. Returns TrackID → hash too. */
export async function scanCollection(
  tracks: readonly CollectionTrack[],
  mappings: readonly PathMapping[],
  store: Store,
  probe: FileProbe,
  concurrency = 8,
): Promise<{ readonly summary: ScanSummary; readonly hashByTrackId: Map<string, string> }> {
  let notAFile = 0;
  let missing = 0;
  let hashed = 0;
  let hashReused = 0;
  const hashByTrackId = new Map<string, string>();
  const seenPaths = new Map<string, string[]>();
  let next = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const index = next++;
      const track = tracks[index];
      if (track === undefined) break;
      const path = localPath(track.attributes["Location"] ?? "", mappings);
      if (path === null) {
        notAFile++;
        continue;
      }
      const stat = await probe.stat(path);
      if (stat === null) {
        missing++;
        continue;
      }
      const known = store.files[path];
      let hash: string;
      if (known?.size === stat.size && known.mtimeMs === stat.mtimeMs) {
        hash = known.hash;
        hashReused++;
      } else {
        hash = await probe.hash(path);
        store.files[path] = { size: stat.size, mtimeMs: stat.mtimeMs, hash };
        hashed++;
      }
      hashByTrackId.set(track.trackId, hash);
      seenPaths.set(hash, [...(seenPaths.get(hash) ?? []), path]);
      const base = baseOf(track, path);
      // The same file listed twice: the first TRACK in the collection speaks for it.
      const earlier = firstSeen.get(hash);
      if (earlier === undefined || index < earlier.index) firstSeen.set(hash, { index, base });
    }
  };
  const firstSeen = new Map<string, { readonly index: number; readonly base: TrackBase }>();
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const [hash, { base }] of firstSeen) {
    const paths = (seenPaths.get(hash) ?? []).toSorted();
    const item = store.items[hash];
    if (item === undefined) store.items[hash] = { hash, paths, base, steps: {}, applied: {} };
    else {
      item.base = base;
      item.paths = paths;
    }
  }
  return { summary: { tracks: tracks.length, notAFile, missing, hashed, hashReused, items: Object.keys(store.items).length }, hashByTrackId };
}

// --- Step 1: names --------------------------------------------------------------------------------

const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

export function namesInput(base: TrackBase) {
  return { rawName: base.name, fileName: base.fileName, tags: { artist: base.artist, remixer: base.remixer } };
}

export function nameProposals(base: TrackBase, parse: NameParse): Proposal[] {
  const evidence = [`name: "${base.name}"`, ...(normalized(base.fileName).startsWith(normalized(base.name)) ? [] : [`file: "${base.fileName}"`]), ...parse.removed.map((removed) => `removed (${removed.rule}): ${removed.text}`)];
  const proposals: Proposal[] = [];
  const add = (field: Proposal["field"], found: { readonly value: string; readonly band: Proposal["band"]; readonly rule: string; readonly source: string } | null) => {
    if (found === null || found.source === "tag" || found.value.trim() === "") return;
    proposals.push({ field, value: found.value, band: found.band, step: "names", stepVersion: NAME_PARSER_VERSION, source: found.source, rule: found.rule, evidence });
  };
  add("artist", parse.artist);
  add("originalArtist", parse.originalArtist);
  if (normalized(parse.title.value) !== normalized(base.name)) add("title", parse.title);
  add("remixer", parse.remixer);
  const lastMix = parse.mixes[parse.mixes.length - 1];
  if (lastMix !== undefined) add("mix", { value: lastMix.text, band: lastMix.band, rule: lastMix.rule, source: parse.mixKind?.source ?? "name" });
  return proposals;
}

/** Runs step 1 on an item if its name, file name or tags changed, or the parser did. Returns whether it ran. */
export function runNamesStep(item: StoreItem, now: Date): boolean {
  const input = namesInput(item.base);
  const inputKey = digest(input);
  const previous = item.steps.names;
  if (previous?.version === NAME_PARSER_VERSION && previous.inputKey === inputKey) return false;
  const parse = parseTrackName(input);
  item.steps.names = { version: NAME_PARSER_VERSION, inputKey, ranAt: now.toISOString(), proposals: nameProposals(item.base, parse), sourceId: parse.sourceId?.value ?? null };
  return true;
}

export const sourceIdOf = (item: StoreItem): string | null => item.steps.names?.sourceId ?? null;

// --- Step 2: SoundCloud ---------------------------------------------------------------------------

function namedCredits(item: StoreItem): NamedCredits {
  const value = (field: Proposal["field"]) => item.steps.names?.proposals.find((each) => each.field === field)?.value ?? null;
  const artist = item.base.artist.trim() === "" ? value("artist") : item.base.artist;
  return { artist, originalArtist: value("originalArtist"), remixer: value("remixer") ?? (item.base.remixer.trim() === "" ? null : item.base.remixer) };
}

/** Runs step 2 from the cache (lookups happen before, in lookupAll). Returns whether it ran. */
export function runSoundCloudStep(item: StoreItem, cache: SoundCloudCache, now: Date): boolean {
  const id = sourceIdOf(item);
  if (id === null) return false;
  const entry = cache.get(id, now);
  if (entry === null) return false;
  const credits = namedCredits(item);
  const inputKey = digest({ id, fetchedAt: entry.fetchedAt, credits });
  const previous = item.steps.soundcloud;
  if (previous?.version === SOUNDCLOUD_STEP_VERSION && previous.inputKey === inputKey) return false;
  const proposals = entry.lookup.status === "ok" ? soundCloudProposals(entry.lookup.track, credits) : [];
  item.steps.soundcloud = { version: SOUNDCLOUD_STEP_VERSION, inputKey, ranAt: now.toISOString(), proposals, lookup: entry.lookup.status };
  return true;
}
