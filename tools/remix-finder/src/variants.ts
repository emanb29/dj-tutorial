/**
 * Which search results are variants of a song, and what kind.
 *
 * Pure and deterministic. A result is a variant when its title names the song (and, for a short
 * or common title, the artist too) and carries a variant word: remix, edit, bootleg, flip, VIP,
 * mashup, slowed… The kind says whether it is likely mixable ("dj") or a listening version
 * ("listening": slowed, sped up, nightcore, acoustic, live, cover). Junk (lyric videos, karaoke,
 * 8D audio, reactions, tutorials, type beats) is never a variant.
 */

export type VariantKind =
  | "remix"
  | "edit"
  | "bootleg"
  | "flip"
  | "vip"
  | "rework"
  | "mashup"
  | "extended"
  | "dub"
  | "instrumental"
  | "acapella"
  | "slowed"
  | "sped-up"
  | "nightcore"
  | "acoustic"
  | "live"
  | "cover";

const LISTENING_KINDS: ReadonlySet<VariantKind> = new Set(["slowed", "sped-up", "nightcore", "acoustic", "live", "cover"]);
export const isDjKind = (kind: VariantKind) => !LISTENING_KINDS.has(kind);

export interface Song {
  readonly title: string;
  /** Every credited artist, the main one first. */
  readonly artists: readonly string[];
}

export interface Classification {
  readonly kind: VariantKind;
  /** Who made it, when the title says ("(Fcukers Remix)" → "Fcukers"); null otherwise. */
  readonly remixer: string | null;
}

/** Lower case, accents and punctuation gone, single spaces. */
export const normalise = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The song's title without what Spotify adds: "(feat. X)", "- Remastered 2011", "- Radio Edit". */
export function coreTitle(title: string): string {
  const withoutBrackets = title.replace(/\s*[([][^)\]]*(?:feat\.?|ft\.?|with|remaster|version|edit|mix|live|mono|stereo|from)[^)\]]*[)\]]/gi, "");
  const withoutSuffix = withoutBrackets.replace(/\s+-\s+.*$/u, "");
  const core = normalise(withoutSuffix);
  return core === "" ? normalise(title) : core;
}

const JUNK = /\b(?:lyrics?|lyric video|karaoke|8d|reaction|reacts?|tutorial|how to|type beat|piano tutorial|drum cover|guitar cover|bass cover|letra|traduc|sub espa|1 hour|10 hours?|loop(?:ed)? for)\b/i;

/** Variant words, most specific first: the first that matches is the kind. */
const KIND_PATTERNS: readonly (readonly [VariantKind, RegExp])[] = [
  ["nightcore", /\bnightcore\b/i],
  ["slowed", /\bslowed\b|\breverb\b/i],
  ["sped-up", /\bsped\s*up\b|\bspeed\s*up\b/i],
  ["mashup", /\bmash\s*-?\s*up\b|\bblend\b/i],
  ["vip", /\bvip\b/i],
  ["bootleg", /\bbootleg\b|\bboot\b/i],
  ["flip", /\bflip\b/i],
  ["rework", /\bre\s*-?\s*work\b|\bre\s*-?\s*fix\b|\bre\s*-?\s*make\b|\bre\s*-?\s*imagin/i],
  ["edit", /\b(?:re\s*-?\s*)?edit\b/i],
  ["remix", /\bremix(?:es)?\b|\brmx\b|\bremixed\b/i],
  ["dub", /\bdub\b/i],
  ["extended", /\bextended\b|\bclub mix\b|\bclub version\b/i],
  ["instrumental", /\binstrumental\b/i],
  ["acapella", /\ba\s*cappella\b|\bacapella\b/i],
  ["acoustic", /\bacoustic\b|\bunplugged\b/i],
  ["live", /\blive\b/i],
  ["cover", /\bcover\b/i],
];

/** Mix words that name no one: "(Radio Edit)", "(Extended Mix)", "(Original Mix)". */
const NOBODY = /^(?:original|extended|radio|club|official|the|a|my|dub|instrumental|vip|festival|clean|dirty|short|long|vocal|main|album|single|special|bootleg|tiktok|house|techno|dnb|drum and bass|trance|garage|ukg|jersey club|amapiano|phonk|hardstyle|future|deep|tech|slowed|sped up)$/i;

const CREDIT = /[([]\s*([^()[\]]+?)\s+(?:remix|rmx|edit|re-?edit|bootleg|flip|vip|re-?work|re-?fix|mash-?up|dub|mix|version)\b[^)\]]*[)\]]/i;

/** "Artist - Title - X Edit": a credit after the last dash, without brackets. */
const DASH_CREDIT = /\s-\s([^-()[\]]+?)\s+(?:remix|rmx|edit|re-?edit|bootleg|flip|vip|re-?work|re-?fix)\s*$/i;

function remixerOf(title: string): string | null {
  const credit = (CREDIT.exec(title) ?? DASH_CREDIT.exec(title))?.[1]?.trim() ?? null;
  if (credit === null || NOBODY.test(credit) || /\b(?:feat|ft|slowed|reverb|sped|nightcore|bass ?boosted)\b/i.test(credit)) return null;
  return credit.replace(/^(?:a|the)\s+/i, "") || null;
}

/** What kind of variant a title is, or null when it is the original, junk, or no variant at all. */
export function classifyTitle(title: string): Classification | null {
  if (JUNK.test(title)) return null;
  const kind = KIND_PATTERNS.find(([, pattern]) => pattern.test(title))?.[0];
  if (kind === undefined) return null;
  // "Radio Edit" and "Original Mix" are the song itself.
  if (kind === "edit" && /\bradio edit\b/i.test(title) && !/\b(?:remix|bootleg|flip|vip)\b/i.test(title)) return null;
  return { kind, remixer: remixerOf(title) };
}

const containsWords = (haystack: string, needle: string) => needle !== "" && ` ${haystack} `.includes(` ${needle} `);

/**
 * Whether a result names the song: its core title as whole words, and the artist (in the title or
 * as the uploader) unless the core title is distinctive on its own (three words or more).
 */
export function namesSong(song: Song, resultTitle: string, uploader: string): boolean {
  const title = normalise(resultTitle);
  const core = coreTitle(song.title);
  if (!containsWords(title, core)) return false;
  if (core.split(" ").length >= 3) return true;
  const where = `${title} ${normalise(uploader)}`;
  return song.artists.some((artist) => containsWords(where, normalise(artist)));
}

/** The variant a result is of the song, or null when it is not one. */
export function matchVariant(song: Song, resultTitle: string, uploader: string): Classification | null {
  if (!namesSong(song, resultTitle, uploader)) return null;
  // A variant word the song's own title carries ("Loser (Live)") says nothing about the result.
  const classification = classifyTitle(resultTitle);
  if (classification === null) return null;
  const ownWords = classifyTitle(song.title);
  if (ownWords !== null && ownWords.kind === classification.kind && ownWords.remixer === classification.remixer) return null;
  return classification;
}

/** Results that are the same variant on several platforms share this key. */
export const variantKey = (song: Song, classification: Classification) =>
  [coreTitle(song.title), classification.kind, normalise(classification.remixer ?? "")].join("|");
