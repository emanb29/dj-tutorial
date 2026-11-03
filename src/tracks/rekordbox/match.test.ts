import { describe, expect, it } from "vitest";
import { createRekordboxMatcher } from "./match.ts";
import { locationSegments, type RekordboxTrack } from "./xml.ts";

const track = (location: string, extra: Partial<RekordboxTrack> = {}): RekordboxTrack => ({
  name: location,
  artist: "",
  album: "",
  genre: "",
  tonality: "",
  rating: 0,
  playCount: 0,
  totalTimeSec: null,
  size: null,
  averageBpm: null,
  location,
  segments: locationSegments(location) ?? [],
  tempos: [],
  cues: [],
  ...extra,
});

describe("rekordbox matcher", () => {
  it("matches a folder file to the entry whose path ends the same way, the longer the better", () => {
    const house = track("file://localhost/Users/dj/Music/House/intro.mp3");
    const techno = track("file://localhost/Users/dj/Music/Techno/intro.mp3");
    const matcher = createRekordboxMatcher([house, techno]);

    // The browser knows only the picked folder ("Music") and below.
    expect(matcher.match({ path: "Music/Techno/intro.mp3", size: 10 })).toBe(techno);
    expect(matcher.match({ path: "Music/House/intro.mp3", size: 10 })).toBe(house);
  });

  it("matches percent-encoded paths with spaces and unicode, and macOS's decomposed accents", () => {
    const bjork = track("file://localhost/Users/dj/Music/Bj%C3%B6rk/J%C3%B3ga%20(Live).mp3");
    // macOS file names are often NFD ("o" + combining diaeresis); the browser may give either form.
    const decomposed = "Music/Björk/Jóga (Live).mp3";
    expect(createRekordboxMatcher([bjork]).match({ path: decomposed, size: 1 })).toBe(bjork);
  });

  it("ignores case, as macOS's disk does", () => {
    const entry = track("file://localhost/Users/dj/Music/House/Track.MP3");
    expect(createRekordboxMatcher([entry]).match({ path: "Music/house/track.mp3", size: 1 })).toBe(entry);
  });

  it("falls back to the file name and size where the folders differ (a copy on another disk)", () => {
    const entry = track("file://localhost/Volumes/USB/Contents/a.mp3", { size: 1234 });
    const other = track("file://localhost/Volumes/USB/Old/a.mp3", { size: 99 });
    const matcher = createRekordboxMatcher([entry, other]);

    expect(matcher.match({ path: "Music/a.mp3", size: 1234 })).toBe(entry);
    expect(matcher.match({ path: "Music/a.mp3", size: 5 })).toBeNull();
  });

  it("tells same-sized copies apart by length when it knows the file's", () => {
    const short = track("file://localhost/A/a.mp3", { size: 100, totalTimeSec: 200 });
    const long = track("file://localhost/B/a.mp3", { size: 100, totalTimeSec: 360 });
    const matcher = createRekordboxMatcher([short, long]);

    expect(matcher.match({ path: "Music/a.mp3", size: 100, durationSec: 359.6 })).toBe(long);
    expect(matcher.match({ path: "Music/a.mp3", size: 100 })).toBeNull();
  });

  it("does not match on the file name alone when the size says it is another file", () => {
    const entry = track("file://localhost/Users/dj/Desktop/intro.mp3", { size: 50 });
    expect(createRekordboxMatcher([entry]).match({ path: "Music/intro.mp3", size: 51 })).toBeNull();
    // With a folder in common, the path wins even if the size changed (rekordbox wrote new tags).
    const tagged = track("file://localhost/Users/dj/Music/House/intro.mp3", { size: 50 });
    expect(createRekordboxMatcher([tagged]).match({ path: "Music/House/intro.mp3", size: 51 })).toBe(tagged);
  });

  it("finds nothing for a file rekordbox does not have", () => {
    expect(createRekordboxMatcher([track("file://localhost/a.mp3")]).match({ path: "Music/b.mp3", size: 1 })).toBeNull();
  });
});
