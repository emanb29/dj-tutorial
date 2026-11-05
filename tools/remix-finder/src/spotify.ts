/**
 * Spotify, for metadata and 30-second previews only.
 *
 * - A playlist's songs: through the Web API when SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are
 *   set (every song), else through the public embed page, which needs no account and lists the
 *   first 100.
 * - Search: Web API only, so Spotify results need those two variables. Without them the other
 *   platforms still run, and the CLI says how to turn Spotify search on.
 * - A track's preview URL: from its embed page (the Web API no longer gives one to new apps).
 */
import { z } from "zod";

export interface PlaylistSong {
  readonly spotifyId: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly durationSec: number;
  readonly previewUrl: string | null;
}

export interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly songs: readonly PlaylistSong[];
  /** "web-api" lists every song; "embed" the first 100 at most. */
  readonly via: "web-api" | "embed";
}

export interface SpotifyCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class SpotifyError extends Error {
  override readonly name = "SpotifyError";
}

/** The playlist's ID from a link ("open.spotify.com/playlist/ID?si=…"), a URI or the bare ID. */
export function playlistId(input: string): string | null {
  const match = /(?:playlist[/:])([A-Za-z0-9]{22})/.exec(input) ?? /^([A-Za-z0-9]{22})$/.exec(input.trim());
  return match?.[1] ?? null;
}

const trackIdOf = (uri: string) => /spotify:track:([A-Za-z0-9]{22})/.exec(uri)?.[1] ?? null;

// --- The embed page -------------------------------------------------------------------------------

const EmbedTrackSchema = z.object({
  uri: z.string(),
  title: z.string(),
  subtitle: z.string(),
  duration: z.number(),
  audioPreview: z.object({ url: z.string() }).nullish(),
});

const EmbedEntitySchema = z.object({
  name: z.string(),
  trackList: z.array(EmbedTrackSchema).optional(),
  audioPreview: z.object({ url: z.string() }).nullish(),
});

function embedEntity(html: string): z.infer<typeof EmbedEntitySchema> {
  const json = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw new SpotifyError("Spotify's embed page had no data in it; the page layout may have changed. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to use the Web API instead.");
  const data = z
    .object({ props: z.object({ pageProps: z.object({ state: z.object({ data: z.object({ entity: EmbedEntitySchema }) }) }) }) })
    .safeParse(JSON.parse(json));
  if (!data.success) throw new SpotifyError(`Spotify's embed page data has a new shape (${data.error.issues[0]?.message ?? "unknown"}). Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to use the Web API instead.`);
  return data.data.props.pageProps.state.data.entity;
}

/** A playlist from its embed page's HTML. */
export function parseEmbedPlaylist(id: string, html: string): Playlist {
  const entity = embedEntity(html);
  const songs = (entity.trackList ?? []).flatMap((track): PlaylistSong[] => {
    const spotifyId = trackIdOf(track.uri);
    if (spotifyId === null) return [];
    return [
      {
        spotifyId,
        title: track.title,
        artists: track.subtitle.split(/,\s*/u).map((artist) => artist.trim()).filter((artist) => artist !== ""),
        durationSec: track.duration / 1000,
        previewUrl: track.audioPreview?.url ?? null,
      },
    ];
  });
  return { id, name: entity.name, songs, via: "embed" };
}

/** A track's preview URL from its embed page's HTML, or null when it has none. */
export const parseEmbedPreview = (html: string) => embedEntity(html).audioPreview?.url ?? null;

const EMBED_HEADERS = { "User-Agent": "Mozilla/5.0 (remix-finder; personal use)" };

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) throw new SpotifyError(`${url} answered ${String(response.status)} ${response.statusText}.`);
  return response.text();
}

export async function previewUrl(trackId: string): Promise<string | null> {
  return parseEmbedPreview(await fetchText(`https://open.spotify.com/embed/track/${trackId}`, { headers: EMBED_HEADERS }));
}

// --- The Web API ----------------------------------------------------------------------------------

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): SpotifyCredentials | null {
  const clientId = env["SPOTIFY_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = env["SPOTIFY_CLIENT_SECRET"]?.trim() ?? "";
  return clientId === "" || clientSecret === "" ? null : { clientId, clientSecret };
}

const TokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });

const ApiTrackSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  artists: z.array(z.object({ name: z.string() })),
  duration_ms: z.number(),
  type: z.string().optional(),
});

const PlaylistPageSchema = z.object({
  items: z.array(z.object({ track: ApiTrackSchema.nullable().optional(), item: ApiTrackSchema.nullable().optional() })),
  next: z.string().nullable(),
});

const SearchSchema = z.object({ tracks: z.object({ items: z.array(ApiTrackSchema.extend({ external_urls: z.object({ spotify: z.string() }).optional() })) }) });

export interface SpotifySearchResult {
  readonly id: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly durationSec: number;
  readonly url: string;
}

export function webApi(credentials: SpotifyCredentials) {
  let token: { value: string; expiresAt: number } | null = null;
  const bearer = async () => {
    if (token !== null && Date.now() < token.expiresAt - 60_000) return token.value;
    const body = await fetchText("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const parsed = TokenSchema.parse(JSON.parse(body));
    token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
    return token.value;
  };
  const get = async (url: string) => JSON.parse(await fetchText(url, { headers: { Authorization: `Bearer ${await bearer()}` } })) as unknown;

  return {
    async playlist(id: string): Promise<Playlist> {
      const meta = z.object({ name: z.string() }).parse(await get(`https://api.spotify.com/v1/playlists/${id}?fields=name`));
      const songs: PlaylistSong[] = [];
      let next: string | null = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`;
      while (next !== null) {
        const page = PlaylistPageSchema.parse(await get(next));
        for (const entry of page.items) {
          const track = entry.track ?? entry.item;
          if (track?.id == null || (track.type !== undefined && track.type !== "track")) continue;
          songs.push({ spotifyId: track.id, title: track.name, artists: track.artists.map((artist) => artist.name), durationSec: track.duration_ms / 1000, previewUrl: null });
        }
        next = page.next;
      }
      return { id, name: meta.name, songs, via: "web-api" };
    },
    async search(query: string, limit: number): Promise<SpotifySearchResult[]> {
      const url = `https://api.spotify.com/v1/search?type=track&limit=${String(Math.min(limit, 50))}&q=${encodeURIComponent(query)}`;
      return SearchSchema.parse(await get(url)).tracks.items.flatMap((track) =>
        track.id === null
          ? []
          : [{ id: track.id, title: track.name, artists: track.artists.map((artist) => artist.name), durationSec: track.duration_ms / 1000, url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}` }],
      );
    },
  };
}
export type SpotifyWebApi = ReturnType<typeof webApi>;

/** The playlist through the Web API when there are credentials (falling back to the embed when it refuses), else the embed. */
export async function fetchPlaylist(input: string, api: SpotifyWebApi | null, log: (line: string) => void): Promise<Playlist> {
  const id = playlistId(input);
  if (id === null) throw new SpotifyError(`"${input}" is not a Spotify playlist link, URI or ID. Copy it from Spotify: Share → Copy link to playlist.`);
  if (api !== null) {
    try {
      return await api.playlist(id);
    } catch (error) {
      log(`The Spotify Web API refused the playlist (${error instanceof Error ? error.message : String(error)}); reading its public embed page instead (first 100 songs).`);
    }
  }
  return parseEmbedPlaylist(id, await fetchText(`https://open.spotify.com/embed/playlist/${id}`, { headers: EMBED_HEADERS }));
}
