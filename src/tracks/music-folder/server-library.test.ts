import { describe, expect, it, vi } from "vitest";
import { libraryFileUrl, type MusicLibraryIndex } from "@shared/music-library.ts";
import { memoryHandleStore, type DirectoryHandleLike } from "../local-files.ts";
import { memoryRekordboxCache } from "../rekordbox/cache.ts";
import { createRekordboxLink } from "../rekordbox/rekordbox-link.ts";
import { parseRekordboxXml } from "../rekordbox/xml.ts";
import { memoryEntryCache } from "./entry-cache.ts";
import { createMusicFolder, type AnalyseFileResult } from "./music-folder.ts";
import { scanFolder, type ScannedFile } from "./scan.ts";
import { isServerRoot, probeServerLibrary, scanServerLibrary, type ServerLibraryRoot } from "./server-library.ts";
import { fakeFolder } from "./test-support.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LIBRARY: MusicLibraryIndex = {
  configured: true,
  name: "Music",
  files: [
    { path: "House/Kay Grove - Brothers.mp3", size: 3, lastModified: 1_700_000_000_000 },
    { path: "Other - Track.mp3", size: 5, lastModified: 1_700_000_001_000 },
  ],
  xml: [{ path: "House/rekordbox.xml", size: 10, lastModified: 1 }],
  rekordboxXml: null,
  skipped: 1,
  truncated: false,
};

