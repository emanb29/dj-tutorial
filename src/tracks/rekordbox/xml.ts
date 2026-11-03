/**
 * rekordbox's collection XML (File → Export Collection in xml format), read in pieces as it streams in.
 *
 * The format, from AlphaTheta's own list (the primary source) and pyrekordbox's notes on it:
 * - https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf
 *   (DJ_PLAYLISTS > COLLECTION > TRACK; TRACK's Name, Artist, Album, Genre, Size, TotalTime, AverageBpm,
 *   PlayCount, Rating, Location "URI formatted", Tonality; TEMPO's Inizio, Bpm, Metro, Battito;
 *   POSITION_MARK's Name, Type, Start, End, Num. Strings are UTF-8 with XML entities; numbers use
 *   a dot; Location is expected under "file://localhost/".)
 * - https://pyrekordbox.readthedocs.io/en/stable/formats/xml.html
 *   (units: Inizio, Start, End and TotalTime in seconds; Rating 0/51/102/153/204/255 = 0-5 stars;
 *   POSITION_MARK Type 0 cue, 1 fade-in, 2 fade-out, 3 load, 4 loop; Num 0, 1, 2 … = hot cue A, B,
 *   C …, -1 = memory cue; Battito 1-4 in 4/4.)
 * Not in either list but written by rekordbox 6 and 7: Red, Green and Blue (0-255) on a hot cue's
 * POSITION_MARK, its pad colour. Read when present, never required.
 *
 * Only the COLLECTION is read; PLAYLISTS (after it) is not. Every TRACK, TEMPO and POSITION_MARK is
 * validated (zod): one that does not validate is skipped and counted, never a crash. A TRACK with one
 * bad TEMPO keeps no grid at all (half a grid would put bar 1 in the wrong place). Pure: runs in the
 * parse worker (parse.worker.ts) and in tests.
 */
import { z } from "zod";

export interface RekordboxTempo {
  /** Where this tempo starts, track seconds: a beat. */
  readonly inizioSec: number;
  readonly bpm: number;
  /** e.g. "4/4". */
  readonly metro: string;
  /** Which beat of the bar the beat at `inizioSec` is, 1-based. */
  readonly battito: number;
}

export interface RekordboxCue {
  /** Hot cues are on pads (Num 0-7: A-H); memory cues are not. */
  readonly kind: "hot" | "memory";
  /** 0-based pad (A = 0); null for a memory cue. */
  readonly slot: number | null;
  readonly startSec: number;
  /** A loop's end. */
  readonly endSec?: number;
  readonly name: string;
  readonly type: "cue" | "loop" | "fade-in" | "fade-out" | "load";
  /** "#rrggbb", where rekordbox wrote one. */
  readonly colour?: string;
}

export interface RekordboxTrack {
  readonly name: string;
  readonly artist: string;
  /** "" when rekordbox has none. */
  readonly album: string;
  readonly genre: string;
  /** The key as rekordbox shows it ("Am", "8A", "F#m"…); "" when not analysed. */
  readonly tonality: string;
  /** Stars, 0-5. */
  readonly rating: number;
  readonly playCount: number;
  readonly totalTimeSec: number | null;
  /** Bytes. */
  readonly size: number | null;
  readonly averageBpm: number | null;
  readonly location: string;
  /** Location decoded into path parts, from the top: ["Users", "dj", "Music", "a.mp3"]. */
  readonly segments: readonly string[];
  readonly tempos: readonly RekordboxTempo[];
  readonly cues: readonly RekordboxCue[];
}

export interface RekordboxLibrary {
  readonly tracks: readonly RekordboxTrack[];
  /** TRACK entries that did not validate (no or bad Location, a field that is not a number…). */
  readonly skippedTracks: number;
  /** TEMPO and POSITION_MARK entries that did not validate. */
  readonly skippedMarks: number;
  /** Whether the collection had more than MAX_REKORDBOX_TRACKS (the rest were not read). */
  readonly truncated: boolean;
}

export type RekordboxParseError =
  | { readonly kind: "not-rekordbox"; readonly message: string; readonly fix: string }
  | { readonly kind: "malformed"; readonly message: string; readonly fix: string };

export type RekordboxParse = { readonly ok: true; readonly library: RekordboxLibrary } | { readonly ok: false; readonly error: RekordboxParseError };

export const MAX_REKORDBOX_TRACKS = 200_000;
/** A tag longer than this is not one rekordbox writes: the file is broken. */
const MAX_TAG_CHARS = 1_000_000;

const NOT_REKORDBOX: RekordboxParseError = {
  kind: "not-rekordbox",
  message: "That file is not a rekordbox collection.",
  fix: "In rekordbox: File → Export Collection in xml format. Then pick that file.",
};

const malformed = (what: string): RekordboxParseError => ({
  kind: "malformed",
  message: `The rekordbox file is broken: ${what}.`,
  fix: "Export it again from rekordbox (File → Export Collection in xml format).",
});

