// The dry-run report of name parsing (step 1): what parseTrackName would fill, per field and band,
// which rules did it, sample diffs, and how often the parsed artist agrees with an artist tag the
// track already has (calibration). Pure: the CLI reads the library and writes the JSON. The report
// names real tracks, so it belongs outside the repo.
import { NAME_PARSER_VERSION, parseTrackName, type ConfidenceBand, type ExistingTags, type NameFlag, type NameParse, type ProposedField } from "./name-parse.ts";

export interface EnrichTrack {
  readonly rawName: string;
  readonly fileName: string | null;
  readonly tags: ExistingTags;
}

const BANDS: readonly ConfidenceBand[] = ["high", "medium", "low"];
type ProposedFieldName = "artist" | "originalArtist" | "remixer" | "mixKind" | "featuring" | "sourceId";

export interface BandCounts {
  /** Kept from a tag the track already had. */
  readonly existing: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly total: number;
}

/**
 * An artist tag is not ground truth: on downloaded tracks it is often the uploader (a label, a
 * promo channel), and on a remix it may name the original artist where the parser, by the
 * remixer-is-artist rule, names the remixer. A tag naming the remixer agrees. Counted apart:
 * `tagIsOriginalArtist` (the tag names the parsed original artist: the other convention, not an
 * error) and `tagNotInName` (no name in the tag appears in the raw or file name, so the name
 * cannot confirm or refute it). `comparablePrecision` leaves both out.
 */
export interface CalibrationBand {
  readonly proposed: number;
  readonly agree: number;
  readonly partial: number;
  readonly disagree: number;
  readonly tagIsOriginalArtist: number;
  readonly tagNotInName: number;
  /** agree / proposed; null with nothing proposed. */
  readonly precision: number | null;
  /** (agree + partial) / proposed. */
  readonly lenientPrecision: number | null;
  /** agree / (agree + partial + disagree): only tracks whose name can say who the artist is. */
  readonly comparablePrecision: number | null;
}

type Verdict = "agree" | "partial" | "disagree" | "tagIsOriginalArtist" | "tagNotInName";

export interface SampleDiff {
  /** The lowest band among the fields this track's parse proposes. */
  readonly band: ConfidenceBand;
  readonly rawName: string;
  readonly fileName: string | null;
  readonly before: { readonly artist: string | null; readonly title: string };
  readonly after: {
    readonly artist: ProposedField<string> | null;
    readonly originalArtist: ProposedField<string> | null;
    readonly title: string;
    readonly remixer: ProposedField<string> | null;
    readonly mixKind: string | null;
    readonly featuring: string | null;
    readonly flags: readonly NameFlag[];
    readonly sourceId: string | null;
  };
  readonly removed: readonly string[];
}

export interface EnrichReport {
  readonly dryRun: true;
  readonly parserVersion: number;
  readonly sources: { readonly xml: string | null; readonly folder: string | null };
  readonly trackCount: number;
  readonly fields: Record<ProposedFieldName, { readonly before: number; readonly after: BandCounts }> & {
    readonly title: { readonly before: number; readonly after: BandCounts; readonly changed: number; readonly changedByBand: Record<ConfidenceBand, number> };
  };
  readonly flags: Record<NameFlag, number>;
  readonly removedByRule: Record<string, number>;
  readonly topRules: readonly { readonly rule: string; readonly count: number }[];
  readonly calibration: {
    readonly tracksWithArtistTag: number;
    /** Tagged tracks where the parser (tags hidden) proposed no artist. */
    readonly noProposal: number;
    readonly bands: Record<ConfidenceBand, CalibrationBand>;
    /** Up to 25 disagreements, to see what goes wrong. */
    readonly disagreements: readonly { readonly rawName: string; readonly fileName: string | null; readonly tag: string; readonly parsed: string; readonly band: ConfidenceBand; readonly rule: string; readonly verdict: Verdict }[];
  };
  readonly samples: readonly SampleDiff[];
}

export interface ReportOptions {
  readonly sources: { readonly xml: string | null; readonly folder: string | null };
  readonly sampleSize?: number;
  readonly topRuleCount?: number;
}

// --- Artist agreement -----------------------------------------------------------------------------

