/**
 * The taste step: a Claude Agent SDK agent that shortlists each song's variants.
 *
 * The deterministic pass (finder.ts) has already found and measured the candidates. The agent
 * reads them through in-process MCP tools, may run a few more searches (a remixer it knows, "VIP",
 * "flip"), and records its picks with a one-line reason each. It never measures anything itself:
 * BPM and key only ever come from the audio.
 *
 * It runs with no built-in tools (no shell, no file access) and no user or project settings; its
 * only tools are this file's, plus any MCP servers the caller passes in (--mcp-config).
 * Spend is capped per run (maxBudgetUsd). Credentials: ANTHROPIC_API_KEY when set (billed to that
 * key), else the local Claude Code login.
 */
import { createSdkMcpServer, query, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { harmonyWithOriginal, mergeFindings, type Candidate, type Finder, type SongFindings } from "./finder.ts";
import { PLATFORMS } from "./search.ts";

export interface Choice {
  readonly candidateId: string;
  readonly reason: string;
}

export interface SongPicks {
  readonly picks: readonly Choice[];
  /** Why nothing (or so little) was picked, when that is the case. */
  readonly note: string | null;
}

export interface AgentOptions {
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly maxBudgetUsd: number;
  readonly picksPerSong: number;
  readonly maxExtraSearchesPerSong: number;
  /** The listener's taste, as text (a taste profile file), or null. */
  readonly taste: string | null;
  /** What this run is for, in the listener's words ("house edits for a sunset set"), or null. */
  readonly brief: string | null;
  readonly extraMcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly log: (line: string) => void;
}

export interface AgentOutcome {
  readonly findings: SongFindings[];
  readonly picks: ReadonlyMap<number, SongPicks>;
  readonly summary: string;
  readonly costUsd: number;
  readonly stoppedBecause: string | null;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** One candidate as the agent sees it: everything it needs to judge, nothing it doesn't. */
export function candidateRow(findings: SongFindings, candidate: Candidate) {
  const analysis = candidate.analysis;
  return {
    id: candidate.id,
    title: candidate.title,
    by: candidate.uploader,
    kind: candidate.kind,
    remixer: candidate.remixer,
    dj: candidate.djFriendly,
    min: candidate.durationSec === null ? null : Math.round(candidate.durationSec / 6) / 10,
    plays: candidate.plays,
    bpm: analysis?.status === "ok" ? analysis.bpm : null,
    key: analysis?.status === "ok" ? (analysis.key?.camelot ?? null) : null,
    keySure: analysis?.status === "ok" && analysis.key !== null ? analysis.key.confidence >= 0.05 : null,
    withOriginal: harmonyWithOriginal(findings.original, analysis),
    sameAs: findings.candidates.filter((other) => other.id !== candidate.id && other.variantKey === candidate.variantKey).map((other) => other.id),
    measured: analysis === null ? "not measured" : analysis.status === "ok" ? (candidate.measuredFrom === null ? "yes" : `from ${candidate.measuredFrom}`) : `${analysis.status}: ${analysis.status === "unavailable" ? analysis.reason : analysis.message}`,
  };
}

export function systemPrompt(options: Pick<AgentOptions, "taste" | "brief" | "picksPerSong" | "maxExtraSearchesPerSong">): string {
  return [
    "You dig for remixes, edits and other versions of songs a listener loves, so they can build playlists of variants and DJ mixes from them.",
    "",
    "For every song in the playlist, call get_candidates, judge the variants, and call pick once with your shortlist. Work through all the songs, one at a time, then end with a short summary for the listener.",
    "",
    "How to judge:",
    `- Shortlist up to ${String(options.picksPerSong)} per song: the versions most worth a listen and most usable in a mix. Fewer is fine; none is fine when nothing is good (say why in the note).`,
    "- One pick per variant: results that are the same version on several platforms share `sameAs`; pick the best copy (the remixer's or label's own upload over a re-upload, measured over unmeasured, Spotify or SoundCloud over a YouTube rip).",
    "- Prefer real productions by credible remixers and producers, extended or club versions, and edits that keep the song recognisable. Be wary of anonymous re-uploads, AI-sounding names, and 'remix' used loosely.",
    "- `dj: false` marks listening versions (slowed, sped up, nightcore, acoustic, live, cover). Pick one only when it is clearly the standout version of the song.",
    "- BPM and key are measured from the audio (`keySure: false` means the key is a guess). Never invent or adjust them. A variant that changes the tempo to dance range or sits on a harmonic neighbour of other picks is useful for sets; say so in the reason when it matters.",
    "- Fit the listener's taste below. Genre and energy matter more than popularity; plays only break ties between copies.",
    `- If the candidates miss something you would expect (a well-known official remix, a remixer the listener would like), search_more with up to ${String(options.maxExtraSearchesPerSong)} queries per song. Don't search just to search.`,
    "- Each reason is one short line a DJ would find useful: who made it, what it does to the song, and why it fits.",
    "",
    options.brief === null ? "" : `What the listener wants from this run: ${options.brief}`,
    "",
    options.taste === null ? "No taste profile was given: judge by the songs in the playlist themselves." : `The listener's taste profile:\n${options.taste}`,
  ].join("\n");
}

export async function runAgent(playlistName: string, initial: readonly SongFindings[], finder: Finder, options: AgentOptions): Promise<AgentOutcome> {
  const findings = [...initial];
  const picks = new Map<number, SongPicks>();
  const extraSearches = new Map<number, number>();

  const songAt = (index: number) => {
    const found = findings[index];
    if (found === undefined) throw new RangeError(`There is no song ${String(index)}; list_songs gives indexes 0 to ${String(findings.length - 1)}.`);
    return found;
  };
  const guarded =
    <A>(handler: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) =>
    async (args: A) => {
      try {
        return await handler(args);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    };

  const server = createSdkMcpServer({
    name: "remix",
    version: "1.0.0",
    tools: [
      tool(
        "list_songs",
        "The playlist's songs: index, title, artists, the original's measured BPM and key, how many variants were found, and whether you have picked for it yet.",
        {},
        guarded(() =>
          text(
            findings.map((found, index) => ({
              index,
              title: found.song.title,
              artists: found.song.artists,
              bpm: found.original?.status === "ok" ? found.original.bpm : null,
              key: found.original?.status === "ok" ? (found.original.key?.camelot ?? null) : null,
              variants: found.candidates.length,
              picked: picks.has(index),
            })),
          ),
        ),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "get_candidates",
        "Every variant found for one song so far, with measured BPM and Camelot key, how the key sits with the original's, and which results are the same version on another platform.",
        { song: z.number().int().describe("The song's index from list_songs") },
        guarded(({ song }) => {
          const found = songAt(song);
          return text({
            song: { title: found.song.title, artists: found.song.artists },
            original: found.original?.status === "ok" ? { bpm: found.original.bpm, key: found.original.key?.camelot ?? null } : null,
            searched: found.queries,
            candidates: found.candidates.map((candidate) => candidateRow(found, candidate)),
          });
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "search_more",
        "Search the platforms again for one song with your own queries (for example a remixer's name with the title, or 'title VIP'). New variants are measured and added to the song's candidates; returns the new ones.",
        {
          song: z.number().int(),
          queries: z.array(z.string().min(3).max(120)).min(1).max(3),
          platforms: z.array(z.enum(PLATFORMS as unknown as [string, ...string[]])).optional().describe("Default: every platform available"),
        },
        guarded(async ({ song, queries, platforms }) => {
          const found = songAt(song);
          const used = extraSearches.get(song) ?? 0;
          const allowed = queries.slice(0, Math.max(0, options.maxExtraSearchesPerSong - used));
          if (allowed.length === 0) return failure(`No searches left for this song (${String(options.maxExtraSearchesPerSong)} each). Pick from what you have.`);
          extraSearches.set(song, used + allowed.length);
          options.log(`  agent searches: ${allowed.map((q) => `"${q}"`).join(", ")}`);
          const chosen = platforms?.filter((platform) => finder.platforms.includes(platform as never)) as typeof finder.platforms | undefined;
          const { candidates, problems } = await finder.variants(found.song, allowed, chosen);
          const before = new Set(found.candidates.map((candidate) => candidate.id));
          const merged = mergeFindings(found, candidates, allowed, problems);
          findings[song] = merged;
          const added = merged.candidates.filter((candidate) => !before.has(candidate.id));
          return text({ added: added.map((candidate) => candidateRow(merged, candidate)), problems });
        }),
      ),
      tool(
        "pick",
        "Record your shortlist for one song (replaces an earlier one). Each pick is a candidate id from get_candidates and a one-line reason.",
        {
          song: z.number().int(),
          picks: z.array(z.object({ candidateId: z.string(), reason: z.string().min(3).max(300) })).max(10),
          note: z.string().max(300).optional().describe("Why nothing or little was picked, if so"),
        },
        guarded(({ song, picks: chosen, note }) => {
          const found = songAt(song);
          const ids = new Set(found.candidates.map((candidate) => candidate.id));
          const unknown = chosen.filter((choice) => !ids.has(choice.candidateId)).map((choice) => choice.candidateId);
          if (unknown.length > 0) return failure(`These ids are not candidates of song ${String(song)}: ${unknown.join(", ")}. Use ids from get_candidates.`);
          picks.set(song, { picks: chosen.slice(0, options.picksPerSong), note: note ?? null });
          options.log(`  picked ${String(chosen.length)} for ${found.song.title}`);
          return text(`Recorded. ${String(findings.length - picks.size)} songs left.`);
        }),
      ),
    ],
  });

  const ownTools = ["list_songs", "get_candidates", "search_more", "pick"].map((name) => `mcp__remix__${name}`);
  const extraTools = Object.keys(options.extraMcpServers).map((name) => `mcp__${name}__*`);
  let summary = "";
  let costUsd = 0;
  let stoppedBecause: string | null = null;

  const run = query({
    prompt: `The playlist is "${playlistName}" with ${String(findings.length)} songs. Shortlist the variants of each one.`,
    options: {
      model: options.model,
      effort: options.effort,
      systemPrompt: systemPrompt(options),
      tools: [],
      mcpServers: { ...options.extraMcpServers, remix: server },
      allowedTools: [...ownTools, ...extraTools],
      permissionMode: "dontAsk",
      // Nothing from this machine's Claude Code setup: no settings, no other MCP servers, no
      // claude.ai connectors. Each of those adds its tools to every turn's context (and cost).
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      maxBudgetUsd: options.maxBudgetUsd,
      maxTurns: findings.length * 4 + 10,
    },
  });

  try {
    for await (const message of run) {
      if (message.type === "system" && message.subtype === "init") {
        options.log(`  agent tools: ${message.tools.join(", ")}`);
      } else if (message.type === "assistant") {
        for (const block of message.message.content) if (block.type === "text" && block.text.trim() !== "") options.log(`  agent: ${block.text.trim().split("\n")[0] ?? ""}`);
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd;
        for (const [model, usage] of Object.entries(message.modelUsage))
          options.log(`  ${model}: ${String(usage.inputTokens)} in, ${String(usage.cacheReadInputTokens)} cache read, ${String(usage.cacheCreationInputTokens)} cache write, ${String(usage.outputTokens)} out (${String(usage.thinkingTokens ?? "?")} thinking), $${usage.costUSD.toFixed(2)}; ${String(message.num_turns)} turns`);
        if (message.subtype === "success") summary = message.result;
        else stoppedBecause = message.subtype === "error_max_budget_usd" ? `the $${options.maxBudgetUsd.toFixed(2)} budget ran out (--budget raises it)` : message.subtype === "error_max_turns" ? "it ran out of turns" : `it failed (${message.subtype})`;
      }
    }
  } catch (error) {
    // The SDK also throws after an error result; the picks made so far are kept either way.
    stoppedBecause ??= error instanceof Error ? error.message : String(error);
  }
  return { findings, picks, summary, costUsd, stoppedBecause };
}
