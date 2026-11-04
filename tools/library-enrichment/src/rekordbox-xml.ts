/**
 * Reads the TRACK entries of a rekordbox collection XML and writes an enriched copy of it.
 *
 * The copy is the original text with some TRACK attributes filled in: every other byte (tempos,
 * cues, playlists, whitespace) is kept, so rekordbox can import it and the app can read it. The
 * format is AlphaTheta's: https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf
 */

export interface CollectionTrack {
  readonly trackId: string;
  /** Decoded attribute values. */
  readonly attributes: Readonly<Record<string, string>>;
  /** Where the TRACK's opening tag is in the text. */
  readonly start: number;
  readonly end: number;
}

export type CollectionRead = { readonly ok: true; readonly tracks: readonly CollectionTrack[] } | { readonly ok: false; readonly error: string };

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    const code = body.startsWith("#x") || body.startsWith("#X") ? Number.parseInt(body.slice(2), 16) : body.startsWith("#") ? Number.parseInt(body.slice(1), 10) : null;
    if (code === null) return ENTITIES[body] ?? whole;
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const encodeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** An opening (or self-closing) TRACK tag; `>` inside quoted values does not end it. */
const TRACK_TAG = /<TRACK\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1];
    if (name !== undefined) attributes[name] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

export function readCollection(xml: string): CollectionRead {
  const open = xml.search(/<COLLECTION\b/);
  const close = xml.indexOf("</COLLECTION>");
  if (!xml.includes("<DJ_PLAYLISTS") || open === -1 || close < open) {
    return { ok: false, error: "That file is not a rekordbox collection XML. Export one from rekordbox (File → Export Collection in xml format) and pass its path." };
  }
  const tracks: CollectionTrack[] = [];
  for (const match of xml.slice(open, close).matchAll(TRACK_TAG)) {
    const attributes = attributesOf(match[0]);
    const trackId = attributes["TrackID"];
    if (trackId === undefined) continue;
    tracks.push({ trackId, attributes, start: open + match.index, end: open + match.index + match[0].length });
  }
  return { ok: true, tracks };
}

function editTag(tag: string, edits: Readonly<Record<string, string>>): string {
  let next = tag;
  for (const [name, value] of Object.entries(edits)) {
    const existing = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
    const encoded = `"${encodeAttribute(value)}"`;
    next = existing.test(next) ? next.replace(existing, (_, prefix: string) => `${prefix}${encoded}`) : next.replace(/\s*(\/?)>$/, (_, slash: string) => ` ${name}=${encoded}${slash === "" ? "" : "/"}>`);
  }
  return next;
}

/** The collection with `edits` (TrackID → attribute → new value) applied. Unknown TrackIDs are ignored. */
export function writeEnriched(xml: string, edits: ReadonlyMap<string, Readonly<Record<string, string>>>): string {
  if (edits.size === 0) return xml;
  const read = readCollection(xml);
  if (!read.ok) return xml;
  let out = "";
  let at = 0;
  for (const track of read.tracks) {
    const trackEdits = edits.get(track.trackId);
    if (trackEdits === undefined) continue;
    out += xml.slice(at, track.start) + editTag(xml.slice(track.start, track.end), trackEdits);
    at = track.end;
  }
  return out + xml.slice(at);
}

// --- Locations ------------------------------------------------------------------------------------

export interface PathMapping {
  readonly from: string;
  readonly to: string;
}

/** `--path-map FROM=TO`, e.g. `E:/=/mnt/e/` when the collection was exported on Windows. */
export function parsePathMap(values: readonly string[]): PathMapping[] {
  const problems = values.filter((value) => !/^[^=]+=.+$/.test(value));
  if (problems.length > 0) throw new Error(`Bad --path-map ${problems.map((value) => `"${value}"`).join(", ")}: write FROM=TO, as in E:/=/mnt/e/.`);
  return values.map((value) => {
    const at = value.indexOf("=");
    return { from: value.slice(0, at), to: value.slice(at + 1) };
  });
}

/** A TRACK's Location as a local path, through the first mapping whose FROM starts it; null if not a file URL. */
export function localPath(location: string, mappings: readonly PathMapping[]): string | null {
  const match = /^file:\/\/(?:localhost)?\/(.*)$/i.exec(location.trim());
  if (match === null) return null;
  let decoded: string;
  try {
    decoded = (match[1] ?? "").split("/").map((part) => decodeURIComponent(part)).join("/").normalize("NFC");
  } catch {
    return null;
  }
  const windows = /^[A-Za-z]:\//.test(decoded);
  const path = windows ? decoded : `/${decoded}`;
  const mapping = mappings.find((each) => path.toLowerCase().startsWith(each.from.toLowerCase()));
  return mapping === undefined ? path : mapping.to + path.slice(mapping.from.length);
}
