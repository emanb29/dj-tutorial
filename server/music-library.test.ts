import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LIBRARY_FILES, MAX_LIBRARY_XML_FILES, MusicLibraryIndexSchema, libraryFileUrl, type ConfiguredMusicLibrary } from "@shared/music-library.ts";
import { createApp } from "./app.ts";
import { memoryLogger } from "./logger.ts";
import { INDEX_TTL_MS, musicLibraryRoutes } from "./music-library.ts";
import { sameOriginPolicy } from "./same-origin.ts";
import { APP_ORIGIN, appRequest } from "./test-support.ts";

let parent: string;
let root: string;
let outside: string;
const logger = memoryLogger();
const MP3_BYTES = Uint8Array.from({ length: 1000 }, (_, index) => index % 256);
const WHEN = new Date("2026-10-01T12:00:00Z");

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "ltd-music-"));
  root = join(parent, "Music");
  outside = await mkdtemp(join(tmpdir(), "ltd-music-outside-"));
  await mkdir(join(root, "House", "Deep"), { recursive: true });
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "Kay Grove - Brothers.mp3"), MP3_BYTES);
  await utimes(join(root, "Kay Grove - Brothers.mp3"), WHEN, WHEN);
  await writeFile(join(root, "House", "Deep", "Loop.wav"), "RIFF");
  await writeFile(join(root, "House", "cover.jpg"), "jpg");
  await writeFile(join(root, "House", "rekordbox.xml"), "<DJ_PLAYLISTS/>");
  await writeFile(join(root, ".hidden", "secret.mp3"), "no");
  await writeFile(join(root, ".dotfile.mp3"), "no");
  await writeFile(join(outside, "escaped.mp3"), "secret");
  await writeFile(join(outside, "collection.xml"), "<DJ_PLAYLISTS Version=\"1\"/>");
  await symlink(outside, join(root, "Escape"));
  await symlink(join(root, "House"), join(root, "House link"));
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function app(musicLibrary: { root: string | null; rekordboxXml: string | null } = { root, rekordboxXml: null }) {
  return createApp({ sameOrigin: sameOriginPolicy([APP_ORIGIN], ["127.0.0.1:5180"]), musicLibrary, logger });
}

