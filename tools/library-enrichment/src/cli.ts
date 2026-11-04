// The library enrichment tool. Personal tooling, not part of the app: see ../README.md.
//
//   npm run enrich -- run --xml COLLECTION.xml --data DIR [--path-map E:/=/mnt/e/] [--soundcloud [--sample N | --limit N]]
//   npm run enrich -- report --data DIR --out DIR
//   npm run enrich -- apply --data DIR [--fields artist,originalArtist,remixer,mix,genre,year]
//   npm run enrich -- rollback --data DIR (--run ID | --last)
//   npm run enrich -- export-xml --xml COLLECTION.xml --data DIR --out ENRICHED.xml [--path-map E:/=/mnt/e/]
//
// It only reads the collection and the audio files; everything it writes goes under --data and --out.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { applyProposals, readDecisions, resolveField, rollback, type JournalLine } from "./apply.ts";
import { buildEnrichReport, type EnrichTrack } from "./calibration.ts";
import { contentHashOfFile } from "./content-hash.ts";
import { projectEdits } from "./export.ts";
import { parsePathMap, readCollection, writeEnriched, type CollectionTrack, type PathMapping } from "./rekordbox-xml.ts";
import { reviewCards, reviewHtml } from "./review.ts";
import { lookupAll, soundCloudCache, ytDlpFetcher } from "./soundcloud.ts";
import { runNamesStep, runSoundCloudStep, scanCollection, sourceIdOf, type FileProbe } from "./steps.ts";
import { ENRICHED_FIELDS, baseHas, loadStore, saveStore, writeAtomically, type EnrichedField, type Store, type StoreItem } from "./store.ts";

const DEFAULT_APPLY_FIELDS: readonly EnrichedField[] = ["artist", "originalArtist", "remixer", "mix", "genre", "genreRaw", "year"];
const REVIEW_FIELDS: readonly EnrichedField[] = ["artist", "originalArtist", "remixer", "mix", "genre", "year"];

