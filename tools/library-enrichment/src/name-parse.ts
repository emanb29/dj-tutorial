/**
 * Step 1 of library enrichment: a track's name, offline.
 *
 * Turns a track's raw name (rekordbox's Name, or a file name), plus its file name and any tags it
 * already has, into proposed fields: artist, original artist, a clean title, the remixer and mix kind, featuring,
 * flags (free download, premiere, preview, streaming quality, official video) and the SoundCloud ID
 * from a trailing "[digits]". Pure and deterministic; it never reads or writes a file.
 *
 * Rules:
 * - Remix, edit, VIP, bootleg and flip tokens carry identity: they become fields AND stay in the
 *   clean title, as DJs write it: "Title (X Remix)".
 * - Only junk leaves the clean title: free download, premiere, preview, streaming quality, the ID,
 *   "Official Video", version tags such as "(MASTER3)", catalogue numbers, "OUT NOW". Each removal
 *   is listed with its rule.
 * - A remix, edit, bootleg, flip, VIP, re-work or mashup by X is X's track: artist = X, and the
 *   artist the name credits first is the original artist. That is how most SoundCloud DJs credit
 *   their edits. "(Original Mix)", "(Extended Mix)" and "(X Mix)" name no one new.
 * - An existing tag beats a parsed value, always; the parser never overwrites one.
 * - "A - B" is "Artist - Title" unless the sides say otherwise; an ambiguous split is medium or low.
 * - Every proposed field carries a confidence band and the rule that produced it.
 *
 * Bump NAME_PARSER_VERSION whenever a change can alter any output, so a stored result made by an
 * older version is re-run.
 */

export const NAME_PARSER_VERSION = 5;

export type ConfidenceBand = "high" | "medium" | "low";
/** Where a value came from: a tag the track already had, the raw name, or the file name. */
export type FieldSource = "tag" | "name" | "file-name";
export type MixKind = "remix" | "edit" | "vip" | "bootleg" | "flip" | "rework" | "extended" | "original" | "mashup" | "mix";
export type NameFlag = "free-download" | "premiere" | "preview" | "streaming-quality" | "official-video";

export interface ProposedField<T> {
  readonly value: T;
  readonly band: ConfidenceBand;
  readonly rule: string;
  readonly source: FieldSource;
}

export interface MixToken {
  readonly kind: MixKind;
  /** Who made it; null when the token names no one ("Trance Remix", "VIP", "Original Mix"). */
  readonly remixer: string | null;
  /** The token as written, without brackets. */
  readonly text: string;
  readonly band: ConfidenceBand;
  readonly rule: string;
}

export interface FlagField {
  readonly flag: NameFlag;
  readonly band: ConfidenceBand;
  readonly rule: string;
}

export interface RemovedText {
  readonly text: string;
  readonly rule: string;
}

export interface ExistingTags {
  readonly artist?: string;
  readonly title?: string;
  readonly remixer?: string;
}

export interface NameParseInput {
  /** The name as the library shows it (rekordbox's Name). Kept exactly. */
  readonly rawName: string;
  /** The file's name, with its extension; used for what the raw name lacks. */
  readonly fileName?: string | null;
  readonly tags?: ExistingTags;
}

export interface NameParse {
  readonly version: number;
  readonly raw: { readonly name: string; readonly fileName: string | null };
  /** Who the track is by: the remixer of a remix (and edit, bootleg…), else the credited artist. */
  readonly artist: ProposedField<string> | null;
  /** The artist the name credits, when the track is someone else's remix of it; null otherwise. */
  readonly originalArtist: ProposedField<string> | null;
  /** The clean title: the raw name without the artist and the junk. "" only when there is no name at all. */
  readonly title: ProposedField<string>;
  /** The last (outermost) mix token's maker: "(X Remix) (Y Edit)" is Y's edit of X's remix. */
  readonly remixer: ProposedField<string> | null;
  readonly mixKind: ProposedField<MixKind> | null;
  /** Every mix token in the clean title, in order. */
  readonly mixes: readonly MixToken[];
  readonly featuring: ProposedField<string> | null;
  readonly flags: readonly FlagField[];
  /** The SoundCloud track ID. */
  readonly sourceId: ProposedField<string> | null;
  /** What was taken out of the raw name, in order. */
  readonly removed: readonly RemovedText[];
}

// --- Vocabulary -----------------------------------------------------------------------------------

/** Never an artist, whatever the position says. Compared lowercased, without dots. */
const ARTIST_DENY_LIST = new Set([
  "unknown", "unknown artist", "various", "various artists", "va", "free", "free dl", "free download", "artist", "artists",
  "track", "untitled", "audio", "official", "premiere", "na", "n/a", "none", "null", "undefined", "new", "remix", "bootleg",
  "edit", "vip", "mix", "flip", "intro", "outro", "id", "tba", "tbc", "out now", "dj", "mc", "soundcloud", "youtube", "promo",
]);
const MIN_ARTIST_CHARS = 2;
const MAX_ARTIST_WORDS = 8;
const MAX_ARTIST_CHARS = 60;
const MAX_REMIXER_WORDS = 6;

