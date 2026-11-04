// Synthetic collection only (the repo is public).
import { describe, expect, it } from "vitest";
import { localPath, parsePathMap, readCollection, writeEnriched } from "./rekordbox-xml.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?>

<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="11" Name="Moss Harbor - Glass Rivers (Tinwhistle Remix) [1234567890]" Artist="" Genre=""
           Year="0" Comments="" Remixer="" Mix="" Location="file://localhost/E:/Music%20Library/In/Moss%20Harbor%20-%20Glass%20Rivers.m4a">
      <TEMPO Inizio="0.1" Bpm="128.00" Metro="4/4" Battito="1"/>
    </TRACK>
    <TRACK TrackID="12" Name="Fish &amp; Chips" Artist="Kit Lane" Location="file://localhost/E:/Music%20Library/In/fish.m4a"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1"><NODE Name="A" Type="1" KeyType="0" Entries="1"><TRACK Key="11"/></NODE></NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;

describe("readCollection", () => {
  it("reads every TRACK in the COLLECTION with its attributes, decoded, and not the playlists' TRACK keys", () => {
    const result = readCollection(XML);
    if (!result.ok) throw new Error(result.error);
    expect(result.tracks.map((track) => track.trackId)).toEqual(["11", "12"]);
    expect(result.tracks[1]?.attributes["Name"]).toBe("Fish & Chips");
    expect(result.tracks[0]?.attributes["Year"]).toBe("0");
  });

  it("says when the file is not a collection", () => {
    expect(readCollection("<html></html>")).toEqual({ ok: false, error: expect.stringContaining("rekordbox") as unknown });
  });
});

describe("writeEnriched", () => {
  it("fills only the attributes it is given, escaped, and leaves every other byte as it was", () => {
    const out = writeEnriched(XML, new Map([["11", { Artist: "Tinwhistle", Comments: 'Original artist: Moss "Harbor" & Co' }], ["12", { Genre: "House" }]]));
    const result = readCollection(out);
    if (!result.ok) throw new Error(result.error);
    expect(result.tracks[0]?.attributes).toMatchObject({ Artist: "Tinwhistle", Comments: 'Original artist: Moss "Harbor" & Co', Genre: "" });
    // A missing attribute is added.
    expect(result.tracks[1]?.attributes).toMatchObject({ Artist: "Kit Lane", Genre: "House", Name: "Fish & Chips" });
    const untouched = (text: string) => text.replace(/<TRACK TrackID[^>]*>/g, "");
    expect(untouched(out)).toBe(untouched(XML));
  });

  it("changes nothing with no edits", () => {
    expect(writeEnriched(XML, new Map())).toBe(XML);
  });
});

describe("localPath", () => {
  it("decodes a Location and maps its drive onto a local folder", () => {
    const map = parsePathMap(["E:/=/mnt/e/"]);
    expect(localPath("file://localhost/E:/Music%20Library/In/a%20b.m4a", map)).toBe("/mnt/e/Music Library/In/a b.m4a");
    expect(localPath("file://localhost/C:/x.m4a", map)).toBe("C:/x.m4a");
    expect(localPath("file://localhost/Users/dj/a.mp3", [])).toBe("/Users/dj/a.mp3");
    expect(localPath("http://example.com/a.mp3", map)).toBeNull();
  });

  it("rejects a malformed --path-map, saying how to write one", () => {
    expect(() => parsePathMap(["E:"])).toThrow(/FROM=TO/);
  });
});