async function index(server = app(), query = ""): Promise<ConfiguredMusicLibrary> {
  const response = await appRequest(server, `/api/music-library${query}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { success: true; data: unknown };
  const parsed = MusicLibraryIndexSchema.parse(body.data);
  if (!parsed.configured) throw new Error("expected a configured library");
  return parsed;
}

describe("GET /api/music-library", () => {
  it("says there is none when the server has no MUSIC_DIR", async () => {
    for (const server of [createApp(), app({ root: null, rekordboxXml: null })]) {
      const response = await appRequest(server, "/api/music-library");
      expect(await response.json()).toEqual({ success: true, data: { configured: false } });
    }
  });

  it("lists the folder's audio and .xml files with sizes and dates, in name order, and nothing hidden, escaping or other", async () => {
    const library = await index();

    expect(library.name).toBe("Music");
    expect(library.files.map((file) => file.path)).toEqual([
      "House/Deep/Loop.wav",
      "House link/Deep/Loop.wav",
      "Kay Grove - Brothers.mp3",
    ]);
    expect(library.files.find((file) => file.path === "Kay Grove - Brothers.mp3")).toEqual({
      path: "Kay Grove - Brothers.mp3",
      size: 1000,
      lastModified: WHEN.getTime(),
    });
    expect(library.xml.map((file) => file.path)).toEqual(["House/rekordbox.xml", "House link/rekordbox.xml"]);
    expect(library).toMatchObject({ skipped: 0, truncated: false, rekordboxXml: null });
    expect(JSON.stringify(library)).not.toContain(parent);
  });

  it("keeps at most MAX_LIBRARY_XML_FILES .xml files", async () => {
    await mkdir(join(root, "Exports"));
    await Promise.all(Array.from({ length: MAX_LIBRARY_XML_FILES + 5 }, (_, n) => writeFile(join(root, "Exports", `e${String(n)}.xml`), "<x/>")));

    expect((await index()).xml).toHaveLength(MAX_LIBRARY_XML_FILES);
  });

  it("stops at MAX_LIBRARY_FILES and says so", async () => {
    await mkdir(join(root, "Big"));
    await Promise.all(Array.from({ length: MAX_LIBRARY_FILES }, (_, n) => writeFile(join(root, "Big", `${String(n)}.mp3`), "")));

    const library = await index();
    expect(library.files).toHaveLength(MAX_LIBRARY_FILES);
    expect(library.truncated).toBe(true);
  }, 60_000);

  it("reuses one walk for a few seconds, then walks again", async () => {
    let clock = 1_000_000;
    const server = createApp({ sameOrigin: sameOriginPolicy([APP_ORIGIN], []), logger });
    server.route("/lib", musicLibraryRoutes({ root, rekordboxXml: null, logger, now: () => clock }));
    const paths = async () => {
      const body = (await (await server.request("/lib")).json()) as { data: ConfiguredMusicLibrary };
      return body.data.files.map((file) => file.path);
    };
    expect(await paths()).toHaveLength(3);

    await writeFile(join(root, "New - Track.mp3"), "ID3");
    clock += INDEX_TTL_MS - 1;
    expect(await paths()).toHaveLength(3);
    clock += 1;
    expect(await paths()).toContain("New - Track.mp3");
  });

  it("answers 503 with what to fix when MUSIC_DIR cannot be read", async () => {
    const response = await appRequest(app({ root: join(parent, "gone"), rekordboxXml: null }), "/api/music-library");

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("unavailable");
    expect(body.error).toContain("MUSIC_DIR");
    expect(body.error).not.toContain(parent);
  });

  it("gives REKORDBOX_XML's size and date when it is set", async () => {
    const library = await index(app({ root, rekordboxXml: join(outside, "collection.xml") }));

    expect(library.rekordboxXml).toEqual({ size: 27, lastModified: expect.any(Number) as number });
  });

  it("is behind the same-origin guard", async () => {
    const response = await app().request("/api/music-library", { headers: { origin: "http://evil.test" } });

    expect(response.status).toBe(403);
  });
});

describe("GET /api/music-library/file", () => {
  it("sends a listed file with its type, length and an ETag, and 304 when the browser has it", async () => {
    const server = app();
    const response = await appRequest(server, libraryFileUrl("Kay Grove - Brothers.mp3"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES);
    const etag = response.headers.get("etag") ?? "";
    expect(etag).not.toBe("");

    const again = await appRequest(server, libraryFileUrl("Kay Grove - Brothers.mp3"), { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("answers a byte range with 206", async () => {
    const response = await appRequest(app(), libraryFileUrl("Kay Grove - Brothers.mp3"), { headers: { range: "bytes=10-19" } });

    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES.slice(10, 20));
  });

  it("answers the hash's 4 MB prefix request on a shorter file with all of it, as a 206", async () => {
    const response = await appRequest(app(), libraryFileUrl("Kay Grove - Brothers.mp3"), { headers: { range: `bytes=0-${String(4 * 1024 * 1024 - 1)}` } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-999/1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES);
  });

  it("sends files in subfolders and the folder's .xml", async () => {
    const wav = await appRequest(app(), libraryFileUrl("House/Deep/Loop.wav"));
    const xml = await appRequest(app(), libraryFileUrl("House/rekordbox.xml"));

    expect([wav.status, wav.headers.get("content-type")]).toEqual([200, "audio/wav"]);
    expect([xml.status, await xml.text()]).toEqual([200, "<DJ_PLAYLISTS/>"]);
  });

  it.each([
    ["a parent folder", "../outside.mp3"],
    ["a path through a parent", "House/../../x.mp3"],
    ["an absolute path", "/etc/passwd"],
    ["a hidden file", ".dotfile.mp3"],
    ["a hidden folder", ".hidden/secret.mp3"],
    ["a symlink out of the folder", "Escape/escaped.mp3"],
    ["a file that is not audio or .xml", "House/cover.jpg"],
    ["a folder", "House"],
    ["a missing file", "Nope.mp3"],
    ["a backslash", "House\\Deep\\Loop.wav"],
    ["no path", ""],
  ])("refuses %s with a 404", async (_, path) => {
    const response = await appRequest(app(), libraryFileUrl(path));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it("is a 404 when the server has no music library", async () => {
    const response = await appRequest(createApp(), libraryFileUrl("Kay Grove - Brothers.mp3"));

    expect(response.status).toBe(404);
  });
});

describe("GET /api/music-library/rekordbox.xml", () => {
  it("sends REKORDBOX_XML", async () => {
    const response = await appRequest(app({ root, rekordboxXml: join(outside, "collection.xml") }), "/api/music-library/rekordbox.xml");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(await response.text()).toBe("<DJ_PLAYLISTS Version=\"1\"/>");
  });

  it("is a 404 with what to do when it is unset or missing", async () => {
    for (const rekordboxXml of [null, join(outside, "missing.xml")]) {
      const response = await appRequest(app({ root, rekordboxXml }), "/api/music-library/rekordbox.xml");
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toContain("REKORDBOX_XML");
    }
  });
});
