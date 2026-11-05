/**
 * npm run find -- PLAYLIST [options]
 *
 * Finds remixes, edits and other versions of a Spotify playlist's songs on SoundCloud, YouTube and
 * Spotify, measures each one's BPM and key, lets an agent shortlist them, and writes a page to
 * browse them and build playlists from.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runAgent, type AgentOutcome } from "./agent.ts";
import { analyser } from "./audio.ts";
import { writeAtomically } from "./cache.ts";
import { finder, findForSong, type SongFindings } from "./finder.ts";
import { renderReport } from "./report.ts";
import { PLATFORMS, searcher, type Platform } from "./search.ts";
import { credentialsFromEnv, fetchPlaylist, webApi } from "./spotify.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const USAGE = `usage: npm run find -- PLAYLIST_LINK [options]

  --sources LIST      soundcloud,youtube,spotify (default: all; Spotify needs SPOTIFY_CLIENT_ID/SECRET)
  --per-search N      results per search per platform (default 10)
  --songs N           only the first N songs
  --no-measure        skip BPM and key (fast; metadata only)
  --concurrency N     clips measured at once (default 3)
  --no-agent          no shortlist: just every variant found
  --model ID          the agent's model (default claude-haiku-5-5; claude-opus-5-5 for more taste)
  --effort LEVEL      low|medium|high|xhigh|max (default medium)
  --budget USD        the agent's spending cap for this run, checked between turns (default 1)
  --picks N           shortlist size per song (default 3)
  --taste FILE        a text or Markdown description of your taste, for the agent
  --brief TEXT        what this run is for ("house edits for a sunset set")
  --mcp-config FILE   more MCP servers for the agent: {"mcpServers": {...}}
  --data DIR          cache folder (default .local/remix-finder/data at the repo root)
  --out DIR           where the page and JSON go (default .local/remix-finder)
  --yt-dlp PATH       yt-dlp binary (default yt-dlp)`;

class UsageError extends Error {
  override readonly name = "UsageError";
}

const positiveInt = (name: string, value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new UsageError(`--${name} must be a whole number above 0, not "${value}".`);
  return number;
};

const McpConfigSchema = z.object({ mcpServers: z.record(z.string(), z.looseObject({})) });

function readMcpConfig(path: string | undefined): Record<string, McpServerConfig> {
  if (path === undefined) return {};
  const parsed = McpConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new UsageError(`${path} is not an MCP config: it needs {"mcpServers": {"name": {...}}}, as in Claude Code's .mcp.json.`);
  return parsed.data.mcpServers as Record<string, McpServerConfig>;
}

function parse(argv: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      sources: { type: "string" },
      "per-search": { type: "string" },
      songs: { type: "string" },
      "no-measure": { type: "boolean", default: false },
      concurrency: { type: "string" },
      "no-agent": { type: "boolean", default: false },
      model: { type: "string", default: "claude-haiku-5-5" },
      effort: { type: "string", default: "medium" },
      budget: { type: "string", default: "1" },
      picks: { type: "string" },
      taste: { type: "string" },
      brief: { type: "string" },
      "mcp-config": { type: "string" },
      data: { type: "string" },
      out: { type: "string" },
      "yt-dlp": { type: "string", default: "yt-dlp" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals[0] === undefined) throw new UsageError(USAGE);
  const problems: string[] = [];
  const sources = (values.sources?.split(",").map((source) => source.trim()) ?? [...PLATFORMS]) as Platform[];
  const unknownSources = sources.filter((source) => !PLATFORMS.includes(source));
  if (unknownSources.length > 0) problems.push(`--sources: unknown ${unknownSources.join(", ")}; use ${PLATFORMS.join(", ")}.`);
  const effort = EFFORTS.find((level) => level === values.effort);
  if (effort === undefined) problems.push(`--effort must be one of ${EFFORTS.join(", ")}.`);
  const budget = Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) problems.push(`--budget must be a dollar amount above 0, not "${values.budget}".`);
  if (values.taste !== undefined && !existsSync(values.taste)) problems.push(`--taste: ${values.taste} does not exist.`);
  if (values["mcp-config"] !== undefined && !existsSync(values["mcp-config"])) problems.push(`--mcp-config: ${values["mcp-config"]} does not exist.`);
  let numbers = { perSearch: 10, songs: Infinity, concurrency: 3, picks: 3 };
  try {
    numbers = {
      perSearch: positiveInt("per-search", values["per-search"], 10),
      songs: values.songs === undefined ? Infinity : positiveInt("songs", values.songs, 1),
      concurrency: positiveInt("concurrency", values.concurrency, 3),
      picks: positiveInt("picks", values.picks, 3),
    };
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0 || effort === undefined) throw new UsageError(`${problems.join("\n")}\n\n${USAGE}`);
  const out = resolve(values.out ?? join(REPO_ROOT, ".local/remix-finder"));
  return {
    playlist: positionals[0],
    sources,
    ...numbers,
    measure: !values["no-measure"],
    agent: !values["no-agent"],
    model: values.model,
    effort,
    budget,
    taste: values.taste === undefined ? null : readFileSync(values.taste, "utf8"),
    brief: values.brief ?? null,
    mcpServers: readMcpConfig(values["mcp-config"]),
    data: resolve(values.data ?? join(out, "data")),
    out,
    ytDlp: { binary: values["yt-dlp"] },
  };
}

const log = (line: string) => {
  console.log(line);
};

async function main() {
  const args = parse(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const credentials = credentialsFromEnv();
  const spotify = credentials === null ? null : webApi(credentials);
  const notes: string[] = [];
  if (spotify === null && args.sources.includes("spotify")) {
    const note = "Spotify search is off: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (an app at developer.spotify.com) to search Spotify too";
    log(`${note}.`);
    notes.push(note);
  }

  const playlist = await fetchPlaylist(args.playlist, spotify, log);
  const songs = playlist.songs.slice(0, args.songs);
  log(`"${playlist.name}": ${String(playlist.songs.length)} songs${playlist.via === "embed" && playlist.songs.length >= 100 ? " (the first 100: set the Spotify variables for all)" : ""}; searching ${String(songs.length)}.`);

  const search = searcher(args.ytDlp, spotify);
  const allowed = { ...search, platforms: search.platforms.filter((platform) => args.sources.includes(platform)) };
  const found = finder({ searcher: allowed, analyse: analyser(args.ytDlp), dataDir: args.data, perSearch: args.perSearch, measure: args.measure, concurrency: args.concurrency, log });

  const findings: SongFindings[] = [];
  for (const [index, song] of songs.entries()) {
    const started = Date.now();
    const result = await findForSong(found, song);
    findings.push(result);
    const measured = result.candidates.filter((candidate) => candidate.analysis?.status === "ok").length;
    log(`[${String(index + 1)}/${String(songs.length)}] ${song.artists[0] ?? ""} – ${song.title}: ${String(result.candidates.length)} versions, ${String(measured)} measured (${String(Math.round((Date.now() - started) / 1000))} s)${result.problems.length > 0 ? `; ${String(result.problems.length)} problems` : ""}`);
  }

  const base = join(args.out, playlist.id);
  const write = (input: { findings: readonly SongFindings[]; outcome: AgentOutcome | null }) => {
    const report = { playlistName: playlist.name, generatedAt: new Date().toISOString(), findings: input.findings, picks: input.outcome?.picks ?? null, summary: input.outcome?.summary ?? null, notes };
    writeAtomically(`${base}.html`, renderReport(report));
    writeAtomically(`${base}.json`, `${JSON.stringify({ ...report, picks: input.outcome === null ? null : Object.fromEntries(input.outcome.picks) }, null, 2)}\n`);
  };
  write({ findings, outcome: null });

  if (args.agent) {
    log(`Shortlisting with ${args.model} (effort ${args.effort}, budget $${args.budget.toFixed(2)})…`);
    const outcome = await runAgent(playlist.name, findings, found, {
      model: args.model,
      effort: args.effort,
      maxBudgetUsd: args.budget,
      picksPerSong: args.picks,
      maxExtraSearchesPerSong: 3,
      taste: args.taste,
      brief: args.brief,
      extraMcpServers: args.mcpServers,
      log,
    });
    if (outcome.stoppedBecause !== null) notes.push(`The shortlist stopped early: ${outcome.stoppedBecause}`);
    write({ findings: outcome.findings, outcome });
    log(`Agent: $${outcome.costUsd.toFixed(2)}, ${String(outcome.picks.size)} of ${String(findings.length)} songs shortlisted${outcome.stoppedBecause === null ? "" : `; stopped because ${outcome.stoppedBecause}`}.`);
    if (outcome.summary !== "") log(`\n${outcome.summary}\n`);
  }
  log(`Page: ${base}.html`);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