// --- Values -------------------------------------------------------------------------------------

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** A number attribute that may be missing or empty; present but not a number fails. */
const optionalNumber = z
  .string()
  .optional()
  .transform((text, context) => {
    const trimmed = text?.trim() ?? "";
    if (trimmed === "") return null;
    if (!NUMBER.test(trimmed)) {
      context.addIssue({ code: "custom", message: `"${trimmed}" is not a number` });
      return z.NEVER;
    }
    return Number(trimmed);
  });

const requiredNumber = z
  .string()
  .trim()
  .regex(NUMBER, "not a number")
  .transform(Number);

const text = z.string().optional().transform((value) => value ?? "");

const TrackSchema = z.object({
  Name: text,
  Artist: text,
  Album: text,
  Genre: text,
  Tonality: text,
  Rating: optionalNumber,
  PlayCount: optionalNumber,
  TotalTime: optionalNumber.refine((value) => value === null || value >= 0, "TotalTime is negative"),
  Size: optionalNumber.refine((value) => value === null || (Number.isInteger(value) && value >= 0), "Size is not a whole number of bytes"),
  AverageBpm: optionalNumber,
  Location: z.string().min(1),
});

const TempoSchema = z.object({
  Inizio: requiredNumber,
  Bpm: requiredNumber.refine((bpm) => bpm > 0 && bpm < 1000, "Bpm out of range"),
  Metro: z.string().optional().transform((metro) => (metro ?? "4/4").replaceAll(" ", "")),
  Battito: requiredNumber.refine((beat) => Number.isInteger(beat) && beat >= 1 && beat <= 16, "Battito out of range").optional(),
});

const MARK_TYPES = ["cue", "fade-in", "fade-out", "load", "loop"] as const;
const channel = optionalNumber.refine((value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 255), "colour out of range");

const MarkSchema = z.object({
  Name: text,
  Type: requiredNumber.refine((type) => Number.isInteger(type) && type >= 0 && type < MARK_TYPES.length, "unknown Type"),
  Start: requiredNumber,
  End: optionalNumber,
  Num: requiredNumber.refine((num) => Number.isInteger(num) && num >= -1, "bad Num"),
  Red: channel,
  Green: channel,
  Blue: channel,
});

const hex = (value: number) => value.toString(16).padStart(2, "0");

function cueOf(mark: z.infer<typeof MarkSchema>): RekordboxCue {
  const colour = mark.Red === null || mark.Green === null || mark.Blue === null ? undefined : `#${hex(mark.Red)}${hex(mark.Green)}${hex(mark.Blue)}`;
  return {
    kind: mark.Num >= 0 ? "hot" : "memory",
    slot: mark.Num >= 0 ? mark.Num : null,
    startSec: mark.Start,
    ...(mark.End === null ? {} : { endSec: mark.End }),
    name: mark.Name,
    type: MARK_TYPES[mark.Type] ?? "cue",
    ...(colour === undefined ? {} : { colour }),
  };
}

/**
 * The path parts of a TRACK's Location: "file://localhost/Users/dj/a%20b.mp3" → ["Users", "dj", "a b.mp3"].
 * Null when it is not a file URL, has no file name, or a part will not percent-decode.
 */
export function locationSegments(location: string): string[] | null {
  const match = /^file:\/\/(?:localhost)?\/(.*)$/i.exec(location.trim());
  if (match === null) return null;
  try {
    const segments = (match[1] ?? "")
      .split("/")
      .filter((part) => part !== "")
      .map((part) => decodeURIComponent(part).normalize("NFC"));
    return segments.length === 0 ? null : segments;
  } catch {
    return null;
  }
}

/** Ends a parse early with an expected problem (caught in parseRekordboxXml, never escapes it). */
class ParseStop extends Error {
  constructor(readonly problem: RekordboxParseError) {
    super(problem.message);
  }
}

// --- Tags ---------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return safeCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith("#")) return safeCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
    return ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(code: number): string | null {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}

const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(body: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of body.matchAll(ATTRIBUTE)) {
    const name = match[1];
    if (name !== undefined) attributes[name] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly body: string;
}

