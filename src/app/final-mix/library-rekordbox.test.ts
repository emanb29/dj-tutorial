// A music-folder track that rekordbox knows is prepared on rekordbox's grid (the Learner may have
// fixed it there), not the app's analysis, with its genre for the set's one-genre rule and its hot
// cues for the pads. Fake audio, hand-written XML.
import { describe, expect, it } from "vitest";
import { createMusicFolder, createRekordboxLink, memoryEntryCache, type AnalyseFileResult, type AudioDecoder } from "@tracks";
import { memoryHandleStore } from "../../tracks/local-files.ts";
import { parseRekordboxFileHere } from "../../tracks/rekordbox/parser.ts";
import { scanFolder } from "../../tracks/music-folder/scan.ts";
import { fakeFolder } from "../../tracks/music-folder/test-support.ts";
import { folderLibrary } from "./library.ts";

const COLLECTION = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1">
  <TRACK Name="Brothers" Artist="Kay Grove" Genre="Deep House" AverageBpm="124.00" Tonality="Am" Location="file://localhost/Users/dj/Music/brothers.mp3">
    <TEMPO Inizio="0.600" Bpm="124.00" Metro="4/4" Battito="2"/>
    <POSITION_MARK Name="Drop" Type="0" Start="20.5" Num="0"/>
  </TRACK>
</COLLECTION></DJ_PLAYLISTS>`;

/** The app's analysis would say 120 BPM; the grid must not be that one. */
const analyse = (): Promise<AnalyseFileResult> => Promise.resolve({ ok: true, contentHash: "hash", bpm: 120, durationSec: 60 });
const decode: AudioDecoder = () => Promise.resolve({ duration: 60, sampleRate: 44_100, numberOfChannels: 2, length: 60 * 44_100 } as AudioBuffer);

describe("a music-folder track rekordbox knows", () => {
  it("is prepared on rekordbox's grid, with its genre, key and hot cues", async () => {
    const folder = fakeFolder("Music", { "brothers.mp3": "fake", "rekordbox.xml": COLLECTION });
    const music = createMusicFolder({
      analyse,
      entryCache: memoryEntryCache(),
      handleStore: memoryHandleStore(),
      showDirectoryPicker: () => Promise.resolve(folder),
      scan: scanFolder,
      watch: () => Promise.resolve({ how: "polling", stop: () => undefined }),
      rekordbox: createRekordboxLink({ parse: parseRekordboxFileHere, showOpenFilePicker: null }),
    });
    music.setBackgroundPaused(false);
    await music.pick();
    await music.settled();

    const [item] = folderLibrary(music, decode).items();
    expect(item).toMatchObject({ title: "Brothers", bpm: 124, camelot: "8A", genre: "deep house" });
    const prepared = await item?.prepare({ sampleRate: 44_100, signal: new AbortController().signal, onStatus: () => undefined });

    expect(prepared?.ok).toBe(true);
    if (prepared?.ok !== true) return;
    const beat = 60 / 124;
    // 0.6 s is beat 2: beat 1 is one beat earlier, and it is the first beat after -50 ms.
    expect(prepared.prepared.candidate.track.grid).toEqual({ bpm: 124, firstBeat: expect.closeTo(0.6 - beat, 9) as number, downbeatIndex: 0, rmsResidualMs: 0 });
    expect(prepared.prepared.candidate.track.phraseStarts[1]).toBeCloseTo(0.6 - beat + 32 * beat, 9);
    expect(prepared.prepared.candidate.genre).toBe("deep house");
    expect(prepared.prepared.hotCues).toEqual([{ slot: 0, sec: 20.5 }]);
    music.dispose();
  });
});