/** A fake API: the index, and each file's bytes by path. Records every URL asked for. */
function fakeServer(index: MusicLibraryIndex | Response, files: Readonly<Record<string, string>> = {}) {
  const urls: string[] = [];
  const fetch = vi.fn((input: string) => {
    const url = input;
    urls.push(url);
    if (url === "/api/music-library") return Promise.resolve(index instanceof Response ? index.clone() : json({ success: true, data: index }));
    const path = new URL(url, "http://app.test").searchParams.get("path");
    const body = url === "/api/music-library/rekordbox.xml" ? files["rekordbox.xml"] : path === null ? undefined : files[path];
    return Promise.resolve(body === undefined ? json({ success: false, error: "No such file." }, 404) : new Response(body, { headers: { "content-type": "audio/mpeg" } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls };
}

const scanAll = async (root: DirectoryHandleLike, scan: ReturnType<typeof scanServerLibrary>, maxFiles?: number) => {
  const found: ScannedFile[] = [];
  const summary = await scan(root, { onBatch: (batch) => found.push(...batch), ...(maxFiles === undefined ? {} : { maxFiles }) });
  return { found, summary };
};

async function serverRoot(server: ReturnType<typeof fakeServer>): Promise<ServerLibraryRoot> {
  const probe = await probeServerLibrary({ fetch: server.fetch });
  if (probe.kind !== "library") throw new Error(`expected a library, got ${probe.kind}`);
  return probe.root;
}

describe("probeServerLibrary", () => {
  it("finds the server's library and names it after the folder", async () => {
    const probe = await probeServerLibrary({ fetch: fakeServer(LIBRARY).fetch });

    expect(probe.kind).toBe("library");
    if (probe.kind === "library") {
      expect(probe.root.name).toBe("Music");
      expect(isServerRoot(probe.root)).toBe(true);
    }
  });

  it("is none when the server has no MUSIC_DIR, has no such route, or cannot be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unreachable = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;

    expect(await probeServerLibrary({ fetch: fakeServer({ configured: false }).fetch })).toEqual({ kind: "none" });
    expect(await probeServerLibrary({ fetch: fakeServer(json({ success: false, error: "No API route" }, 404)).fetch })).toEqual({ kind: "none" });
    expect(await probeServerLibrary({ fetch: unreachable })).toEqual({ kind: "none" });
  });

  it("is unavailable, with the server's own words, when MUSIC_DIR cannot be read", async () => {
    const error = "The server's music folder (MUSIC_DIR) cannot be read (ENOENT). Fix MUSIC_DIR in the server's .env.";
    const probe = await probeServerLibrary({ fetch: fakeServer(json({ success: false, error, code: "unavailable" }, 503)).fetch });

    expect(probe).toMatchObject({ kind: "unavailable", error: { kind: "network", message: error } });
  });

  it("is unavailable when the index does not match the contract", async () => {
    const probe = await probeServerLibrary({ fetch: fakeServer(json({ success: true, data: { configured: true, name: "Music", files: [{ path: "../x.mp3" }] } })).fetch });

    expect(probe.kind).toBe("unavailable");
  });
});

describe("scanServerLibrary", () => {
  it("lists the index's files from the folder's name down, reading none of them", async () => {
    const server = fakeServer(LIBRARY, { "House/Kay Grove - Brothers.mp3": "abc" });
    const root = await serverRoot(server);
    const { found, summary } = await scanAll(root, scanServerLibrary({ fetch: server.fetch }));

    expect(found.map(({ path, name, size, lastModified }) => ({ path, name, size, lastModified }))).toEqual([
      { path: "Music/House/Kay Grove - Brothers.mp3", name: "Kay Grove - Brothers.mp3", size: 3, lastModified: 1_700_000_000_000 },
      { path: "Music/Other - Track.mp3", name: "Other - Track.mp3", size: 5, lastModified: 1_700_000_001_000 },
    ]);
    expect(summary).toMatchObject({ files: 2, skipped: 1, truncated: false });
    expect(summary.xml.map((file) => file.path)).toEqual(["Music/House/rekordbox.xml"]);
    expect(server.urls.filter((url) => url.includes("/file"))).toEqual([]);

    const file = await found[0]?.handle.getFile();
    expect([await file?.text(), file?.lastModified, file?.name]).toEqual(["abc", 1_700_000_000_000, "Kay Grove - Brothers.mp3"]);
    expect(server.urls).toContain("/api/music-library/file?path=House%2FKay%20Grove%20-%20Brothers.mp3");
  });

  it("offers REKORDBOX_XML in place of the folder's .xml files when the server sets it", async () => {
    const server = fakeServer({ ...LIBRARY, rekordboxXml: { size: 12, lastModified: 5 } }, { "rekordbox.xml": "<DJ_PLAYLISTS/>" });
    const { summary } = await scanAll(await serverRoot(server), scanServerLibrary({ fetch: server.fetch }));

    expect(summary.xml.map((file) => [file.path, file.size])).toEqual([["rekordbox.xml", 12]]);
    expect(await (await summary.xml[0]?.handle.getFile())?.text()).toBe("<DJ_PLAYLISTS/>");
  });

  it("stops at maxFiles and says so", async () => {
    const server = fakeServer(LIBRARY);
    const { found, summary } = await scanAll(await serverRoot(server), scanServerLibrary({ fetch: server.fetch }), 1);

    expect(found).toHaveLength(1);
    expect(summary.truncated).toBe(true);
  });

  it("reads a file's start with a Range request, cutting a whole file a server sent instead", async () => {
    const server = fakeServer(LIBRARY, { "House/Kay Grove - Brothers.mp3": "abc", "Other - Track.mp3": "other" });
    const fetch = vi.fn((input: string, init?: RequestInit) => server.fetch(input, init));
    const { found } = await scanAll(await serverRoot(server), scanServerLibrary({ fetch: fetch as unknown as typeof globalThis.fetch }));
    const [first, second] = found;
    if (first?.handle.readPrefix === undefined || second?.handle.readPrefix === undefined) throw new Error("expected server handles to read a prefix");

    // The fake ignores Range and answers 200 with the whole file, as a proxy that drops the header would.
    expect(new TextDecoder().decode(await second.handle.readPrefix(2))).toBe("ot");
    expect(new TextDecoder().decode(await first.handle.readPrefix(4 * 1024 * 1024))).toBe("abc");
    expect(fetch.mock.calls.filter(([url]) => url.includes("/file")).map(([url, init]) => [url, new Headers(init?.headers).get("range")])).toEqual([
      ["/api/music-library/file?path=Other%20-%20Track.mp3", "bytes=0-1"],
      ["/api/music-library/file?path=House%2FKay%20Grove%20-%20Brothers.mp3", `bytes=0-${String(4 * 1024 * 1024 - 1)}`],
    ]);
  });

  it("refuses a range that does not start at the file's start", async () => {
    const server = fakeServer(LIBRARY);
    const fetch = ((input: string) =>
      input.includes("/file")
        ? Promise.resolve(new Response("xyz", { status: 206, headers: { "content-range": "bytes 7-9/10" } }))
        : server.fetch(input)) as typeof globalThis.fetch;
    const { found } = await scanAll(await serverRoot(server), scanServerLibrary({ fetch }));

    await expect(found[0]?.handle.readPrefix?.(3)).rejects.toThrow("not its start");
  });

  it("fails reading a file the server no longer has as a missing file does", async () => {
    const server = fakeServer(LIBRARY);
    const { found } = await scanAll(await serverRoot(server), scanServerLibrary({ fetch: server.fetch }));

    await expect(found[1]?.handle.getFile()).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(found[1]?.handle.readPrefix?.(10)).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

describe("music folder on the server's library", () => {
  const analyse = async (file: File): Promise<AnalyseFileResult> => ({ ok: true, contentHash: `hash-${await file.text()}`, bpm: 124, durationSec: 180 });

  function setUp(server: ReturnType<typeof fakeServer>, remembered: DirectoryHandleLike | null = null) {
    const handleStore = memoryHandleStore();
    if (remembered !== null) void handleStore.put(remembered);
    const music = createMusicFolder({
      analyse,
      entryCache: memoryEntryCache(),
      handleStore,
      showDirectoryPicker: () => Promise.resolve(fakeFolder("Picked", { "picked.mp3": "p" })),
      scan: (root, options) => (isServerRoot(root) ? scanServerLibrary({ fetch: server.fetch })(root, options) : scanFolder(root, options)),
      watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
      server: () => probeServerLibrary({ fetch: server.fetch }),
      notifyEveryMs: 0,
    });
    return { music, handleStore };
  }

  it("opens the server's library on start, with nothing picked, and analyses its files from the server", async () => {
    const server = fakeServer(LIBRARY, { "House/Kay Grove - Brothers.mp3": "abc", "Other - Track.mp3": "other" });
    // A folder this browser remembered from before is not used: the server's library wins.
    const { music } = setUp(server, fakeFolder("Old", { "old.mp3": "o" }));
    await music.start();
    await music.settled();

    expect(music.snapshot()).toMatchObject({ source: "server", folder: "Music", access: "granted", found: 2, canPick: false, skipped: 1 });
    expect(music.tracks().map((track) => track.title).toSorted()).toEqual(["Brothers", "Track"]);

    music.setBackgroundPaused(false);
    await music.settled();
    expect(music.snapshot().analysed).toBe(2);
    expect(music.files().map((file) => file.contentHash).toSorted()).toEqual(["hash-abc", "hash-other"]);
  });

  it("gives each file its URL for a preview to stream with byte ranges, so a preview never downloads it whole", async () => {
    const server = fakeServer(LIBRARY, { "House/Kay Grove - Brothers.mp3": "abc", "Other - Track.mp3": "other" });
    const { music } = setUp(server);
    await music.start();
    await music.settled();

    expect(music.files().map((file) => file.media).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { kind: "url", url: libraryFileUrl("House/Kay Grove - Brothers.mp3") },
      { kind: "url", url: libraryFileUrl("Other - Track.mp3") },
    ]);
  });

  it("refuses to pick, allow, import or forget: the folder belongs to the server's .env", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { music } = setUp(fakeServer(LIBRARY));
    await music.start();
    await music.settled();

    for (const outcome of [await music.pick(), await music.allowAccess()]) {
      expect(outcome).toMatchObject({ ok: false, error: { kind: "unsupported" } });
      if (!outcome.ok) expect(outcome.error.fix).toContain("MUSIC_DIR");
    }
    music.importFiles([new File(["x"], "x.mp3", { type: "audio/mpeg" })]);
    await music.forget();
    expect(music.snapshot()).toMatchObject({ source: "server", folder: "Music", found: 2 });
  });

  it("finds a file added on the server at the next rescan, and drops a removed one", async () => {
    let index: MusicLibraryIndex = LIBRARY;
    const server = fakeServer(LIBRARY);
    const fetch = ((input: string) =>
      input === "/api/music-library" ? Promise.resolve(json({ success: true, data: index })) : server.fetch(input)) as typeof globalThis.fetch;
    const { music } = setUp({ ...server, fetch });
    await music.start();
    await music.settled();

    index = { ...LIBRARY, files: [...LIBRARY.files.slice(0, 1), { path: "New - One.mp3", size: 1, lastModified: 2 }] };
    await music.rescan();
    await music.settled();

    expect(music.tracks().map((track) => track.title).toSorted()).toEqual(["Brothers", "One"]);
  });

  it("matches the server's rekordbox.xml to its files", async () => {
    const xml = `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox"/><COLLECTION Entries="1">
      <TRACK TrackID="1" Name="Brothers (Club Mix)" Artist="Kay Grove" AverageBpm="123.50" Size="3" Location="file://localhost/D:/Music/House/Kay%20Grove%20-%20Brothers.mp3"/>
      </COLLECTION></DJ_PLAYLISTS>`;
    const server = fakeServer({ ...LIBRARY, rekordboxXml: { size: xml.length, lastModified: 9 } }, { "rekordbox.xml": xml });
    const music = createMusicFolder({
      analyse,
      scan: (root, options) => scanServerLibrary({ fetch: server.fetch })(root, options),
      watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
      server: () => probeServerLibrary({ fetch: server.fetch }),
      rekordbox: createRekordboxLink({ parse: async (file) => parseRekordboxXml([await file.text()]), showOpenFilePicker: null }),
      notifyEveryMs: 0,
    });
    await music.start();
    await music.settled();

    expect(music.snapshot().rekordbox).toMatchObject({ from: "folder", matched: 1 });
    expect(music.tracks().find((track) => track.title === "Brothers (Club Mix)")).toMatchObject({ bpmHint: 123.5 });
  });

  it("uses the server's rekordbox.xml even where this device picked its own", async () => {
    const serverXml = `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox"/><COLLECTION Entries="1">
      <TRACK TrackID="1" Name="Brothers" Artist="Kay Grove" AverageBpm="123.50" Size="3" Location="file://localhost/D:/Music/House/Kay%20Grove%20-%20Brothers.mp3"/>
      </COLLECTION></DJ_PLAYLISTS>`;
    const deviceXml = serverXml.replace("123.50", "99.00");
    const parsed = await parseRekordboxXml([deviceXml]);
    if (!parsed.ok) throw new Error("the device's xml should parse");
    const cache = memoryRekordboxCache();
    await cache.put("file", { stamp: "mine.xml|1|1", name: "mine.xml", library: parsed.library });
    const server = fakeServer({ ...LIBRARY, rekordboxXml: { size: serverXml.length, lastModified: 9 } }, { "rekordbox.xml": serverXml });
    const music = createMusicFolder({
      analyse,
      scan: (root, options) => scanServerLibrary({ fetch: server.fetch })(root, options),
      watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
      server: () => probeServerLibrary({ fetch: server.fetch }),
      rekordbox: createRekordboxLink({ parse: async (file) => parseRekordboxXml([await file.text()]), cache, showOpenFilePicker: null }),
      notifyEveryMs: 0,
    });
    await music.start();
    await music.settled();

    expect(music.snapshot().rekordbox).toMatchObject({ from: "folder", name: "rekordbox.xml", serverExport: true, matched: 1 });
    expect(music.tracks().find((track) => track.title === "Brothers")).toMatchObject({ bpmHint: 123.5 });
  });

  it("says what is wrong, and does not fall back to this browser's folder, when the server's library cannot be read", async () => {
    const server = fakeServer(json({ success: false, error: "MUSIC_DIR cannot be read (ENOENT).", code: "unavailable" }, 503));
    const { music } = setUp(server, fakeFolder("Old", { "old.mp3": "o" }));
    await music.start();
    await music.settled();

    expect(music.snapshot()).toMatchObject({ source: "server", folder: null, access: "none", found: 0, problem: { message: "MUSIC_DIR cannot be read (ENOENT)." } });
  });

  it("uses this browser's remembered folder when the server has no library", async () => {
    const { music } = setUp(fakeServer({ configured: false }), fakeFolder("Old", { "old.mp3": "o" }));
    await music.start();
    await music.settled();

    expect(music.snapshot()).toMatchObject({ source: "device", folder: "Old", found: 1, canPick: true });
  });
});
