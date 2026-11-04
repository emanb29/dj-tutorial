// Dev only, a dry run (ISS-198 step 1): parses every track's name in a rekordbox collection XML,
// and optionally the audio files in a folder, and writes what name parsing would fill to a JSON
// report. It reads only: it never writes to an audio file, a tag or rekordbox. The report names
// your tracks, so write it outside the repo (or under the gitignored .local/) and never commit it.
//
//   npx tsx --tsconfig tsconfig.node.json scripts/enrich-names.ts --xml COLLECTION.xml [--folder MUSIC] --out REPORT.json
//
// With --folder, audio files the collection does not list are parsed from their file names too.
// File tags are not read yet: only the collection's Artist column counts as an existing tag.

import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseRekordboxXml } from "../src/tracks/rekordbox/xml.ts";
import { buildEnrichReport, type EnrichTrack } from "./enrich-names-report.ts";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".alac"]);

function audioFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(entry.parentPath, entry.name));
}

const isInside = (path: string, folder: string) => {
  const from = relative(folder, path);
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
};

async function main() {
  const { values } = parseArgs({ options: { xml: { type: "string" }, folder: { type: "string" }, out: { type: "string" } } });
  const problems = [
    values.xml === undefined && values.folder === undefined ? "Give --xml (a rekordbox collection export) or --folder (or both)." : null,
    values.out === undefined ? "Give --out, the JSON report's path (outside the repo, or under .local/)." : null,
  ].filter((problem) => problem !== null);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(2);
  }
  const out = resolve(values.out ?? "");
  const folder = values.folder === undefined ? null : resolve(values.folder);
  const xml = values.xml === undefined ? null : resolve(values.xml);
  if ((folder !== null && isInside(out, folder)) || out === xml) {
    console.error("--out must not be inside --folder or be the collection itself: this is a dry run and writes nothing there.");
    process.exit(2);
  }

  const tracks: EnrichTrack[] = [];
  const listed = new Set<string>();
  if (xml !== null) {
    const parsed = await parseRekordboxXml(createReadStream(xml, { encoding: "utf8" }));
    if (!parsed.ok) {
      console.error(`${parsed.error.message} ${parsed.error.fix}`);
      process.exit(1);
    }
    for (const track of parsed.library.tracks) {
      const fileName = track.segments[track.segments.length - 1] ?? null;
      if (fileName !== null) listed.add(fileName.toLowerCase());
      tracks.push({ rawName: track.name, fileName, tags: { artist: track.artist } });
    }
    console.log(`Collection: ${String(parsed.library.tracks.length)} tracks (${String(parsed.library.skippedTracks)} skipped).`);
  }
  if (folder !== null) {
    const files = audioFiles(folder);
    const unlisted = files.filter((file) => !listed.has(basename(file).toLowerCase()));
    for (const file of unlisted) tracks.push({ rawName: basename(file, extname(file)), fileName: basename(file), tags: {} });
    console.log(`Folder: ${String(files.length)} audio files, ${String(unlisted.length)} not in the collection.`);
  }

  const report = buildEnrichReport(tracks, { sources: { xml, folder } });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const line = (name: string, counts: { existing: number; high: number; medium: number; low: number; total: number }) =>
    `${name.padEnd(10)} existing ${String(counts.existing).padStart(5)}  high ${String(counts.high).padStart(5)}  medium ${String(counts.medium).padStart(5)}  low ${String(counts.low).padStart(5)}  total ${String(counts.total).padStart(5)}`;
  console.log(`\n${String(report.trackCount)} tracks, parser v${String(report.parserVersion)} (dry run, nothing written but the report)`);
  for (const name of ["artist", "remixer", "mixKind", "featuring", "sourceId"] as const) console.log(line(name, report.fields[name].after));
  console.log(`title      ${String(report.fields.title.changed)} would change (high ${String(report.fields.title.changedByBand.high)}, medium ${String(report.fields.title.changedByBand.medium)}, low ${String(report.fields.title.changedByBand.low)})`);
  const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const calibration = report.calibration;
  console.log(`\nCalibration on ${String(calibration.tracksWithArtistTag)} tracks with an artist tag (${String(calibration.noProposal)} got no proposal):`);
  for (const band of ["high", "medium", "low"] as const) {
    const bucket = calibration.bands[band];
    console.log(
      `  ${band.padEnd(6)} ${String(bucket.proposed).padStart(5)} proposed: agree ${String(bucket.agree)}, partial ${String(bucket.partial)}, disagree ${String(bucket.disagree)}, tag is the remixer ${String(bucket.tagIsRemixer)}, tag not in the name ${String(bucket.tagNotInName)}`,
    );
    console.log(`         precision ${percent(bucket.precision)} (with partial ${percent(bucket.lenientPrecision)}); where the name can tell, ${percent(bucket.comparablePrecision)}`);
  }
  console.log(`\nReport: ${out}`);
}

await main();
