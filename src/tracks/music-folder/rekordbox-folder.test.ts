// The music folder with a rekordbox collection linked: matched tracks take rekordbox's tags, BPM,
// key and grid. Hand-written XML and fake audio; no real library.
import { describe, expect, it } from "vitest";
import { memoryHandleStore } from "../local-files.ts";
import { parseRekordboxFileHere } from "../rekordbox/parser.ts";
import { createRekordboxLink } from "../rekordbox/rekordbox-link.ts";
import { fakeDecoder } from "../test-support.ts";
import { memoryEntryCache } from "./entry-cache.ts";
import { createMusicFolder, type AnalyseFileResult } from "./music-folder.ts";
import { scanFolder } from "./scan.ts";
import { fakeFolder, type FakeFolder } from "./test-support.ts";

const COLLECTION = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="3">
    <TRACK Name="Brothers (Club Mix)" Artist="Kay Grove" Album="Night Shifts" Genre="Deep House" AverageBpm="123.50" Tonality="Am" Rating="204" PlayCount="9"
      TotalTime="300" Location="file://localhost/Users/dj/Music/House/Kay%20Grove%20-%20Brothers.mp3">
      <TEMPO Inizio="1.100" Bpm="123.50" Metro="4/4" Battito="3"/>
      <POSITION_MARK Name="Drop" Type="0" Start="62.0" Num="1" Red="255" Green="0" Blue="0"/>
      <POSITION_MARK Name="" Type="0" Start="1.1" Num="-1"/>
    </TRACK>
    <TRACK Name="Live Take" Artist="Band" Genre="Disco" AverageBpm="118.00" Location="file://localhost/Users/dj/Music/live.mp3">
      <TEMPO Inizio="0.000" Bpm="117.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="30.000" Bpm="119.00" Metro="4/4" Battito="1"/>
    </TRACK>
    <TRACK Name="Elsewhere" Location="file://localhost/Users/dj/Desktop/other.mp3"/>
  </COLLECTION>
