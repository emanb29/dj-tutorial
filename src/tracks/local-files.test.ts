import { describe, expect, it } from "vitest";
import {
  createLocalFileSource,
  LOCAL_FILE_INPUT,
  memoryHandleStore,
  type DirectoryHandleLike,
  type FileHandleLike,
} from "./local-files.ts";
import { fakeDecoder } from "./test-support.ts";

function file(name: string, text = "ID3fake", type = "audio/mpeg") {
  return new File([text], name, { type, lastModified: 1_700_000_000_000 });
}

function fileHandle(name: string, text?: string, type?: string): FileHandleLike {
  return { kind: "file", name, getFile: () => Promise.resolve(file(name, text, type)) };
}

function directory(
  name: string,
  entries: readonly (FileHandleLike | DirectoryHandleLike)[],
  permission: PermissionState = "granted",
): DirectoryHandleLike & { permissionRequests: number } {
  const handle = {
    kind: "directory" as const,
    name,
    permissionRequests: 0,
    async *values() {
      for (const entry of entries) yield await Promise.resolve(entry);
    },
    queryPermission: () => Promise.resolve(permission),
    requestPermission: () => {
      handle.permissionRequests += 1;
      return Promise.resolve(permission);
    },
  };
  return handle;
}

describe("local file source", () => {
  it("offers a multi-file audio input", () => {
    expect(LOCAL_FILE_INPUT).toEqual({ type: "file", multiple: true, accept: "audio/*" });
  });

  it("turns added files into tracks, reading 'Artist - Title' from the file name", async () => {
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore() });

    const tracks = source.addFiles([file("Kay Grove - Brothers.mp3"), file("loop.wav", "RIFF", "audio/wav")]);

    expect(tracks).toMatchObject([
      {
        source: "local-file",
        artist: "Kay Grove",
        title: "Brothers",
        shareable: false,
        analysisCacheKey: null,
        retention: "persistable",
        attribution: { text: 'Your file "Kay Grove - Brothers.mp3"', url: null },
      },
      { artist: "Unknown artist", title: "loop" },
    ]);
    expect(await source.list()).toMatchObject({ ok: true, value: [{ title: "Brothers" }, { title: "loop" }] });
  });

  it("takes the whole file name as the title when the part after ' - ' is only punctuation", () => {
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore() });

    const tracks = source.addFiles([file("Kay Grove - -.mp3"), file("Kay Grove - ....mp3")]);

    expect(tracks).toMatchObject([
      { title: "Kay Grove - -", artist: "Unknown artist" },
      { title: "Kay Grove - ...", artist: "Unknown artist" },
    ]);
  });

  it("ignores files that are not audio and does not add the same file twice", () => {
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore() });

    source.addFiles([file("notes.txt", "hi", "text/plain")]);
    const again = source.addFiles([file("a.mp3"), file("a.mp3")]);

    expect(again).toHaveLength(1);
  });

  it("loads a file by reading it locally, never fetching, and keys the analysis cache", async () => {
    const decoder = fakeDecoder(2);
    const source = createLocalFileSource({ decode: decoder.decode, handleStore: memoryHandleStore() });
    const [track] = source.addFiles([file("x.mp3")]);
    if (track === undefined) throw new Error("not added");

    const loaded = await source.load(track);

    // printf 'ID3fake|duration-ms=2000' | sha256sum
    expect(loaded.ok && loaded.value.contentHash).toBe("8fc5c551daa68a9a88b68cb010dedc5bdb0f32e2b58a87744c80543fec1044b6");
    expect(decoder.decoded).toHaveLength(1);
  });

  it("returns not-found for a track this session never added", async () => {
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore() });
    const [track] = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore() }).addFiles([file("y.mp3")]);
    if (track === undefined) throw new Error("not added");

    expect(await source.load(track)).toMatchObject({ ok: false, error: { kind: "not-found" } });
  });

  it("says directory picking is unsupported when the browser has no File System Access", async () => {
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore(), showDirectoryPicker: null });

    expect(source.canPickDirectory).toBe(false);
    expect(await source.pickDirectory()).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  });

  it("picks a folder, lists the audio in it and its subfolders, and remembers the handle", async () => {
    const store = memoryHandleStore();
    const folder = directory("Music", [
      fileHandle("A - One.mp3"),
      fileHandle("cover.jpg", "jpg", "image/jpeg"),
      directory("Sub", [fileHandle("Two.flac", "fLaC", "")]),
    ]);
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: store, showDirectoryPicker: () => Promise.resolve(folder) });

    const picked = await source.pickDirectory();

    expect(picked.ok && picked.value.map((track) => track.title)).toEqual(["One", "Two"]);
    expect(await store.get()).toBe(folder);
  });

  it("returns aborted when the folder picker is cancelled", async () => {
    const source = createLocalFileSource({
      decode: fakeDecoder().decode,
      handleStore: memoryHandleStore(),
      showDirectoryPicker: () => Promise.reject(new DOMException("The user aborted a request.", "AbortError")),
    });

    expect(await source.pickDirectory()).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });

  it("restores the remembered folder, asking for permission again when needed", async () => {
    const store = memoryHandleStore();
    const folder = directory("Music", [fileHandle("A - One.mp3")], "prompt");
    await store.put(folder);
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: store, showDirectoryPicker: null });

    const restored = await source.restoreDirectory();

    expect(folder.permissionRequests).toBe(1);
    expect(restored).toMatchObject({ ok: false, error: { kind: "permission-denied" } });
  });

  it("restores a remembered folder whose permission is still granted", async () => {
    const store = memoryHandleStore();
    await store.put(directory("Music", [fileHandle("A - One.mp3")]));
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: store, showDirectoryPicker: null });

    const restored = await source.restoreDirectory();

    expect(restored.ok && restored.value.map((track) => track.title)).toEqual(["One"]);
  });

  it("returns not-found when no folder was remembered", async () => {
    const source = createLocalFileSource({ decode: fakeDecoder().decode, handleStore: memoryHandleStore(), showDirectoryPicker: null });

    expect(await source.restoreDirectory()).toMatchObject({ ok: false, error: { kind: "not-found" } });
  });
});
