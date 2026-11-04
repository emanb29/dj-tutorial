/**
 * Turning proposals into applied fields, the review decisions that steer it, and undoing it.
 *
 * - Per field, the surest proposal across steps wins; a rival value nearly as sure sends it to review.
 * - Only fields the collection has empty are filled. The high band applies by itself; medium only
 *   once accepted in the decision log. A rejected value is never proposed again.
 * - Every apply run returns its journal (one line per change, with the old value) for rollback.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ConfidenceBand } from "./name-parse.ts";
import { ENRICHED_FIELDS, baseHas, type AppliedField, type EnrichedField, type Proposal, type StoreItem } from "./store.ts";

const DecisionSchema = z.object({
  hash: z.string().min(1),
  field: z.enum(ENRICHED_FIELDS),
  value: z.string(),
  decision: z.enum(["accept", "reject", "unsure"]),
  at: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface DecisionLog {
  readonly decisions: readonly Decision[];
  /** Lines that are not a decision, each with its line number and what is wrong. */
  readonly problems: readonly string[];
}

/** The live decision log (JSONL, appended to by hand or from the review page). Missing = no decisions. */
export function readDecisions(path: string): DecisionLog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { decisions: [], problems: [] };
    throw error;
  }
  const decisions: Decision[] = [];
  const problems: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      problems.push(`line ${String(index + 1)}: not JSON. Each line is one {"hash","field","value","decision"} object.`);
      return;
    }
    const parsed = DecisionSchema.safeParse(json);
    if (parsed.success) decisions.push(parsed.data);
    else problems.push(`line ${String(index + 1)}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  });
  return { decisions, problems };
}

const decisionKey = (hash: string, field: EnrichedField, value: string) => `${hash}\u0000${field}\u0000${value}`;

/** The last decision on each (track, field, value). */
export function latestDecisions(decisions: readonly Decision[]): Map<string, Decision["decision"]> {
  return new Map(decisions.map((each) => [decisionKey(each.hash, each.field, each.value), each.decision]));
}

const RANK: Record<ConfidenceBand, number> = { high: 2, medium: 1, low: 0 };

/** The proposal a field resolves to for a track, or null; rejected values never come back. */
export function resolveField(item: StoreItem, field: EnrichedField, decisions: readonly Decision[] | ReadonlyMap<string, Decision["decision"]>): Proposal | null {
  const latest = decisions instanceof Map ? decisions : latestDecisions(decisions as readonly Decision[]);
  const candidates = Object.values(item.steps)
    .flatMap((step) => step.proposals)
    .filter((proposal) => proposal.field === field && latest.get(decisionKey(item.hash, field, proposal.value)) !== "reject")
    .toSorted((a, b) => RANK[b.band] - RANK[a.band]);
  const [best] = candidates;
  if (best === undefined) return null;
  const evidence = [...new Set(candidates.filter((each) => each.value === best.value).flatMap((each) => each.evidence))];
  const rival = candidates.find((each) => each.value.toLowerCase() !== best.value.toLowerCase());
  if (best.band === "high" && rival !== undefined && RANK[rival.band] >= RANK.medium) {
    return { ...best, band: "medium", rule: `${best.rule}+conflict`, evidence: [...evidence, `${rival.step} proposes "${rival.value}" (${rival.band}, ${rival.rule})`] };
  }
  return { ...best, evidence };
}

export interface JournalLine {
  readonly run: string;
  readonly hash: string;
  readonly field: EnrichedField;
  readonly old: AppliedField | null;
  readonly new: AppliedField | null;
}

export interface ApplyOptions {
  readonly run: string;
  /** The kinds of change approved for this run. */
  readonly fields: readonly EnrichedField[];
}

export function applyProposals(items: Record<string, StoreItem>, decisions: readonly Decision[], options: ApplyOptions): { readonly journal: readonly JournalLine[] } {
  const latest = latestDecisions(decisions);
  const journal: JournalLine[] = [];
  for (const item of Object.values(items)) {
    for (const field of options.fields) {
      if (baseHas(item.base, field)) continue;
      const proposal = resolveField(item, field, latest);
      if (proposal === null) continue;
      const accepted = proposal.band === "high" || latest.get(decisionKey(item.hash, field, proposal.value)) === "accept";
      const old = item.applied[field] ?? null;
      if (!accepted || old?.value === proposal.value) continue;
      const applied: AppliedField = { ...proposal, run: options.run };
      item.applied[field] = applied;
      journal.push({ run: options.run, hash: item.hash, field, old, new: applied });
    }
  }
  return { journal };
}

/** Undoes a run's journal, newest line first. A field changed since that run is left alone. */
export function rollback(items: Record<string, StoreItem>, journal: readonly JournalLine[]): { readonly reverted: number; readonly skipped: number } {
  let reverted = 0;
  let skipped = 0;
  for (const line of journal.toReversed()) {
    const item = items[line.hash];
    const current = item?.applied[line.field] ?? null;
    if (item === undefined || current?.value !== line.new?.value || current?.run !== line.new?.run) {
      skipped++;
      continue;
    }
    if (line.old === null) item.applied = Object.fromEntries(Object.entries(item.applied).filter(([field]) => field !== line.field));
    else item.applied[line.field] = line.old;
    reverted++;
  }
  return { reverted, skipped };
}
