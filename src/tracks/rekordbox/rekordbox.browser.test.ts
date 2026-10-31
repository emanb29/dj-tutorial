// The parts that need a real browser: parsing rekordbox.xml in its worker, and keeping what was
// read in IndexedDB. Hand-written XML; no real library.
import { describe, expect, it } from "vitest";
import { indexedDbRekordboxCache } from "./cache.ts";
import { parseRekordboxFile, parseRekordboxFileInWorker } from "./parser.ts";

const many = (count: number) => `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="${String(count)}">
${Array.from({ length: count }, (_, index) => `<TRACK Name="T${String(index)}" Location="file://localhost/Music/t${String(index)}.mp3"><TEMPO Inizio="0.1" Bpm="124" Metro="4/4" Battito="1"/></TRACK>`).join("\n")}
</COLLECTION></DJ_PLAYLISTS>`;

describe("rekordbox in the browser", () => {
  it("parses a big collection in a worker", async () => {
    const parsed = await parseRekordboxFileInWorker(new File([many(20_000)], "rekordbox.xml"));

    expect(parsed.ok && parsed.library.tracks.length).toBe(20_000);
    expect(parsed.ok && parsed.library.tracks[19_999]?.tempos[0]?.bpm).toBe(124);
  });

  it("says, from the worker, when a file is not rekordbox's", async () => {
    expect(await parseRekordboxFile(new File(["<plist/>"], "a.xml"))).toMatchObject({ ok: false, error: { kind: "not-rekordbox" } });
  });

  it("keeps what was read in IndexedDB, per place it came from", async () => {
    const cache = indexedDbRekordboxCache(`learn-to-dj-rekordbox-test-${String(Date.now())}`);
    const parsed = await parseRekordboxFile(new File([many(2)], "rekordbox.xml"));
    if (!parsed.ok) throw new Error("the fixture did not parse");

    await cache.put("folder", { stamp: "Music/rekordbox.xml|10|1", name: "Music/rekordbox.xml", library: parsed.library });

    expect(await cache.get("folder")).toMatchObject({ stamp: "Music/rekordbox.xml|10|1", library: { tracks: [{ name: "T0" }, { name: "T1" }] } });
    expect(await cache.get("file")).toBeNull();
    await cache.clear("folder");
    expect(await cache.get("folder")).toBeNull();
  });
});
