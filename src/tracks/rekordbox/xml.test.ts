import { describe, expect, it } from "vitest";
import { locationSegments, parseRekordboxXml } from "./xml.ts";

// Hand-written XML in the shape of rekordbox's "Export Collection in xml format". No real library.
const collection = (tracks: string, entries = 1) => `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="${String(entries)}">
${tracks}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="Warm up" Type="1" KeyType="0" Entries="1"><TRACK Key="1"/></NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

const TRACK_ONE = `    <TRACK TrackID="1" Name="Brothers" Artist="Kay Grove" Genre="Deep House" Kind="MP3 File" Size="8123456"
      TotalTime="301" AverageBpm="124.00" Rating="204" PlayCount="7" Tonality="Am"
      Location="file://localhost/Users/dj/Music/House/Kay%20Grove%20-%20Brothers.mp3">
      <TEMPO Inizio="0.120" Bpm="124.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="62.051" Num="0" Red="40" Green="226" Blue="20"/>
      <POSITION_MARK Name="" Type="0" Start="0.120" Num="-1"/>
      <POSITION_MARK Name="Loop" Type="4" Start="93.0" End="100.742" Num="2"/>
    </TRACK>`;

const parse = (text: string) => parseRekordboxXml([text]);

describe("parseRekordboxXml", () => {
  it("reads a track's tags, grid and cues", async () => {
    const parsed = await parse(collection(TRACK_ONE));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.library.skippedTracks).toBe(0);
    expect(parsed.library.tracks).toHaveLength(1);
    expect(parsed.library.tracks[0]).toEqual({
      name: "Brothers",
      artist: "Kay Grove",
      genre: "Deep House",
      tonality: "Am",
      rating: 4,
      playCount: 7,
      totalTimeSec: 301,
      size: 8_123_456,
      averageBpm: 124,
      location: "file://localhost/Users/dj/Music/House/Kay%20Grove%20-%20Brothers.mp3",
      segments: ["Users", "dj", "Music", "House", "Kay Grove - Brothers.mp3"],
      tempos: [{ inizioSec: 0.12, bpm: 124, metro: "4/4", battito: 1 }],
      cues: [
        { kind: "hot", slot: 0, startSec: 62.051, name: "Drop", type: "cue", colour: "#28e214" },
        { kind: "memory", slot: null, startSec: 0.12, name: "", type: "cue" },
        { kind: "hot", slot: 2, startSec: 93, endSec: 100.742, name: "Loop", type: "loop" },
      ],
    });
  });

  it("keeps every TEMPO of a variable-tempo grid, in order", async () => {
    const parsed = await parse(
      collection(`<TRACK Name="Live" Location="file://localhost/Music/live.wav">
        <TEMPO Inizio="0.000" Bpm="120.00" Metro="4/4" Battito="1"/>
        <TEMPO Inizio="8.000" Bpm="121.50" Metro="4/4" Battito="1"/>
        <TEMPO Inizio="15.901" Bpm="122.00" Metro="4/4" Battito="1"/>
      </TRACK>`),
    );

    expect(parsed.ok && parsed.library.tracks[0]?.tempos.map((tempo) => tempo.bpm)).toEqual([120, 121.5, 122]);
  });

  it("skips and counts malformed tracks and marks, and goes on", async () => {
    const parsed = await parse(
      collection(
        `<TRACK Name="No location"/>
         <TRACK Name="Bad location" Location="http://example.com/a.mp3"/>
         <TRACK Name="Bad size" Size="lots" Location="file://localhost/Music/a.mp3"/>
         <TRACK Name="Bad tempo" Location="file://localhost/Music/b.mp3">
           <TEMPO Inizio="0.1" Bpm="fast" Metro="4/4" Battito="1"/>
           <TEMPO Inizio="1.1" Bpm="120" Metro="4/4" Battito="1"/>
           <POSITION_MARK Name="x" Type="0" Start="soon" Num="0"/>
           <POSITION_MARK Name="ok" Type="0" Start="4" Num="1"/>
         </TRACK>
         <TRACK Name="Fine" Location="file://localhost/Music/c.mp3"/>`,
        5,
      ),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.library.tracks.map((track) => track.name)).toEqual(["Bad tempo", "Fine"]);
    expect(parsed.library.skippedTracks).toBe(3);
    // One bad TEMPO makes the whole grid untrustworthy; one bad mark loses only that mark.
    expect(parsed.library.tracks[0]?.tempos).toEqual([]);
    expect(parsed.library.tracks[0]?.cues.map((cue) => cue.name)).toEqual(["ok"]);
    expect(parsed.library.skippedMarks).toBe(2);
  });

  it("decodes XML entities and percent-encoded unicode paths", async () => {
    const parsed = await parse(
      collection(`<TRACK Name="Caf&#233; &amp; Bar &quot;Edit&quot;" Artist="R&#xF6;yksopp"
        Location="file://localhost/Users/dj/Music/Bj%C3%B6rk%20%26%20Friends/%E6%97%A5%E6%9C%AC%20mix.flac"/>`),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.library.tracks[0]).toMatchObject({ name: 'Café & Bar "Edit"', artist: "Röyksopp" });
    expect(parsed.library.tracks[0]?.segments).toEqual(["Users", "dj", "Music", "Björk & Friends", "日本 mix.flac"]);
  });

  it("reads tags split across chunks, as a stream gives them", async () => {
    const text = collection(TRACK_ONE);
    const chunks = Array.from({ length: Math.ceil(text.length / 7) }, (_, index) => text.slice(index * 7, index * 7 + 7));

    const parsed = await parseRekordboxXml(chunks);

    expect(parsed.ok && parsed.library.tracks[0]?.cues).toHaveLength(3);
  });

  it("ignores the playlists' TRACK keys", async () => {
    const parsed = await parse(collection(TRACK_ONE));

    expect(parsed.ok && parsed.library.tracks).toHaveLength(1);
  });

  it("says when the file is not a rekordbox collection", async () => {
    expect(await parse(`<?xml version="1.0"?><plist version="1.0"><dict/></plist>`)).toMatchObject({ ok: false, error: { kind: "not-rekordbox" } });
    expect(await parse("")).toMatchObject({ ok: false, error: { kind: "not-rekordbox" } });
  });

  it("says when the file stops in the middle", async () => {
    const text = collection(TRACK_ONE);
    const cut = await parse(text.slice(0, text.indexOf("</COLLECTION>")));

    expect(cut).toMatchObject({ ok: false, error: { kind: "malformed" } });
  });
});

describe("locationSegments", () => {
  it("turns a Mac or Windows file URL into decoded path parts", () => {
    expect(locationSegments("file://localhost/Users/dj/Music/a%20b.mp3")).toEqual(["Users", "dj", "Music", "a b.mp3"]);
    expect(locationSegments("file://localhost/C:/Users/dj/Music/a.mp3")).toEqual(["C:", "Users", "dj", "Music", "a.mp3"]);
    expect(locationSegments("file:///Volumes/USB/Music/a.mp3")).toEqual(["Volumes", "USB", "Music", "a.mp3"]);
  });

  it("refuses what is not a file URL, or will not decode", () => {
    expect(locationSegments("https://example.com/a.mp3")).toBeNull();
    expect(locationSegments("file://localhost/Music/%E0%A4%A.mp3")).toBeNull();
    expect(locationSegments("file://localhost/")).toBeNull();
  });
});
