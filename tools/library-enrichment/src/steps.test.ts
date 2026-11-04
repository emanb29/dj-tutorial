// Synthetic collection only (the repo is public).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyProposals } from "./apply.ts";
import { ORIGINAL_ARTIST_PREFIX, projectEdits } from "./export.ts";
import { readCollection, writeEnriched } from "./rekordbox-xml.ts";
import { reviewCards, reviewHtml } from "./review.ts";
import { soundCloudCache } from "./soundcloud.ts";
import { runNamesStep, runSoundCloudStep, scanCollection, type FileProbe } from "./steps.ts";
import { emptyStore } from "./store.ts";

const track = (id: string, name: string, file: string, extra = "") =>
  `<TRACK TrackID="${id}" Name="${name}" Artist="" Genre="" Year="0" Comments="" Remixer="" Mix="" ${extra}Location="file://localhost/E:/Lib/${encodeURIComponent(file)}"></TRACK>`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="4">
${track("1", "Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL] [1234567890]", "Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL] [1234567890].m4a")}
${track("2", "Kit Lane - Paper Boats [2234567890]", "Kit Lane - Paper Boats [2234567890].m4a").replace('Artist=""', 'Artist="Hand Set"')}
${track("3", "Copy of Glass Rivers", "copy.m4a")}
${track("4", "Gone", "gone.m4a")}
</COLLECTION></DJ_PLAYLISTS>
`;

// copy.m4a has the same bytes as the first file; gone.m4a is not on disk.
const HASHES: Record<string, string> = {
  "/music/Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL] [1234567890].m4a": "hash-a",
  "/music/Kit Lane - Paper Boats [2234567890].m4a": "hash-b",
  "/music/copy.m4a": "hash-a",
};

function probe(): FileProbe & { hashes: number } {
  const counter = {
    hashes: 0,
    stat: (path: string) => Promise.resolve(path in HASHES ? { size: 10, mtimeMs: 1 } : null),
    hash: (path: string) => {
      counter.hashes++;
      return Promise.resolve(HASHES[path] ?? "");
    },
  };
  return counter;
}

const collection = () => {
  const read = readCollection(XML);
  if (!read.ok) throw new Error(read.error);
  return read.tracks;
};
const NOW = new Date("2026-02-01T00:00:00Z");
const MAP = [{ from: "E:/Lib/", to: "/music/" }];

describe("an enrichment run, end to end", () => {
  it("scans by content hash, reusing hashes of unchanged files", async () => {
    const store = emptyStore();
    const files = probe();
    const first = await scanCollection(collection(), MAP, store, files);
    expect(first.summary).toMatchObject({ tracks: 4, missing: 1, hashed: 3, hashReused: 0, items: 2 });
    expect(store.items["hash-a"]?.paths).toHaveLength(2);
    const again = await scanCollection(collection(), MAP, store, files);
    expect(again.summary).toMatchObject({ hashed: 0, hashReused: 3 });
    expect(files.hashes).toBe(3);
  });

  it("runs step 1 once, again only when its input or version changes", async () => {
    const store = emptyStore();
    await scanCollection(collection(), MAP, store, probe());
    const item = store.items["hash-b"];
    if (item === undefined) throw new Error("no item");
    expect(runNamesStep(item, NOW)).toBe(true);
    expect(runNamesStep(item, NOW)).toBe(false);
    item.base = { ...item.base, name: "Kit Lane - Paper Boats (VIP) [2234567890]" };
    expect(runNamesStep(item, NOW)).toBe(true);
    // A hand-set artist is never proposed over.
    expect(item.steps.names?.proposals.some((proposal) => proposal.field === "artist")).toBe(false);
    expect(item.steps.names?.sourceId).toBe("2234567890");
  });

  it("applies high-band fills, projects them into a copy of the XML, and lists medium ones for review", async () => {
    const store = emptyStore();
    const { hashByTrackId } = await scanCollection(collection(), MAP, store, probe());
    const cache = soundCloudCache(mkdtempSync(join(tmpdir(), "enrich-steps-")));
    cache.put({
      id: "1234567890",
      fetchedAt: NOW.toISOString(),
      lookup: { status: "ok", track: { id: "1234567890", title: "Moss Harbor - Glass Rivers (Tinwhistle Remix)", uploader: "Harbor Promo", uploaderUrl: "", genre: "Dance & EDM", tags: ["Techno"], uploadDate: "20220301", releaseYear: null, description: "", url: "" } },
    });
    for (const item of Object.values(store.items)) {
      runNamesStep(item, NOW);
      runSoundCloudStep(item, cache, NOW);
    }
    applyProposals(store.items, [], { run: "r1", fields: ["artist", "originalArtist", "remixer", "mix", "genre", "genreRaw", "year"] });
    const a = store.items["hash-a"];
    expect(a?.applied.artist?.value).toBe("Tinwhistle");
    // The channel's genre came from tags (medium) and its upload year is medium: not applied, for review.
    expect(a?.applied.genre).toBeUndefined();
    const cards = reviewCards(Object.values(store.items), [], ["genre", "year"]);
    expect(cards.map((card) => [card.field, card.proposal.value])).toEqual([
      ["genre", "techno"],
      ["year", "2022"],
    ]);
    expect(reviewHtml(cards, NOW.toISOString())).toContain("&quot;decision&quot;:&quot;accept&quot;");

    const { edits, counts } = projectEdits(collection(), hashByTrackId, store.items);
    // Track 3 is the same file as track 1: it gets the same fills. Track 2's hand-set artist stays.
    expect(edits.get("1")).toMatchObject({ Artist: "Tinwhistle", Remixer: "Tinwhistle", Mix: "Tinwhistle Remix", Comments: `${ORIGINAL_ARTIST_PREFIX}Moss Harbor` });
    expect(edits.get("3")?.["Artist"]).toBe("Tinwhistle");
    expect(edits.get("2")?.["Artist"]).toBeUndefined();
    expect(counts["Artist"]).toBe(2);
    const enriched = readCollection(writeEnriched(XML, edits));
    if (!enriched.ok) throw new Error(enriched.error);
    expect(enriched.tracks.find((each) => each.trackId === "2")?.attributes["Artist"]).toBe("Hand Set");
    // The title is cleaned only when asked.
    expect(enriched.tracks[0]?.attributes["Name"]).toBe("Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL] [1234567890]");
  });
});