/** Words that describe a mix's style, not who made it: "(X Techno Remix)" is X's. Compared lowercased. */
const STYLE_WORDS = new Set([
  "techno", "hardtechno", "hard", "trance", "psytrance", "psy", "dubstep", "riddim", "hardstyle", "rawstyle", "house", "tech",
  "deep", "bass", "dnb", "d&b", "jungle", "garage", "ukg", "uk", "hardcore", "club", "mainstage", "festival", "euphoric",
  "schranz", "rave", "vocal", "dub", "instrumental", "radio", "extended", "short", "long", "acoustic", "trap", "phonk",
  "hyperpop", "jersey", "bounce", "edm", "drum", "and", "&", "official", "unofficial", "dance", "future", "melodic", "big",
  "room", "bigroom", "harddance", "frenchcore", "gabber", "tekno", "amapiano", "afro", "latin", "moombahton", "breaks",
  "breakbeat", "liquid", "neuro", "midtempo", "drill", "groove", "minimal", "progressive", "electro", "disco", "nu",
  "speed", "sped", "slowed", "hypertechno", "hardrave", "hardgroove", "private", "vip", "-",
]);
const YEAR = /^(?:19|20)\d\d$/;
const isStyleWord = (word: string) => STYLE_WORDS.has(word.toLowerCase()) || YEAR.test(word);

/** The last of these in a group decides its kind. Longest first, so "original mix" beats "mix". */
const MIX_KEYWORD = /\b(original\s+mix|extended\s+mix|extended|re-?work|re-?edit|re-?mix|rmx|bootleg|re-?flip|flip|vip|edit|mash-?up|refix|redo|mix)\b/gi;

function mixKindOf(keyword: string): MixKind {
  const word = keyword.toLowerCase().replace(/[\s-]+/g, "");
  if (word === "originalmix") return "original";
  if (word.startsWith("extended")) return "extended";
  if (word === "rework" || word === "refix" || word === "redo") return "rework";
  if (word === "reflip") return "flip";
  if (word === "reedit" || word === "edit") return "edit";
  if (word === "remix" || word === "rmx") return "remix";
  if (word === "mashup") return "mashup";
  if (word === "bootleg" || word === "flip" || word === "vip") return word;
  return "mix";
}

/** Mix kinds whose maker is the track's artist. */
const CREDITED_KINDS: ReadonlySet<MixKind> = new Set(["remix", "edit", "vip", "bootleg", "flip", "rework", "mashup"]);

// --- Junk -----------------------------------------------------------------------------------------

interface JunkRule {
  readonly rule: string;
  readonly flag?: NameFlag;
  /** Removed wherever it appears (in a group or loose in the name). Global. */
  readonly pattern: RegExp;
}

/** Junk that is junk anywhere: in a group, or loose. */
const LOOSE_JUNK: readonly JunkRule[] = [
  { rule: "free-download", flag: "free-download", pattern: /\**\s*(?:buy\s*(?:=|for)\s*)?free\s*(?:download|dl|d\/l)\b(?:\s*(?:=|for)\s*buy\b)?\s*\**/gi },
  { rule: "streaming-quality", flag: "streaming-quality", pattern: /\b(?:streaming|low)\s+quality\b|\bstreaming\s+version\b/gi },
  { rule: "official-video", flag: "official-video", pattern: /\bofficial\s+(?:music\s+|lyric\s+)?(?:video|audio|visuali[sz]er)\b/gi },
  { rule: "supported-by", pattern: /\bsupported\s+by\b.*$/gi },
  { rule: "audio-quality", pattern: /\b\d{2}\s*-?\s*bit\b|\b\d{2,3}(?:[.,]\d+)?\s*k?hz\b/gi },
];