const comparableText = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** One artist credit as a set of names: "A & B", "B, A", "A x B" and "A and B" are the same. */
function artistNames(credit: string): Set<string> {
  return new Set(
    credit
      .normalize("NFKC")
      .toLowerCase()
      .split(/\s*(?:,|&|\+|\/|;|\bx\b|\band\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/)
      .map((name) => name.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter((name) => name !== ""),
  );
}

export function artistAgreement(parsed: string, tagged: string): "agree" | "partial" | "disagree" {
  const a = artistNames(parsed);
  const b = artistNames(tagged);
  const shared = [...a].filter((name) => b.has(name)).length;
  if (shared > 0 && shared === a.size && shared === b.size) return "agree";
  return shared > 0 ? "partial" : "disagree";
}

export interface ParsedCredits {
  readonly artist: string;
  readonly originalArtist: string | null;
  readonly featuring: string | null;
  readonly remixer: string | null;
}

/**
 * The parsed credits against an artist tag. Tags often list everyone ("A feat. B", "A, Remixer"),
 * so it agrees when every parsed artist is in the tag and every name in the tag is a parsed
 * artist, original artist, featured artist or remixer.
 */
export function creditsAgreement(credits: ParsedCredits, tagged: string): "agree" | "partial" | "disagree" {
  const artists = artistNames(credits.artist);
  const everyone = new Set([...artists, ...artistNames(credits.originalArtist ?? ""), ...artistNames(credits.featuring ?? ""), ...artistNames(credits.remixer ?? "")]);
  const tag = artistNames(tagged);
  const artistsInTag = [...artists].filter((name) => tag.has(name)).length;
  if (artistsInTag === 0) return "disagree";
  return artistsInTag === artists.size && [...tag].every((name) => everyone.has(name)) ? "agree" : "partial";
}

// --- The report -----------------------------------------------------------------------------------

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const lowest = (bands: readonly ConfidenceBand[]): ConfidenceBand => (bands.includes("low") ? "low" : bands.includes("medium") ? "medium" : "high");

function bandCounts(fields: readonly (ProposedField<unknown> | null)[]): BandCounts {
  const present = fields.filter((value) => value !== null);
  const parsed = present.filter((value) => value.source !== "tag");
  return {
    existing: present.length - parsed.length,
    high: parsed.filter((value) => value.band === "high").length,
    medium: parsed.filter((value) => value.band === "medium").length,
    low: parsed.filter((value) => value.band === "low").length,
    total: present.length,
  };
}

const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

function sampleOf(track: EnrichTrack, result: NameParse): SampleDiff {
  const parsedBands = [result.artist, result.originalArtist, result.title, result.remixer, result.featuring, result.sourceId]
    .filter((value) => value !== null && value.source !== "tag")
    .map((value) => value?.band ?? "high");
  return {
    band: lowest(parsedBands),
    rawName: track.rawName,
    fileName: track.fileName,
    before: { artist: track.tags.artist?.trim() === "" ? null : (track.tags.artist ?? null), title: track.rawName },
    after: {
      artist: result.artist,
      originalArtist: result.originalArtist,
      title: result.title.value,
      remixer: result.remixer,
      mixKind: result.mixKind?.value ?? null,
      featuring: result.featuring?.value ?? null,
      flags: result.flags.map((flag) => flag.flag),
      sourceId: result.sourceId?.value ?? null,
    },
    removed: result.removed.map((removed) => `${removed.rule}: ${removed.text}`),
  };
}

/** Evenly spaced picks, so a sample spans a bucket rather than its first rows. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, index) => items[Math.floor((index * items.length) / count)] as T);
}

export function buildEnrichReport(tracks: readonly EnrichTrack[], options: ReportOptions): EnrichReport {
  const sampleSize = options.sampleSize ?? 40;
  const topRuleCount = options.topRuleCount ?? 30;
  const parsed = tracks.map((track) => ({ track, result: parseTrackName({ rawName: track.rawName, fileName: track.fileName, tags: track.tags }) }));
  const results = parsed.map(({ result }) => result);

  const ruleCounts = new Map<string, number>();
  const count = (rule: string) => ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
  const removedByRule: Record<string, number> = {};
  const flags: Record<NameFlag, number> = { "free-download": 0, premiere: 0, preview: 0, "streaming-quality": 0, "official-video": 0 };
  for (const result of results) {
    for (const value of [result.artist, result.originalArtist, result.title, result.remixer, result.mixKind, result.featuring, result.sourceId]) if (value !== null) count(value.rule);
    for (const flag of result.flags) flags[flag.flag]++;
    for (const removed of result.removed) removedByRule[removed.rule] = (removedByRule[removed.rule] ?? 0) + 1;
  }

  const hasTag = (value: string | undefined) => (value?.trim() ?? "") !== "";
  const changed = results.map((result, index) => normalized(result.title.value) !== normalized(tracks[index]?.rawName ?? ""));
  const changedByBand = Object.fromEntries(BANDS.map((band) => [band, results.filter((result, index) => changed[index] === true && result.title.band === band).length])) as Record<ConfidenceBand, number>;
  const field = (name: ProposedFieldName) => ({
    before: name === "artist" ? tracks.filter((track) => hasTag(track.tags.artist)).length : name === "remixer" ? tracks.filter((track) => hasTag(track.tags.remixer)).length : 0,
    after: bandCounts(results.map((result) => result[name])),
  });

  // Calibration: the same parse with the artist tag hidden, against that tag.
  const tagged = tracks.filter((track) => hasTag(track.tags.artist));
  const tally = Object.fromEntries(BANDS.map((band) => [band, { proposed: 0, agree: 0, partial: 0, disagree: 0, tagIsOriginalArtist: 0, tagNotInName: 0 }])) as Record<
    ConfidenceBand,
    Record<"proposed" | Verdict, number>
  >;
  const disagreements: EnrichReport["calibration"]["disagreements"][number][] = [];
  const shownPerBand: Record<ConfidenceBand, number> = { high: 0, medium: 0, low: 0 };
  let noProposal = 0;
  for (const track of tagged) {
    const tag = track.tags.artist?.trim() ?? "";
    const blind = parseTrackName({ rawName: track.rawName, fileName: track.fileName, tags: { ...track.tags, artist: "" } });
    if (blind.artist === null) {
      noProposal++;
      continue;
    }
    const agreement = creditsAgreement(
      { artist: blind.artist.value, originalArtist: blind.originalArtist?.value ?? null, featuring: blind.featuring?.value ?? null, remixer: blind.remixer?.value ?? null },
      tag,
    );
    const inName = comparableText(`${track.rawName} ${track.fileName ?? ""}`);
    const verdict: Verdict =
      agreement !== "disagree"
        ? agreement
        : blind.originalArtist !== null && artistAgreement(blind.originalArtist.value, tag) !== "disagree"
          ? "tagIsOriginalArtist"
          : [...artistNames(tag)].some((name) => inName.includes(name))
            ? "disagree"
            : "tagNotInName";
    const bucket = tally[blind.artist.band];
    bucket.proposed++;
    bucket[verdict]++;
    if (verdict === "disagree" && shownPerBand[blind.artist.band] < 15) {
      shownPerBand[blind.artist.band]++;
      disagreements.push({ rawName: track.rawName, fileName: track.fileName, tag, parsed: blind.artist.value, band: blind.artist.band, rule: blind.artist.rule, verdict });
    }
  }
  const bands = Object.fromEntries(
    BANDS.map((band) => {
      const bucket = tally[band];
      return [
        band,
        {
          ...bucket,
          precision: ratio(bucket.agree, bucket.proposed),
          lenientPrecision: ratio(bucket.agree + bucket.partial, bucket.proposed),
          comparablePrecision: ratio(bucket.agree, bucket.agree + bucket.partial + bucket.disagree),
        },
      ];
    }),
  ) as Record<ConfidenceBand, CalibrationBand>;

  // Samples: tracks whose parse changes something, spread across bands.
  const candidates = parsed
    .map(({ result, track }, index) => ({ result, track, changed: changed[index] === true }))
    .filter(({ result, changed: titleChanged }) => titleChanged || (result.artist !== null && result.artist.source !== "tag"))
    .map(({ result, track }) => sampleOf(track, result));
  const perBand = Math.ceil(sampleSize / BANDS.length);
  const picked = BANDS.flatMap((band) => spread(candidates.filter((sample) => sample.band === band), perBand));
  const fill = spread(candidates.filter((sample) => !picked.includes(sample)), Math.max(0, sampleSize - picked.length));
  const samples = [...picked, ...fill].slice(0, sampleSize);

  return {
    dryRun: true,
    parserVersion: NAME_PARSER_VERSION,
    sources: options.sources,
    trackCount: tracks.length,
    fields: {
      artist: field("artist"),
      originalArtist: field("originalArtist"),
      remixer: field("remixer"),
      mixKind: field("mixKind"),
      featuring: field("featuring"),
      sourceId: field("sourceId"),
      title: {
        before: changed.filter((value) => !value).length,
        after: bandCounts(results.map((result) => result.title)),
        changed: changed.filter(Boolean).length,
        changedByBand,
      },
    },
    flags,
    removedByRule,
    topRules: [...ruleCounts.entries()]
      .map(([rule, uses]) => ({ rule, count: uses }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
      .slice(0, topRuleCount),
    calibration: { tracksWithArtistTag: tagged.length, noProposal, bands, disagreements },
    samples,
  };
}
