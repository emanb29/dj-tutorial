import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryHandleStore } from "../local-files.ts";
import { memoryRekordboxCache } from "./cache.ts";
import { parseRekordboxFileHere } from "./parser.ts";
import { createRekordboxLink, type RekordboxFileHandle, type RekordboxLinkOptions, type XmlCandidate } from "./rekordbox-link.ts";

const xml = (...names: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="${String(names.length)}">
${names.map((name) => `<TRACK Name="${name}" Location="file://localhost/Users/dj/Music/${name}.mp3"/>`).join("\n")}
</COLLECTION></DJ_PLAYLISTS>`;

function fileHandle(name: string, text: string, lastModified = 1): RekordboxFileHandle & { text: string; lastModified: number; permission: PermissionState } {
  const handle = {
    kind: "file" as const,
    name,
    text,
    lastModified,
    permission: "granted" as PermissionState,
    getFile: () => Promise.resolve(new File([handle.text], name, { lastModified: handle.lastModified })),
    queryPermission: () => Promise.resolve(handle.permission),
    requestPermission: (): Promise<PermissionState> => {
      handle.permission = "granted";
      return Promise.resolve(handle.permission);
    },
  };
  return handle;
}

const candidate = (path: string, text: string, lastModified = 1): XmlCandidate => ({
  path,
  stamp: { size: text.length, lastModified },
  read: () => Promise.resolve(new File([text], path.split("/").at(-1) ?? path, { lastModified })),
});

function setUp(overrides: Partial<RekordboxLinkOptions> = {}) {
  const parsed: string[] = [];
  const cache = memoryRekordboxCache();
  const handleStore = memoryHandleStore<RekordboxFileHandle>();
  const options: RekordboxLinkOptions = {
    parse: (file) => {
      parsed.push(file instanceof File ? file.name : "blob");
      return parseRekordboxFileHere(file);
    },
    cache,
    handleStore,
    showOpenFilePicker: null,
    ...overrides,
  };
  return { link: createRekordboxLink(options), parsed, cache, handleStore, options };
}

describe("rekordbox link", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a picked rekordbox.xml once, remembers it, and keeps what it found", async () => {
    const handle = fileHandle("rekordbox.xml", xml("a", "b"));
    const { link, handleStore, cache } = setUp({ showOpenFilePicker: () => Promise.resolve(handle) });

    expect(await link.pickFile()).toEqual({ ok: true });

    expect(link.status()).toMatchObject({ from: "file", name: "rekordbox.xml", tracks: 2, skipped: 0, reading: false, problem: null });
    expect(link.library()?.matcher.match({ path: "Music/a.mp3", size: 0 })?.name).toBe("a");
    expect(await handleStore.get()).toBe(handle);
    expect(cache.records.get("file")?.library.tracks).toHaveLength(2);
  });

  it("on the next visit uses what it kept, and reads the file again only when it changed", async () => {
    const handle = fileHandle("rekordbox.xml", xml("a"));
    const first = setUp({ showOpenFilePicker: () => Promise.resolve(handle) });
    await first.link.pickFile();

    const again = setUp({ cache: first.cache, handleStore: first.handleStore });
    await again.link.start();
    expect(again.parsed).toEqual([]);
    expect(again.link.status().tracks).toBe(1);

    handle.text = xml("a", "b", "c");
    handle.lastModified = 2;
    const later = setUp({ cache: first.cache, handleStore: first.handleStore });
    await later.link.start();
    expect(later.parsed).toEqual(["rekordbox.xml"]);
    expect(later.link.status().tracks).toBe(3);
  });

  it("keeps the old collection, and asks for a click, when the browser wants permission again", async () => {
    const handle = fileHandle("rekordbox.xml", xml("a"));
    const first = setUp({ showOpenFilePicker: () => Promise.resolve(handle) });
    await first.link.pickFile();
    handle.permission = "prompt";

    const again = setUp({ cache: first.cache, handleStore: first.handleStore });
    await again.link.start();
    expect(again.link.status()).toMatchObject({ tracks: 1, needsPermission: true });

    handle.text = xml("a", "b");
    handle.lastModified = 5;
    expect(await again.link.pickFile()).toEqual({ ok: true });
    expect(again.link.status()).toMatchObject({ tracks: 2, needsPermission: false });
  });

  it("finds a rekordbox.xml in the music folder, skips other XML, and re-reads it when it changes", async () => {
    const { link, parsed } = setUp();

    await link.offerFolderFiles([candidate("Music/Apple Music Library.xml", `<?xml version="1.0"?><plist/>`), candidate("Music/export.xml", xml("a"))]);
    expect(link.status()).toMatchObject({ from: "folder", name: "Music/export.xml", tracks: 1 });

    await link.offerFolderFiles([candidate("Music/Apple Music Library.xml", `<?xml version="1.0"?><plist/>`), candidate("Music/export.xml", xml("a"))]);
    // Nothing changed: neither is read again (the plist is remembered as not rekordbox's).
    expect(parsed).toEqual(["Apple Music Library.xml", "export.xml"]);

    await link.offerFolderFiles([candidate("Music/export.xml", xml("a", "b"), 2)]);
    expect(link.status().tracks).toBe(2);
  });

  it("prefers a file called rekordbox.xml in the folder", async () => {
    const { link } = setUp();

    await link.offerFolderFiles([candidate("Music/a.xml", xml("a")), candidate("Music/DJ/rekordbox.xml", xml("a", "b"))]);

    expect(link.status()).toMatchObject({ name: "Music/DJ/rekordbox.xml", tracks: 2 });
  });

  it("drops the folder's collection when its file is gone", async () => {
    const { link } = setUp();
    await link.offerFolderFiles([candidate("Music/rekordbox.xml", xml("a"))]);

    await link.offerFolderFiles([]);

    expect(link.status()).toMatchObject({ from: null, tracks: 0 });
    expect(link.library()).toBeNull();
  });

  it("a picked file wins over one in the folder", async () => {
    const { link } = setUp();
    await link.useFile(new File([xml("a", "b", "c")], "picked.xml"));

    await link.offerFolderFiles([candidate("Music/rekordbox.xml", xml("a"))]);

    expect(link.status()).toMatchObject({ from: "file", name: "picked.xml", tracks: 3 });
  });

  it("says what is wrong with a file that is not rekordbox's, and keeps what it had", async () => {
    const { link } = setUp();
    await link.useFile(new File([xml("a")], "good.xml"));

    await link.useFile(new File(["<plist/>"], "wrong.xml"));

    expect(link.status().problem?.message).toBe("That file is not a rekordbox collection.");
    expect(link.status()).toMatchObject({ name: "good.xml", tracks: 1 });
  });

  it("says when this browser cannot pick a file to keep", async () => {
    const { link } = setUp();

    expect(await link.pickFile()).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(link.status().canPickFile).toBe(false);
  });

  it("forgets the picked file", async () => {
    const handle = fileHandle("rekordbox.xml", xml("a"));
    const { link, handleStore, cache } = setUp({ showOpenFilePicker: () => Promise.resolve(handle) });
    await link.pickFile();

    await link.forgetFile();

    expect(link.status()).toMatchObject({ from: null, tracks: 0 });
    expect(await handleStore.get()).toBeNull();
    expect(cache.records.has("file")).toBe(false);
  });
});