/** Junk only as a whole group: "(Preview)", "[PREMIERE]", "(MASTER3)", "[TX040]", "(1)". */
const GROUP_JUNK: readonly { readonly rule: string; readonly flag?: NameFlag; readonly pattern: RegExp }[] = [
  { rule: "premiere", flag: "premiere", pattern: /\bpremiere\b/i },
  { rule: "preview", flag: "preview", pattern: /\b(?:preview|snippet|teaser)\b/i },
  { rule: "out-now", pattern: /^out\s+(?:now|on\s+\S+)/i },
  { rule: "free", flag: "free-download", pattern: /^free!*$/i },
  { rule: "copyright-note", pattern: /\bcopyright\b/i },
  { rule: "version-tag", pattern: /(?:^|\s)master(?:ed)?\s*v?\d*$|^final(?:\s+(?:version|mix|master))?$/i },
  { rule: "format-tag", pattern: /(?:^|[\s.])(?:mp3|wav|flac|aiff?|kbps|320)$/i },
  { rule: "key-or-bpm", pattern: /^(?:(?:\d{2,3}\s*[Bb][Pp][Mm]|(?:0?[1-9]|1[0-2])[AB]|[A-G][#b]?m(?:in)?)(?:\s*[-|,/]\s*|\s+|$))+$/ },
  { rule: "copy-suffix", pattern: /^\d{1,2}$/ },
  // Uppercase letters then digits, as labels number their releases. Case-sensitive on purpose.
  { rule: "catalogue-number", pattern: /^[A-Z]{2,6}\s?-?\d{2,5}[A-Z]?$/ },
];

/** A whole dash-separated part that is only a key or a BPM: "Title - 3A", "Title - 128 BPM". */
const KEY_OR_BPM_SIDE = /^(?:(?:\d{2,3}\s*[Bb][Pp][Mm]|(?:0?[1-9]|1[0-2])[AB]|[A-G][#b]?m(?:in)?)(?:\s*[-|,/]\s*|\s+|$))+$/;
/** A track number in front: "3. Artist - Title", "04) Title", "02 Artist". Never "50 Cent" (no dot, no leading 0). */
const LEADING_TRACK_NUMBER = /^(?:\d{1,3}\s*[.)]\s*|0\d\s+)(?=\p{L})/u;

/** Loose junk only at the very start or end of the name. */
const LEADING_PREMIERE = /^\s*(?:exclusive\s+)?premiere\s*[:|-]\s*/i;
const TRAILING_PREVIEW = /\s+(?:preview|snippet)\s*$/i;
/** A loose "MASTER" only counts as junk right after an audio-quality tag. */
const TRAILING_MASTER = /\s*\bmaster(?:ed)?\s*\d*\s*$/i;

const ID_PATTERN = /\[\s*(\d{6,12})\s*\]/g;
const AUDIO_EXTENSION = /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|aiff?|alac|wma|mp4)$/i;
/** " | " between parts: "Genre | Artist - Title", "Title | X Edit | FREE DL". */
const PIPE = /\s+\|\s+/g;

// --- Text -----------------------------------------------------------------------------------------

/** Folds look-alike characters (math bold, full-width punctuation, slash and dash variants) and spaces. */
function normalizeText(text: string): string {
  let folded = text.normalize("NFKC").replace(/[⧸∕⁄]/g, "/").replace(/[‐‑‒–—―]/g, "-");
  if (!folded.includes(" ") && folded.includes("_")) folded = folded.replaceAll("_", " ");
  // "*note*" and "** note **" are groups, as brackets are.
  folded = folded.replace(/\*+\s*([^*]+?)\s*\*+/g, "[$1]");
  return folded.replace(/\s+/g, " ").trim();
}

const tidy = (text: string) => text.replace(/\s+/g, " ").replace(/^[\s\-:|,~/]+|[\s\-:|,~/]+$/g, "").trim();
const comparable = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const wordCount = (text: string) => text.split(/\s+/).filter((word) => word !== "").length;
const BAND_ORDER: Record<ConfidenceBand, number> = { high: 2, medium: 1, low: 0 };
const atMost = (band: ConfidenceBand, cap: ConfidenceBand): ConfidenceBand => (BAND_ORDER[band] <= BAND_ORDER[cap] ? band : cap);

type Piece = { readonly kind: "text"; readonly text: string } | { readonly kind: "group"; readonly open: string; readonly close: string; readonly inner: string };

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Depth-0 text and bracket groups. An unclosed bracket is text. */
function tokenize(text: string): Piece[] {
  const pieces: Piece[] = [];
  let buffer = "";
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const close = CLOSERS[char];
    if (close !== undefined) {
      let depth = 0;
      let end = -1;
      for (let scan = index; scan < text.length; scan++) {
        const at = text.charAt(scan);
        if (at in CLOSERS) depth++;
        else if (at === ")" || at === "]" || at === "}") {
          depth--;
          if (depth === 0) {
            end = scan;
            break;
          }
        }
      }
      if (end > index && text.charAt(end) === close) {
        if (buffer !== "") pieces.push({ kind: "text", text: buffer });
        buffer = "";
        pieces.push({ kind: "group", open: char, close, inner: text.slice(index + 1, end).trim() });
        index = end + 1;
        continue;
      }
    }
    buffer += char;
    index++;
  }
  if (buffer !== "") pieces.push({ kind: "text", text: buffer });
  return pieces;
}

// --- One string -----------------------------------------------------------------------------------

interface Found {
  readonly value: string;
  readonly band: ConfidenceBand;
  readonly rule: string;
}

interface SingleParse {
  readonly sourceId: Found | null;
  readonly flags: readonly FlagField[];
  readonly removed: readonly RemovedText[];
  readonly artist: Found | null;
  readonly featuring: Found | null;
  readonly title: Found;
  /** The title without its groups, to compare two parses of one track. */
  readonly titleCore: string;
  readonly mixes: readonly MixToken[];
}

interface Collector {
  readonly flags: FlagField[];
  readonly removed: RemovedText[];
}

function addFlag(collector: Collector, flag: NameFlag, rule: string) {
  if (!collector.flags.some((existing) => existing.flag === flag)) collector.flags.push({ flag, band: "high", rule });
}

/** Takes loose junk out of a piece of text. */
function stripLooseJunk(text: string, collector: Collector): string {
  let rest = text;
  const removedBefore = collector.removed.length;
  for (const junk of LOOSE_JUNK) {
    rest = rest.replace(junk.pattern, (match) => {
      collector.removed.push({ text: match.trim(), rule: junk.rule });
      if (junk.flag !== undefined) addFlag(collector, junk.flag, junk.rule);
      return " ";
    });
  }
  if (collector.removed.slice(removedBefore).some((removed) => removed.rule === "audio-quality")) {
    const master = TRAILING_MASTER.exec(rest);
    if (master !== null) {
      collector.removed.push({ text: master[0].trim(), rule: "version-tag" });
      rest = rest.slice(0, master.index);
    }
  }
  return rest;
}

type Classified =
  | { readonly kind: "junk" }
  | { readonly kind: "feat"; readonly who: string; readonly band: ConfidenceBand; readonly rule: string }
  | { readonly kind: "mix"; readonly mix: MixToken }
  | { readonly kind: "other"; readonly open: string; readonly close: string; readonly inner: string };

function remixerOf(prefix: string, suffix: string): { remixer: string | null; styled: boolean } {
  const by = /^by\s+(.+)$/i.exec(suffix.trim());
  let words = (by?.[1] ?? prefix).replace(/'s$/i, "").split(/\s+/).filter((word) => word !== "");
  let styled = false;
  while (words.length > 0 && isStyleWord(words[words.length - 1] ?? "")) {
    words = words.slice(0, -1);
    styled = true;
  }
  // Leading style words too, but only when the rest still names someone: "(UK Hardcore Flip)" names no one.
  while (words.length > 1 && isStyleWord(words[0] ?? "") && words.every(isStyleWord)) {
    words = words.slice(1);
  }
  const remixer = tidy(words.join(" "));
  if (remixer === "" || words.every(isStyleWord)) return { remixer: null, styled };
  return { remixer, styled };
}

/** A mix token in a group's text, or null. */
function mixOf(inner: string, bracketed: boolean): MixToken | null {
  const matches = [...inner.matchAll(MIX_KEYWORD)];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const kind = mixKindOf(last[1] ?? "");
  const prefix = inner.slice(0, last.index).trim();
  const suffix = inner.slice(last.index + last[0].length).trim();
  const named = kind === "original" || kind === "extended" ? { remixer: null, styled: false } : remixerOf(prefix, suffix);
  const remixer = kind === "vip" && named.remixer !== null && isStyleWord(named.remixer) ? null : named.remixer;
  let band: ConfidenceBand = "high";
  let rule = bracketed ? "mix-group" : "mix-loose";
  if (!bracketed) band = "medium";
  if (named.styled || (suffix !== "" && !/^by\s/i.test(suffix))) band = atMost(band, "medium");
  if (kind === "mix" && remixer !== null) {
    band = "low";
    rule = "mix-generic";
  }
  if (remixer !== null && wordCount(remixer) > MAX_REMIXER_WORDS) band = "low";
  return { kind, remixer, text: inner, band, rule };
}

function classifyGroup(open: string, close: string, rawInner: string, collector: Collector): Classified {
  const inner = tidy(stripLooseJunk(rawInner, collector));
  if (inner === "") return { kind: "junk" };
  for (const junk of GROUP_JUNK) {
    if (junk.pattern.test(inner)) {
      collector.removed.push({ text: `${open}${inner}${close}`, rule: junk.rule });
      if (junk.flag !== undefined) addFlag(collector, junk.flag, junk.rule);
      return { kind: "junk" };
    }
  }
  const feat = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/i.exec(inner);
  if (feat?.[1] !== undefined) return { kind: "feat", who: tidy(feat[1]), band: "high", rule: "feat-group" };
  const withWho = /^(?:with\s+|w\/\s*)(.+)$/i.exec(inner);
  if (withWho?.[1] !== undefined) return { kind: "feat", who: tidy(withWho[1]), band: "medium", rule: "with-group" };
  const mix = mixOf(inner, true);
  if (mix !== null) return { kind: "mix", mix };
  return { kind: "other", open, close, inner };
}

type SidePiece = { readonly kind: "text"; readonly text: string } | { readonly kind: "group"; readonly group: Classified };

interface Side {
  readonly pieces: SidePiece[];
}

const LOOSE_FEAT = /\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const LOOSE_MIX = /\s(rmx|remix|vip|bootleg|flip|edit)$/i;
/** A whole part that is "<a few names> Remix": not "Title VIP", which artists name their own versions. */
const DASH_MIX_SUFFIX = /^(?:\S+\s+){1,4}(?:remix|rmx|bootleg|flip|edit|re-?work|mash-?up)$/i;
/** "A - B": a dash with space on both sides. A dash inside a group never splits (groups are pieces of their own). */
const SPACED_DASH = /\s-+\s/;
/** "A- B" or "A -B": only tried when no spaced dash splits the name. */
const TIGHT_DASH = /(?<=[\p{L}\p{N})\]!?.$])-\s+|\s+-(?=[\p{L}\p{N}([])/u;

const sideText = (side: Side) => tidy(side.pieces.flatMap((piece) => (piece.kind === "text" ? [piece.text] : [])).join(" "));
const sideGroups = (side: Side) => side.pieces.flatMap((piece) => (piece.kind === "group" ? [piece.group] : []));
const sideHasGroups = (side: Side) => sideGroups(side).some((group) => group.kind === "mix" || group.kind === "other");
const looksLikeArtistList = (text: string) => /,\s|\s(?:&|x|vs\.?|and)\s/i.test(text);
/** "A, B" or "A x B x C" on the right of "Title - A, B". */
const looksLikeNameList = (text: string) => /,\s/.test(text) || (text.match(/\s(?:x|&)\s/gi) ?? []).length >= 2;

function artistProblem(value: string): string | null {
  const letters = value.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < MIN_ARTIST_CHARS) return "artist-too-short";
  if (ARTIST_DENY_LIST.has(value.toLowerCase().replaceAll(".", "").trim())) return "artist-deny-list";
  if (/^\d+$/.test(letters)) return "artist-numeric";
  return null;
}

function formatGroup(group: Classified): string | null {
  switch (group.kind) {
    case "junk":
      return null;
    case "feat":
      return group.rule === "with-group" ? `(with ${group.who})` : `(feat. ${group.who})`;
    case "mix":
      return `(${group.mix.text})`;
    case "other":
      return `${group.open}${group.inner}${group.close}`;
  }
}

function splitSides(pieces: readonly SidePiece[], separator: RegExp): Side[] {
  const sides: Side[] = [{ pieces: [] }];
  for (const piece of pieces) {
    if (piece.kind === "group") {
      sides[sides.length - 1]?.pieces.push(piece);
      continue;
    }
    ` ${piece.text} `.split(separator).forEach((part, index) => {
      if (index > 0) sides.push({ pieces: [] });
      sides[sides.length - 1]?.pieces.push({ kind: "text", text: part });
    });
  }
  // A side with no text gives its groups to the side before it; a first one is dropped.
  const merged: Side[] = [];
  for (const side of sides) {
    const previous = merged[merged.length - 1];
    if (sideText(side) === "") {
      previous?.pieces.push(...side.pieces);
      continue;
    }
    merged.push(side);
  }
  return merged;
}

/**
 * The title as written: its sides joined by " - ", each side's text and groups in their order, the
 * leading groups ("(ADE) Title") right after the first words.
 */
function renderTitle(sides: readonly Side[], leading: readonly Classified[]): { text: string; groups: Classified[] } {
  const groups: Classified[] = [];
  let leadingPlaced = leading.length === 0;
  const rendered = sides.map((side) => {
    const parts: string[] = [];
    for (const piece of side.pieces) {
      if (piece.kind === "group") {
        const formatted = formatGroup(piece.group);
        if (formatted !== null) parts.push(formatted);
        groups.push(piece.group);
        continue;
      }
      const words = tidy(piece.text);
      if (words === "") continue;
      parts.push(words);
      if (!leadingPlaced) {
        parts.push(...leading.map(formatGroup).filter((group) => group !== null));
        groups.push(...leading);
        leadingPlaced = true;
      }
    }
    return tidy(parts.join(" "));
  });
  if (!leadingPlaced) {
    rendered.unshift(leading.map(formatGroup).filter((group) => group !== null).join(" "));
    groups.unshift(...leading);
  }
  return { text: tidy(rendered.filter((side) => side !== "").join(" - ")), groups };
}

function parseOne(source: string, artistTag: string | null): SingleParse {
  const collector: Collector = { flags: [], removed: [] };
  let text = normalizeText(source);

  // The ID: the last bracketed 6-12 digit number. Trailing is the downloader's mark.
  let sourceId: Found | null = null;
  const ids = [...text.matchAll(ID_PATTERN)];
  const lastId = ids[ids.length - 1];
  if (lastId?.[1] !== undefined) {
    const trailing = lastId.index + lastId[0].length >= text.trimEnd().length;
    sourceId = { value: lastId[1], band: trailing ? "high" : "medium", rule: trailing ? "trailing-id" : "bracketed-id" };
    collector.removed.push({ text: lastId[0], rule: sourceId.rule });
    text = text.replace(ID_PATTERN, " ").trim();
  }

  const premiere = LEADING_PREMIERE.exec(text);
  if (premiere !== null) {
    collector.removed.push({ text: premiere[0].trim(), rule: "premiere" });
    addFlag(collector, "premiere", "premiere");
    text = text.slice(premiere[0].length);
  }
  const trackNumber = LEADING_TRACK_NUMBER.exec(text);
  if (trackNumber !== null) {
    collector.removed.push({ text: trackNumber[0].trim(), rule: "track-number" });
    text = text.slice(trackNumber[0].length);
  }
  const extension = AUDIO_EXTENSION.exec(text);
  if (extension !== null) {
    collector.removed.push({ text: extension[0], rule: "file-extension" });
    text = text.slice(0, extension.index);
  }
  // Pipes: a part before the artist ("Genre | Artist - Title") goes; parts after the first are groups.
  const pipes = [...text.matchAll(PIPE)];
  if (pipes.length > 0) {
    const dash = text.search(SPACED_DASH);
    const prefixPipes = dash === -1 ? [] : pipes.filter((pipe) => pipe.index < dash);
    const lastPrefix = prefixPipes[prefixPipes.length - 1];
    if (lastPrefix !== undefined) {
      collector.removed.push({ text: text.slice(0, lastPrefix.index).trim(), rule: "pipe-prefix" });
      text = text.slice(lastPrefix.index + lastPrefix[0].length);
    }
    const [first = "", ...rest] = text.split(PIPE);
    text = [first, ...rest.map((part) => `[${part.trim()}]`)].join(" ");
  }

  // Groups and text at depth 0, junk out; groups before any words lead the title.
  const leading: Classified[] = [];
  const pieces: SidePiece[] = [];
  for (const piece of tokenize(text)) {
    if (piece.kind === "group") {
      const group = classifyGroup(piece.open, piece.close, piece.inner, collector);
      if (group.kind === "junk") continue;
      if (pieces.every((earlier) => earlier.kind === "group" || tidy(earlier.text) === "")) leading.push(group);
      else pieces.push({ kind: "group", group });
      continue;
    }
    pieces.push({ kind: "text", text: stripLooseJunk(piece.text, collector) });
  }

  let tight = false;
  let sides = splitSides(pieces, SPACED_DASH);
  if (sides.length === 1) {
    const tightSides = splitSides(pieces, TIGHT_DASH);
    if (tightSides.length === 2) {
      sides = tightSides;
      tight = true;
    }
  }
  // A last part that is only a key or a BPM ("Title - 3A") is junk.
  const last = sides[sides.length - 1];
  if (sides.length >= 2 && last !== undefined && KEY_OR_BPM_SIDE.test(sideText(last))) {
    collector.removed.push({ text: sideText(last), rule: "key-or-bpm" });
    sides = sides.slice(0, -1);
    sides[sides.length - 1]?.pieces.push(...last.pieces.filter((piece) => piece.kind === "group"));
  }
  // So is a first part that is only a key ("7A - Artist - Title"), as some tools prefix it.
  const first = sides[0];
  if (sides.length >= 2 && first !== undefined && sideGroups(first).length === 0 && KEY_OR_BPM_SIDE.test(sideText(first))) {
    collector.removed.push({ text: sideText(first), rule: "key-or-bpm" });
    sides = sides.slice(1);
  }
  // "Title - X Remix": the part after the dash is the mix, loose; no artist in this name.
  const [titleSide, mixSide] = sides;
  if (sides.length === 2 && titleSide !== undefined && mixSide !== undefined && sideGroups(mixSide).length === 0 && !sideHasGroups(titleSide)) {
    const loose = DASH_MIX_SUFFIX.exec(sideText(mixSide));
    const mix = loose === null ? null : mixOf(sideText(mixSide), false);
    if (mix !== null) sides = [{ pieces: [...titleSide.pieces, { kind: "group", group: { kind: "mix", mix: { ...mix, rule: "dash-mix-suffix" } } }] }];
  }
  // A loose "preview" at the very end.
  const tail = sides[sides.length - 1]?.pieces;
  const tailPiece = tail?.[tail.length - 1];
  if (tail !== undefined && tailPiece?.kind === "text") {
    const preview = TRAILING_PREVIEW.exec(tailPiece.text);
    if (preview !== null) {
      collector.removed.push({ text: preview[0].trim(), rule: "preview" });
      addFlag(collector, "preview", "preview");
      tail[tail.length - 1] = { kind: "text", text: tailPiece.text.slice(0, preview.index) };
    }
  }

  // Which side is the artist.
  let artist: Found | null = null;
  let featuring: Found | null = null;
  let titleSides: Side[] = sides;
  let titleBand: ConfidenceBand = "high";
  let titleRule = "no-separator";
  const left = sides[0];
  if (sides.length >= 2 && left !== undefined) {
    const rest = sides.slice(1);
    const right: Side = { pieces: rest.flatMap((side) => side.pieces) };
    const leftText = sideText(left);
    const rightText = rest.map(sideText).join(" - ");
    const leftFeat = LOOSE_FEAT.exec(leftText);
    const rightFeat = sides.length === 2 ? LOOSE_FEAT.exec(rightText) : null;
    const leftName = leftFeat === null ? leftText : tidy(leftText.slice(0, leftFeat.index));
    const rightName = rightFeat === null ? rightText : tidy(rightText.slice(0, rightFeat.index));
    const leftTitleLike = sideHasGroups(left);
    const leftArtistLike = leftFeat !== null || looksLikeArtistList(leftText);
    const rightArtistLike = rightFeat !== null || looksLikeNameList(rightName);
    const tag = artistTag === null ? "" : comparable(artistTag);

    let reversed = false;
    let band: ConfidenceBand = sides.length > 2 ? "medium" : "high";
    let rule = sides.length > 2 ? "artist-dash-title-multiple" : tight ? "artist-dash-title-tight" : "artist-dash-title";
    if (tight) band = "medium";
    if (tag !== "" && sides.length === 2 && comparable(rightName) === tag && comparable(leftName) !== tag) {
      reversed = true;
      rule = "split-by-artist-tag";
      band = "high";
    } else if (tag !== "" && comparable(leftName) === tag) {
      rule = "split-by-artist-tag";
      band = "high";
    } else if (sides.length === 2 && leftTitleLike && rightArtistLike) {
      reversed = true;
      band = "medium";
      rule = "title-dash-artist";
    } else if (sides.length === 2 && leftTitleLike && !leftArtistLike) {
      reversed = true;
      band = "low";
      rule = "title-dash-artist-guess";
    } else if (rightArtistLike && !leftArtistLike) {
      band = atMost(band, "medium");
      rule = "artist-dash-title-ambiguous";
    }

    const artistFeat = reversed ? rightFeat : leftFeat;
    const candidate = reversed ? rightName : leftName;
    // The artist side's groups (a feat, a mix) belong to the end of the title.
    const moved = sideGroups(reversed ? right : left).map((group): SidePiece => ({ kind: "group", group }));
    const base = reversed ? [left] : rest;
    titleSides = [...base.slice(0, -1), { pieces: [...(base[base.length - 1]?.pieces ?? []), ...moved] }];
    const problem = artistProblem(candidate);
    if (problem === null) {
      if (wordCount(candidate) > MAX_ARTIST_WORDS || candidate.length > MAX_ARTIST_CHARS) {
        band = "low";
        rule = "artist-too-long";
      } else if (/^\d{1,3}\s/.test(candidate) && band === "high") {
        band = "medium";
        rule = "artist-leading-number";
      }
      artist = { value: candidate, band, rule };
      if (artistFeat?.[1] !== undefined) featuring = { value: tidy(artistFeat[1]), band, rule: "feat-loose" };
      titleBand = band;
      titleRule = rule;
    } else {
      collector.removed.push({ text: candidate, rule: problem });
      titleBand = "medium";
      titleRule = problem;
    }
  }

  const title = renderTitle(titleSides, leading);
  const titleWords = titleSides.map(sideText).join(" - ");
  if (featuring === null) {
    const featGroup = title.groups.find((group) => group.kind === "feat");
    const titleFeat = LOOSE_FEAT.exec(titleWords);
    if (featGroup?.kind === "feat") featuring = { value: featGroup.who, band: featGroup.band, rule: featGroup.rule };
    else if (titleFeat?.[1] !== undefined) featuring = { value: tidy(titleFeat[1]), band: "high", rule: "feat-loose" };
  }
  const mixes = title.groups.flatMap((group) => (group.kind === "mix" ? [group.mix] : []));
  const looseMix = LOOSE_MIX.exec(titleWords);
  if (looseMix?.[1] !== undefined && mixes.length === 0) {
    mixes.push({ kind: mixKindOf(looseMix[1]), remixer: null, text: looseMix[1], band: "medium", rule: "mix-loose" });
  }

  return {
    sourceId,
    flags: collector.flags,
    removed: collector.removed,
    artist,
    featuring,
    title: { value: title.text, band: titleBand, rule: titleRule },
    titleCore: comparable(titleWords),
    mixes,
  };
}

// --- The track ------------------------------------------------------------------------------------

const sameCredit = (a: string, b: string) => comparable(a) === comparable(b);

function tagOf(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

const field = <T>(found: { value: T; band: ConfidenceBand; rule: string }, source: FieldSource, cap: ConfidenceBand = "high"): ProposedField<T> => ({
  value: found.value,
  band: atMost(found.band, cap),
  rule: found.rule,
  source,
});

export function parseTrackName(input: NameParseInput): NameParse {
  const fileName = input.fileName ?? null;
  const artistTag = tagOf(input.tags?.artist);
  const titleTag = tagOf(input.tags?.title);
  const remixerTag = tagOf(input.tags?.remixer);

  const nameBlank = normalizeText(input.rawName) === "";
  const fromName = nameBlank ? null : parseOne(input.rawName, artistTag);
  const fromFile = fileName === null ? null : parseOne(fileName.replace(AUDIO_EXTENSION, ""), artistTag);
  const primary = fromName ?? fromFile;
  const primarySource: FieldSource = fromName === null ? "file-name" : "name";
  // The file name speaks for the same track, but if the name was edited by hand to a different
  // title, what the file says is less sure.
  const titlesAgree =
    fromName === null || fromFile === null || fromName.titleCore === fromFile.titleCore || (fromName.titleCore !== "" && fromFile.titleCore.includes(fromName.titleCore)) || (fromFile.titleCore !== "" && fromName.titleCore.includes(fromFile.titleCore));
  const fileCap: ConfidenceBand = titlesAgree ? "high" : "medium";
  const secondary = fromName === null ? null : fromFile;

  const pick = <T>(fromPrimary: { value: T; band: ConfidenceBand; rule: string } | null, fromSecondary: { value: T; band: ConfidenceBand; rule: string } | null): ProposedField<T> | null => {
    if (fromPrimary !== null) return field(fromPrimary, primarySource);
    if (fromSecondary !== null) return field(fromSecondary, "file-name", fileCap);
    return null;
  };

  const title: ProposedField<string> =
    titleTag !== null ? { value: titleTag, band: "high", rule: "existing-tag", source: "tag" } : primary === null ? { value: "", band: "low", rule: "no-name", source: "name" } : field(primary.title, primarySource);

  const mixes = primary?.mixes ?? [];
  const lastMix = mixes[mixes.length - 1];
  const fileMixes = secondary?.mixes ?? [];
  const lastFileMix = fileMixes[fileMixes.length - 1];
  const mixFound = (mix: MixToken | undefined) => (mix === undefined ? null : { value: mix.kind, band: mix.band, rule: mix.rule });
  const mixKind = pick(mixFound(lastMix), mixFound(lastFileMix));
  const remixerFound = (mix: MixToken | undefined) => (mix?.remixer == null ? null : { value: mix.remixer, band: mix.band, rule: mix.rule });
  // The file's remixer only fills in for the same kind of mix (or when the name has none).
  const fileRemixer = lastMix === undefined || lastFileMix?.kind === lastMix.kind ? remixerFound(lastFileMix) : null;
  // The outermost remix, edit, bootleg… that names its maker: "(X Remix) (Extended Mix)" is X's.
  const creditOf = (list: readonly MixToken[]) => list.findLast((mix) => mix.remixer !== null && CREDITED_KINDS.has(mix.kind));
  const nameCredit = creditOf(mixes);
  const fileCandidate = nameCredit === undefined ? creditOf(fileMixes) : undefined;
  const fileCredit = fileCandidate !== undefined && (mixes.length === 0 || mixes.some((mix) => mix.kind === fileCandidate.kind)) ? fileCandidate : undefined;
  const creditFound = nameCredit !== undefined ? remixerFound(nameCredit) : null;
  const fileCreditFound = fileCredit !== undefined ? remixerFound(fileCredit) : null;
  const tagField: ProposedField<string> | null = remixerTag === null ? null : { value: remixerTag, band: "high", rule: "existing-tag", source: "tag" };
  const creditField = pick(creditFound, fileCreditFound);
  const remixer: ProposedField<string> | null = tagField ?? creditField ?? pick(remixerFound(lastMix), fileRemixer);

  // The maker of a credited kind is the artist; the name's own artist becomes the original artist.
  const credited = creditField === null ? null : (tagField ?? creditField);
  const namedArtist = pick(primary?.artist ?? null, secondary?.artist ?? null);
  const original = namedArtist !== null && credited !== null && !sameCredit(namedArtist.value, credited.value) ? { ...namedArtist, rule: `original-${namedArtist.rule}` } : null;
  let artist: ProposedField<string> | null;
  let originalArtist: ProposedField<string> | null = null;
  if (artistTag !== null) {
    artist = { value: artistTag, band: "high", rule: "existing-tag", source: "tag" };
    // A tag naming the remixer agrees with the rule, and the name's artist is still the original.
    if (credited !== null && sameCredit(artistTag, credited.value)) originalArtist = original;
  } else if (credited !== null) {
    artist = { value: credited.value, band: credited.band, rule: `remixer-is-artist:${credited.rule}`, source: credited.source };
    originalArtist = original;
  } else {
    artist = namedArtist;
  }

  const flags = [...(primary?.flags ?? [])];
  for (const flag of secondary?.flags ?? []) if (!flags.some((existing) => existing.flag === flag.flag)) flags.push(flag);

  return {
    version: NAME_PARSER_VERSION,
    raw: { name: input.rawName, fileName },
    artist,
    originalArtist,
    title,
    remixer,
    mixKind,
    mixes,
    featuring: pick(primary?.featuring ?? null, secondary?.featuring ?? null),
    flags,
    sourceId: pick(primary?.sourceId ?? null, secondary?.sourceId ?? null),
    removed: primary?.removed ?? [],
  };
}
