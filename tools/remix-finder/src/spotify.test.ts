import { describe, expect, it } from "vitest";
import { credentialsFromEnv, parseEmbedPlaylist, parseEmbedPreview, playlistId, SpotifyError } from "./spotify.ts";

const page = (entity: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;

describe("playlistId", () => {
  it.each([
    ["https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc", "37i9dQZF1DXcBWIGoYBM5M"],
    ["spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "37i9dQZF1DXcBWIGoYBM5M"],
    ["37i9dQZF1DXcBWIGoYBM5M", "37i9dQZF1DXcBWIGoYBM5M"],
    ["https://open.spotify.com/track/7bxaFZ1O3cHkgLKMsdC3xR", null],
  ])("%s → %s", (input, id) => {
    expect(playlistId(input)).toBe(id);
  });
});

describe("parseEmbedPlaylist", () => {
  it("reads songs, splitting the artists Spotify joins with a non-breaking space", () => {
    const html = page({
      name: "Test list",
      trackList: [
        { uri: "spotify:track:AAAAAAAAAAAAAAAAAAAAAA", title: "Song One", subtitle: "Artist A, Artist B", duration: 200_000, audioPreview: { url: "https://p.scdn.co/x" } },
        { uri: "spotify:episode:BBBBBBBBBBBBBBBBBBBBBB", title: "A podcast", subtitle: "Host", duration: 1000 },
        { uri: "spotify:track:CCCCCCCCCCCCCCCCCCCCCC", title: "Song Two", subtitle: "Artist C", duration: 180_500, audioPreview: null },
      ],
    });
    expect(parseEmbedPlaylist("id", html)).toEqual({
      id: "id",
      name: "Test list",
      via: "embed",
      songs: [
        { spotifyId: "AAAAAAAAAAAAAAAAAAAAAA", title: "Song One", artists: ["Artist A", "Artist B"], durationSec: 200, previewUrl: "https://p.scdn.co/x" },
        { spotifyId: "CCCCCCCCCCCCCCCCCCCCCC", title: "Song Two", artists: ["Artist C"], durationSec: 180.5, previewUrl: null },
      ],
    });
  });

  it("says what to do when the page has no data", () => {
    expect(() => parseEmbedPlaylist("id", "<html></html>")).toThrow(SpotifyError);
    expect(() => parseEmbedPlaylist("id", "<html></html>")).toThrow(/SPOTIFY_CLIENT_ID/);
  });

  it("reads a track's preview", () => {
    expect(parseEmbedPreview(page({ name: "Song", audioPreview: { url: "https://p.scdn.co/y" } }))).toBe("https://p.scdn.co/y");
    expect(parseEmbedPreview(page({ name: "Song" }))).toBeNull();
  });
});

describe("credentialsFromEnv", () => {
  it("needs both variables", () => {
    expect(credentialsFromEnv({ SPOTIFY_CLIENT_ID: "a" })).toBeNull();
    expect(credentialsFromEnv({ SPOTIFY_CLIENT_ID: "a", SPOTIFY_CLIENT_SECRET: " b " })).toEqual({ clientId: "a", clientSecret: "b" });
  });
});