</DJ_PLAYLISTS>`;

/** Analysis that always finds 120 BPM, so a rekordbox BPM is easy to tell from it. */
const analyse = async (file: File, signal: AbortSignal): Promise<AnalyseFileResult> => {
  await file.text();
  if (signal.aborted) return { ok: false, kind: "aborted" };
  return { ok: true, contentHash: `hash-${file.name}`, bpm: 120, durationSec: 200 };
};

function setUp(folder: FakeFolder) {
  const rekordbox = createRekordboxLink({ parse: parseRekordboxFileHere, showOpenFilePicker: null, handleStore: memoryHandleStore() });
  const music = createMusicFolder({
    analyse,
    entryCache: memoryEntryCache(),
    handleStore: memoryHandleStore(),
    showDirectoryPicker: () => Promise.resolve(folder),
    scan: scanFolder,
    watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
    rekordbox,
  });
  music.setBackgroundPaused(false);
  return { music, rekordbox };
}

const byFile = (music: ReturnType<typeof createMusicFolder>, title: string) => music.tracks().find((track) => track.title === title);

describe("music folder with rekordbox", () => {
  it("finds rekordbox.xml in the folder and gives the tracks it knows rekordbox's tags and BPM", async () => {
    const folder = fakeFolder("Music", { "House/Kay Grove - Brothers.mp3": "a", "live.mp3": "b", "new.mp3": "c", "rekordbox.xml": COLLECTION });
    const { music } = setUp(folder);

    await music.pick();
    await music.settled();

    expect(music.snapshot()).toMatchObject({ found: 3, rekordbox: { from: "folder", name: "Music/rekordbox.xml", tracks: 3, matched: 2 } });
    expect(byFile(music, "Brothers (Club Mix)")).toMatchObject({ artist: "Kay Grove", genre: "Deep House", bpmHint: 123.5, keyHint: "8A", rating: 4, playCount: 9 });
    // A grid rekordbox cannot give as one tempo still lists rekordbox's BPM.
    expect(byFile(music, "Live Take")).toMatchObject({ bpmHint: 118, genre: "Disco" });
    // A file rekordbox does not know keeps the app's own BPM.
    expect(byFile(music, "new")).toMatchObject({ bpmHint: 120 });
    // The album is the file's, known without reading it; a file rekordbox does not know has none.
    const albums = Object.fromEntries(music.files().map((file) => [file.name, file.album]));
    expect(albums).toEqual({ "Kay Grove - Brothers.mp3": "Night Shifts", "live.mp3": null, "new.mp3": null });
  });

  it("keeps the file name's title when rekordbox's is empty, blank or only punctuation", async () => {
    const xml = (name: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1"><TRACK Name="${name}" Artist="Kay Grove" Location="file://localhost/Users/dj/Music/Kay%20Grove%20-%20Brothers.mp3"/></COLLECTION></DJ_PLAYLISTS>`;
    for (const name of ["", "   ", "-", " – ", "?!", "..."]) {
      const folder = fakeFolder("Music", { "Kay Grove - Brothers.mp3": "a", "rekordbox.xml": xml(name) });
      const { music } = setUp(folder);
      await music.pick();
      await music.settled();
      expect(music.tracks().map((track) => track.title), `rekordbox Name="${name}"`).toEqual(["Brothers"]);
    }
  });

  it("takes rekordbox's title when it has a letter or a digit in it", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1"><TRACK Name="#1" Location="file://localhost/Users/dj/Music/Kay%20Grove%20-%20Brothers.mp3"/></COLLECTION></DJ_PLAYLISTS>`;
    const folder = fakeFolder("Music", { "Kay Grove - Brothers.mp3": "a", "rekordbox.xml": xml });
    const { music } = setUp(folder);
    await music.pick();
    await music.settled();
    expect(music.tracks().map((track) => track.title)).toEqual(["#1"]);
  });

  it("loads a matched track with rekordbox's grid and hot cues, in place of the app's guess", async () => {
    const folder = fakeFolder("Music", { "House/Kay Grove - Brothers.mp3": "a", "live.mp3": "b", "rekordbox.xml": COLLECTION });
    const { music } = setUp(folder);
    await music.pick();
    await music.settled();
    const source = music.source(fakeDecoder(4).decode);

    const brothers = byFile(music, "Brothers (Club Mix)");
    if (brothers === undefined) throw new Error("Brothers was not listed");
    const loaded = await source.load(brothers);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const beat = 60 / 123.5;
    // 1.1 s is beat 3, so beat 1 is two beats earlier, at 1.1 - 2 beats ≈ 0.128 s: bar 1 is the first beat.
    expect(loaded.value.knownGrid).toMatchObject({ origin: "rekordbox", bpm: 123.5, downbeatPhase: 0, durationSec: 4, phrases: [] });
    expect(loaded.value.knownGrid?.firstBeatSec).toBeCloseTo(1.1 - 2 * beat, 9);
    expect(loaded.value.cues).toEqual([
      { kind: "hot", slot: 1, startSec: 62, name: "Drop", type: "cue", colour: "#ff0000" },
      { kind: "memory", slot: null, startSec: 1.1, name: "", type: "cue" },
    ]);

    // A variable grid is left to the app's analysis (it grades on one tempo).
    const live = byFile(music, "Live Take");
    if (live === undefined) throw new Error("Live Take was not listed");
    const liveLoaded = await source.load(live);
    expect(liveLoaded.ok && liveLoaded.value.knownGrid).toBeUndefined();
  });

  it("says a track's grid is ready without decoding when rekordbox has a one-tempo grid for it", async () => {
    const folder = fakeFolder("Music", { "House/Kay Grove - Brothers.mp3": "a", "live.mp3": "b", "rekordbox.xml": COLLECTION });
    const { music } = setUp(folder);
    await music.pick();
    await music.settled();
    const brothers = byFile(music, "Brothers (Club Mix)");
    const live = byFile(music, "Live Take");
    if (brothers === undefined || live === undefined) throw new Error("a track was not listed");
    expect(music.gridReady(brothers.id)).toBe(true);
    // A variable grid is left to the app's analysis, which (faked here) has finished: ready too.
    expect(music.gridReady(live.id)).toBe(true);
    expect(music.gridReady("not-a-track")).toBe(false);
  });

  it("re-reads rekordbox.xml when a rescan sees it change, and drops it when it is gone", async () => {
    const folder = fakeFolder("Music", { "live.mp3": "b", "rekordbox.xml": COLLECTION });
    const { music } = setUp(folder);
    await music.pick();
    await music.settled();
    expect(music.snapshot().rekordbox).toMatchObject({ matched: 1 });

    folder.write("rekordbox.xml", COLLECTION.replace('Genre="Disco"', 'Genre="Funk"'), 1_700_000_100_000);
    await music.rescan();
    await music.settled();
    expect(byFile(music, "Live Take")?.genre).toBe("Funk");

    folder.remove("rekordbox.xml");
    await music.rescan();
    await music.settled();
    expect(music.snapshot().rekordbox).toMatchObject({ from: null, matched: 0 });
    expect(byFile(music, "live")).toMatchObject({ bpmHint: 120 });
  });

  it("applies a rekordbox.xml picked on its own to the folder's tracks", async () => {
    const folder = fakeFolder("Music", { "live.mp3": "b" });
    const { music, rekordbox } = setUp(folder);
    await music.pick();
    await music.settled();

    await rekordbox.useFile(new File([COLLECTION], "rekordbox.xml"));
    await music.settled();

    expect(music.snapshot().rekordbox).toMatchObject({ from: "file", matched: 1, tracks: 3 });
    expect(byFile(music, "Live Take")).toBeDefined();
  });
});
