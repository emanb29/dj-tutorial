/**
 * Searching SoundCloud and YouTube through yt-dlp's flat (metadata-only) search, and Spotify
 * through its Web API, into one result shape.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { SpotifyWebApi } from "./spotify.ts";

export type Platform = "soundcloud" | "youtube" | "spotify";
export const PLATFORMS: readonly Platform[] = ["soundcloud", "youtube", "spotify"];

export interface SearchResult {
  readonly platform: Platform;
  /** Unique across platforms: "soundcloud:123", "youtube:abc", "spotify:xyz". */
  readonly id: string;
  readonly title: string;
  /** The uploader (SoundCloud), channel (YouTube) or credited artists (Spotify). */
  readonly uploader: string;
  readonly durationSec: number | null;
  readonly url: string;
  /** Plays or views, when the platform says. */
  readonly plays: number | null;
}

const FlatEntrySchema = z.object({
  id: z.coerce.string(),
  title: z.string().nullish(),
  uploader: z.string().nullish(),
  channel: z.string().nullish(),
  duration: z.number().nullish(),
  webpage_url: z.string().nullish(),
  url: z.string().nullish(),
  view_count: z.number().nullish(),
  playback_count: z.number().nullish(),
});

/** yt-dlp's --dump-json lines for a flat search, as results. Lines that are not entries are skipped. */
export function parseFlatSearch(platform: "soundcloud" | "youtube", stdout: string): SearchResult[] {
  return stdout.split("\n").flatMap((line): SearchResult[] => {
    if (!line.startsWith("{")) return [];
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return [];
    }
    const parsed = FlatEntrySchema.safeParse(json);
    if (!parsed.success) return [];
    const entry = parsed.data;
    const url = entry.webpage_url ?? (platform === "youtube" ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url ?? "");
    if (url === "" || !entry.title) return [];
    return [
      {
        platform,
        id: `${platform}:${entry.id}`,
        title: entry.title,
        uploader: entry.uploader ?? entry.channel ?? "",
        durationSec: entry.duration ?? null,
        url,
        plays: entry.view_count ?? entry.playback_count ?? null,
      },
    ];
  });
}

export class SearchError extends Error {
  override readonly name = "SearchError";
}

export interface YtDlp {
  readonly binary: string;
}

export function runYtDlp(ytDlp: YtDlp, args: readonly string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlp.binary, ["--ignore-config", "--no-warnings", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SearchError(`Could not run ${ytDlp.binary} (${error.message}). Install yt-dlp (pipx install yt-dlp) or pass --yt-dlp PATH.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export interface Searcher {
  search(platform: Platform, query: string, limit: number): Promise<SearchResult[]>;
  readonly platforms: readonly Platform[];
}

export function searcher(ytDlp: YtDlp, spotify: SpotifyWebApi | null): Searcher {
  return {
    platforms: spotify === null ? ["soundcloud", "youtube"] : PLATFORMS,
    async search(platform, query, limit) {
      if (platform === "spotify") {
        if (spotify === null) return [];
        return (await spotify.search(query, limit)).map((track) => ({
          platform,
          id: `spotify:${track.id}`,
          title: track.title,
          uploader: track.artists.join(", "),
          durationSec: track.durationSec,
          url: track.url,
          plays: null,
        }));
      }
      const prefix = platform === "soundcloud" ? "scsearch" : "ytsearch";
      const { stdout, stderr, code } = await runYtDlp(ytDlp, ["--flat-playlist", "--dump-json", `${prefix}${String(limit)}:${query}`]);
      const results = parseFlatSearch(platform, stdout);
      if (results.length === 0 && code !== 0) throw new SearchError(`${platform} search for "${query}" failed: ${stderr.trim().split("\n").at(-1) ?? "no output"}`);
      return results;
    },
  };
}
