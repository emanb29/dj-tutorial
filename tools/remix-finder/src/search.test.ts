import { describe, expect, it } from "vitest";
import { parseFlatSearch } from "./search.ts";

describe("parseFlatSearch", () => {
  it("reads SoundCloud entries", () => {
    const stdout = [
      JSON.stringify({ id: 123, title: "Song (X Remix)", uploader: "X", duration: 240.5, webpage_url: "https://soundcloud.com/x/song-x-remix", playback_count: 5000 }),
      "not json",
      "{broken",
    ].join("\n");
    expect(parseFlatSearch("soundcloud", stdout)).toEqual([
      { platform: "soundcloud", id: "soundcloud:123", title: "Song (X Remix)", uploader: "X", durationSec: 240.5, url: "https://soundcloud.com/x/song-x-remix", plays: 5000 },
    ]);
  });

  it("builds a YouTube link from the ID when the entry has none", () => {
    const stdout = JSON.stringify({ id: "abc", title: "Song (Y Edit)", channel: "Y", duration: 200, view_count: 10 });
    expect(parseFlatSearch("youtube", stdout)[0]).toMatchObject({ id: "youtube:abc", uploader: "Y", url: "https://www.youtube.com/watch?v=abc", plays: 10 });
  });

  it("skips entries without a title", () => {
    expect(parseFlatSearch("youtube", JSON.stringify({ id: "abc" }))).toEqual([]);
  });
});