const OPTIONS = {
  xml: { type: "string" },
  data: { type: "string" },
  out: { type: "string" },
  "path-map": { type: "string", multiple: true },
  soundcloud: { type: "boolean" },
  sample: { type: "string" },
  limit: { type: "string" },
  "yt-dlp": { type: "string" },
  decisions: { type: "string" },
  fields: { type: "string" },
  run: { type: "string" },
  last: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function fail(problems: readonly string[]): never {
  console.error(problems.join("\n"));
  process.exit(2);
}

function need(values: Values, ...names: ("xml" | "data" | "out")[]): void {
  const missing = names.filter((name) => values[name] === undefined).map((name) => `Give --${name}.`);
  if (missing.length > 0) fail(missing);
}

const realProbe: FileProbe = {
  stat: (path) => {
    try {
      const stat = statSync(path);
      return Promise.resolve(stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null);
    } catch {
      return Promise.resolve(null);
    }
  },
  hash: async (path) => (await contentHashOfFile(path)).hash,
};

function readTracks(xmlPath: string): readonly CollectionTrack[] {
  const read = readCollection(readFileSync(xmlPath, "utf8"));
  if (!read.ok) fail([read.error]);
  return read.tracks;
}

/** Outputs never go where the library or the collection is. */
function guardOutput(output: string, xml: string | undefined, store: Store): void {
  const target = resolve(output);
  const problems = [
    xml !== undefined && resolve(xml) === target ? `${output} is the collection itself: give an output path of its own.` : null,
    Object.values(store.items).some((item) => item.paths.some((path) => path.startsWith(target + sep) || path === target))
      ? `${output} is inside the music library: write outside it.`
      : null,
  ].filter((problem) => problem !== null);
  if (problems.length > 0) fail(problems);
}

const decisionsPath = (values: Values, dataDir: string) => values.decisions ?? join(dataDir, "decisions.jsonl");

function loadDecisions(values: Values, dataDir: string) {
  const log = readDecisions(decisionsPath(values, dataDir));
  for (const problem of log.problems) console.warn(`decisions: ${problem}`);
  return log.decisions;
}

/** Evenly spread picks, so a sample spans the library rather than its first rows. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, index) => items[Math.floor((index * items.length) / count)] as T);
}

function positiveInteger(name: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail([`--${name} must be a whole number above 0, not "${value}".`]);
  return number;
}

// --- Commands -------------------------------------------------------------------------------------

async function run(values: Values, mappings: readonly PathMapping[]) {
  need(values, "xml", "data");
  const dataDir = resolve(values.data ?? "");
  const store = loadStore(dataDir);
  const tracks = readTracks(values.xml ?? "");
  const { summary } = await scanCollection(tracks, mappings, store, realProbe);
  guardOutput(dataDir, values.xml, store);
  console.log(`Collection: ${String(summary.tracks)} tracks, ${String(summary.items)} files in the store (${String(summary.missing)} not found on disk, ${String(summary.notAFile)} not files; ${String(summary.hashed)} hashed, ${String(summary.hashReused)} unchanged).`);

  const now = new Date();
  const items = Object.values(store.items);
  const ranNames = items.filter((item) => runNamesStep(item, now)).length;
  console.log(`Step 1 (names): ran on ${String(ranNames)} new or changed tracks.`);

  if (values.soundcloud === true) {
    const sample = positiveInteger("sample", values.sample);
    const limit = positiveInteger("limit", values.limit);
    const ids = [...new Set(items.map(sourceIdOf).filter((id) => id !== null))].toSorted();
    const chosen = sample !== null ? spread(ids, sample) : limit !== null ? ids.slice(0, limit) : ids;
    const cache = soundCloudCache(join(dataDir, "soundcloud-cache"));
    console.log(`Step 2 (SoundCloud): ${String(chosen.length)} of ${String(ids.length)} IDs; at most 1 request a second.`);
    const looked = await lookupAll(chosen, {
      cache,
      fetcher: ytDlpFetcher({ binary: values["yt-dlp"] ?? "yt-dlp", sleepRequestsSec: 1 }),
      batchSize: 25,
      pauseMs: 1000,
      now: () => new Date(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      onBatch: (done, total) => {
        console.log(`  looked up ${String(done)} / ${String(total)}`);
      },
    });
    const ranSoundCloud = items.filter((item) => runSoundCloudStep(item, cache, now)).length;
    console.log(`  ${String(looked.fetched)} looked up, ${String(looked.fromCache)} from the cache; step 2 ran on ${String(ranSoundCloud)} tracks.${looked.stoppedByRateLimit ? " Stopped early: SoundCloud is rate limiting. Run again later; the cache keeps what was found." : ""}`);
  }
  saveStore(dataDir, store);
  console.log(`Store: ${join(dataDir, "store.json")} (a dry run: nothing applied; see "report").`);
}

function fillCounts(items: readonly StoreItem[], decisions: ReturnType<typeof loadDecisions>) {
  return Object.fromEntries(
    ENRICHED_FIELDS.map((field) => {
      const counts = { alreadySet: 0, high: 0, medium: 0, low: 0, none: 0 };
      for (const item of items) {
        if (baseHas(item.base, field)) {
          counts.alreadySet++;
          continue;
        }
        const proposal = resolveField(item, field, decisions);
        counts[proposal?.band ?? "none"]++;
      }
      return [field, counts];
    }),
  );
}

function report(values: Values) {
  need(values, "data", "out");
  const dataDir = resolve(values.data ?? "");
  const outDir = resolve(values.out ?? "");
  const store = loadStore(dataDir);
  guardOutput(outDir, values.xml, store);
  const decisions = loadDecisions(values, dataDir);
  const items = Object.values(store.items);

  const tracks: EnrichTrack[] = items.map((item) => ({ rawName: item.base.name, fileName: item.base.fileName, tags: { artist: item.base.artist } }));
  const names = buildEnrichReport(tracks, { sources: { xml: values.xml ?? null, folder: null } });
  writeAtomically(join(outDir, "names-report.json"), `${JSON.stringify(names, null, 2)}\n`);

  const looked = items.filter((item) => item.steps.soundcloud !== undefined);
  const lookups = { ok: 0, "not-found": 0, error: 0 };
  for (const item of looked) lookups[item.steps.soundcloud?.lookup ?? "error"]++;
  const rawGenres = new Map<string, number>();
  for (const item of looked) {
    const raw = item.steps.soundcloud?.proposals.find((proposal) => proposal.field === "genreRaw")?.value ?? "(none)";
    rawGenres.set(raw, (rawGenres.get(raw) ?? 0) + 1);
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    items: items.length,
    fill: fillCounts(items, decisions),
    soundcloud: {
      lookedUp: looked.length,
      lookups,
      genreProposals: {
        high: looked.filter((item) => item.steps.soundcloud?.proposals.some((proposal) => proposal.field === "genre" && proposal.band === "high")).length,
        medium: looked.filter((item) => item.steps.soundcloud?.proposals.some((proposal) => proposal.field === "genre" && proposal.band === "medium")).length,
      },
      rawGenres: Object.fromEntries([...rawGenres.entries()].toSorted((a, b) => b[1] - a[1])),
    },
  };
  writeAtomically(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const cards = reviewCards(items, decisions, REVIEW_FIELDS);
  writeAtomically(join(outDir, "review.html"), reviewHtml(cards, summary.generatedAt));

  const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  console.log(`${String(items.length)} files. Per field (empty in the collection): high / medium / low / no proposal; already set`);
  for (const [field, counts] of Object.entries(summary.fill)) {
    console.log(`  ${field.padEnd(15)} ${String(counts.high).padStart(5)} / ${String(counts.medium).padStart(5)} / ${String(counts.low).padStart(5)} / ${String(counts.none).padStart(5)}; ${String(counts.alreadySet)}`);
  }
  const calibration = names.calibration;
  console.log(`Calibration (step 1) on ${String(calibration.tracksWithArtistTag)} hand-set artists, ${String(calibration.noProposal)} with no proposal:`);
  for (const band of ["high", "medium", "low"] as const) {
    const bucket = calibration.bands[band];
    console.log(
      `  ${band.padEnd(6)} ${String(bucket.proposed).padStart(4)}: agree ${String(bucket.agree)}, partial ${String(bucket.partial)}, disagree ${String(bucket.disagree)}, tag is the original artist ${String(bucket.tagIsOriginalArtist)}, tag not in the name ${String(bucket.tagNotInName)}; precision where the name can tell ${percent(bucket.comparablePrecision)}`,
    );
  }
  if (looked.length > 0) console.log(`Step 2: ${String(looked.length)} looked up: ${JSON.stringify(lookups)}; genre high ${String(summary.soundcloud.genreProposals.high)}, medium ${String(summary.soundcloud.genreProposals.medium)}.`);
  console.log(`Review: ${String(cards.length)} medium proposals in ${join(outDir, "review.html")}; decisions go in ${decisionsPath(values, dataDir)}.`);
}

function apply(values: Values) {
  need(values, "data");
  const dataDir = resolve(values.data ?? "");
  const store = loadStore(dataDir);
  const fields = values.fields === undefined ? DEFAULT_APPLY_FIELDS : values.fields.split(",").map((field) => field.trim());
  const unknown = fields.filter((field) => !(ENRICHED_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0) fail([`Unknown --fields ${unknown.join(", ")}: pick from ${ENRICHED_FIELDS.join(", ")}.`]);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const { journal } = applyProposals(store.items, loadDecisions(values, dataDir), { run: runId, fields: fields as EnrichedField[] });
  // The journal first: a crash after it leaves a journal for changes never saved, which rollback skips.
  writeAtomically(join(dataDir, "journal", `${runId}.jsonl`), journal.map((line) => JSON.stringify(line)).join("\n") + (journal.length > 0 ? "\n" : ""));
  saveStore(dataDir, store);
  const perField = new Map<string, number>();
  for (const line of journal) perField.set(line.field, (perField.get(line.field) ?? 0) + 1);
  console.log(`Applied ${String(journal.length)} fields (run ${runId}): ${[...perField].map(([field, count]) => `${field} ${String(count)}`).join(", ") || "nothing new"}.`);
  console.log(`Undo with: rollback --data ${values.data ?? ""} --run ${runId}`);
}

function undo(values: Values) {
  need(values, "data");
  const dataDir = resolve(values.data ?? "");
  const journals = join(dataDir, "journal");
  let runId = values.run;
  if (values.last === true) runId = readdirSync(journals).filter((name) => name.endsWith(".jsonl")).toSorted().at(-1)?.replace(/\.jsonl$/, "");
  if (runId === undefined) fail(["Give --run ID (the apply run's ID) or --last."]);
  const lines = readFileSync(join(journals, `${runId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalLine);
  const store = loadStore(dataDir);
  const result = rollback(store.items, lines);
  saveStore(dataDir, store);
  console.log(`Rolled back run ${runId}: ${String(result.reverted)} fields reverted, ${String(result.skipped)} skipped (changed since).`);
}

async function exportXml(values: Values, mappings: readonly PathMapping[]) {
  need(values, "xml", "data", "out");
  const dataDir = resolve(values.data ?? "");
  const store = loadStore(dataDir);
  guardOutput(values.out ?? "", values.xml, store);
  const xml = readFileSync(values.xml ?? "", "utf8");
  const read = readCollection(xml);
  if (!read.ok) fail([read.error]);
  // Hashes come from the store's file cache; only changed files are hashed again.
  const { hashByTrackId } = await scanCollection(read.tracks, mappings, store, realProbe);
  const { edits, counts } = projectEdits(read.tracks, hashByTrackId, store.items);
  writeAtomically(resolve(values.out ?? ""), writeEnriched(xml, edits));
  console.log(`Wrote ${values.out ?? ""}: ${String(edits.size)} of ${String(read.tracks.length)} tracks enriched (${Object.entries(counts).map(([attribute, count]) => `${attribute} ${String(count)}`).join(", ")}). The original is unchanged.`);
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const mappings = parsePathMap(values["path-map"] ?? []);
  switch (positionals[0]) {
    case "run":
      await run(values, mappings);
      return;
    case "report":
      report(values);
      return;
    case "apply":
      apply(values);
      return;
    case "rollback":
      undo(values);
      return;
    case "export-xml":
      await exportXml(values, mappings);
      return;
    default:
      fail([`Give a command: run, report, apply, rollback or export-xml (got "${positionals[0] ?? ""}"). See the top of src/cli.ts.`]);
  }
}

await main();