/** Index of the `>` that ends the tag opened at `from`, skipping `>` inside quoted values; -1 if not there yet. */
function tagEnd(buffer: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

/** Splits text into tags as it arrives; text between tags is dropped (rekordbox keeps everything in attributes). */
function createTagReader() {
  let buffer = "";
  return {
    /** Adds `chunk` and returns the tags now complete. Throws ParseStop for a runaway tag. */
    push(chunk: string): Tag[] {
      buffer += chunk;
      const tags: Tag[] = [];
      let at = 0;
      for (;;) {
        const open = buffer.indexOf("<", at);
        if (open === -1) {
          at = buffer.length;
          break;
        }
        const special = [
          ["<!--", "-->"],
          ["<![CDATA[", "]]>"],
          ["<?", "?>"],
        ].find(([start]) => buffer.startsWith(start ?? "", open));
        if (special !== undefined) {
          const close = buffer.indexOf(special[1] ?? "", open);
          if (close === -1) {
            at = open;
            break;
          }
          at = close + (special[1] ?? "").length;
          continue;
        }
        const end = tagEnd(buffer, open + 1);
        if (end === -1) {
          at = open;
          break;
        }
        const inner = buffer.slice(open + 1, end);
        at = end + 1;
        if (inner.startsWith("!")) continue;
        const closing = inner.startsWith("/");
        const selfClosing = inner.endsWith("/");
        const content = inner.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
        const name = /^[A-Za-z_][-\w:.]*/.exec(content)?.[0] ?? "";
        tags.push({ name, closing, selfClosing, body: content.slice(name.length) });
      }
      buffer = buffer.slice(at);
      if (buffer.length > MAX_TAG_CHARS) throw new ParseStop(malformed("a tag never ends"));
      return tags;
    },
    /** Whether anything but whitespace is left over. */
    leftover: () => buffer.trim() !== "",
  };
}

// --- The collection -----------------------------------------------------------------------------


/**
 * Reads a collection from `chunks` (the file's text, in any pieces). Stops reading at the end of the
 * COLLECTION. Never throws for bad input: every problem is in the result.
 */
export async function parseRekordboxXml(chunks: AsyncIterable<string> | Iterable<string>): Promise<RekordboxParse> {
  const reader = createTagReader();
  const tracks: RekordboxTrack[] = [];
  let skippedTracks = 0;
  let skippedMarks = 0;
  let truncated = false;
  let sawRoot = false;
  let inCollection = false;
  let finished = false;
  let current: { attributes: Record<string, string>; tempos: RekordboxTempo[]; cues: RekordboxCue[]; badTempo: boolean } | null = null;

  const finishTrack = () => {
    const open = current;
    current = null;
    if (open === null) return;
    const checked = TrackSchema.safeParse(open.attributes);
    const segments = checked.success ? locationSegments(checked.data.Location) : null;
    if (!checked.success || segments === null) {
      skippedTracks += 1;
      return;
    }
    if (tracks.length >= MAX_REKORDBOX_TRACKS) {
      truncated = true;
      return;
    }
    const data = checked.data;
    tracks.push({
      name: data.Name,
      artist: data.Artist,
      album: data.Album,
      genre: data.Genre,
      tonality: data.Tonality,
      rating: data.Rating === null ? 0 : Math.max(0, Math.min(5, Math.round(data.Rating / 51))),
      playCount: data.PlayCount === null ? 0 : Math.max(0, Math.round(data.PlayCount)),
      totalTimeSec: data.TotalTime,
      size: data.Size,
      averageBpm: data.AverageBpm === null || data.AverageBpm <= 0 ? null : data.AverageBpm,
      location: data.Location,
      segments,
      tempos: open.badTempo ? [] : open.tempos.toSorted((a, b) => a.inizioSec - b.inizioSec),
      cues: open.cues,
    });
  };

  const take = (tag: Tag) => {
    if (!sawRoot) {
      if (tag.closing || tag.name !== "DJ_PLAYLISTS") throw new ParseStop(NOT_REKORDBOX);
      sawRoot = true;
      return;
    }
    if (tag.name === "COLLECTION") {
      if (tag.closing) {
        finishTrack();
        inCollection = false;
        finished = true;
      } else inCollection = !tag.selfClosing;
      if (tag.selfClosing) finished = true;
      return;
    }
    if (!inCollection) return;
    if (tag.name === "TRACK") {
      if (tag.closing) finishTrack();
      else {
        finishTrack();
        current = { attributes: attributesOf(tag.body), tempos: [], cues: [], badTempo: false };
        if (tag.selfClosing) finishTrack();
      }
      return;
    }
    if (current === null || tag.closing) return;
    if (tag.name === "TEMPO") {
      const tempo = TempoSchema.safeParse(attributesOf(tag.body));
      if (!tempo.success) {
        skippedMarks += 1;
        current.badTempo = true;
        return;
      }
      current.tempos.push({ inizioSec: tempo.data.Inizio, bpm: tempo.data.Bpm, metro: tempo.data.Metro, battito: tempo.data.Battito ?? 1 });
    } else if (tag.name === "POSITION_MARK") {
      const mark = MarkSchema.safeParse(attributesOf(tag.body));
      if (mark.success) current.cues.push(cueOf(mark.data));
      else skippedMarks += 1;
    }
  };

  // `take` sets these; read them through functions, or TypeScript keeps their first values.
  const isFinished = () => finished;
  const hasRoot = () => sawRoot;
  try {
    for await (const chunk of chunks) {
      for (const tag of reader.push(chunk)) {
        take(tag);
        if (isFinished()) break;
      }
      if (isFinished()) break;
    }
  } catch (error) {
    if (error instanceof ParseStop) return { ok: false, error: error.problem };
    throw error;
  }
  if (!hasRoot()) return { ok: false, error: NOT_REKORDBOX };
  if (!isFinished()) return { ok: false, error: malformed(reader.leftover() ? "it stops in the middle of a tag" : "it stops before the collection ends") };
  return { ok: true, library: { tracks, skippedTracks, skippedMarks, truncated } };
}
