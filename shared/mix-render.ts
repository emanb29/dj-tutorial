// The Mix Editor's Render on the API (ISS-190): the browser renders a Mix Plan and uploads it as
// 16-bit stereo PCM, segment by segment; the server keeps it on disk and serves it as WAV (the PCM
// behind a header, no transcode) or as 320 kbit/s MP3 (ffmpeg, server/audio-export.ts). The audio is
// the Render's own output, never a track file. This file holds what the client and server share.
import { z } from "zod";
import type { ExportFormat, ExportTags } from "./final-project-export.ts";

export const RENDERS_PATH = "/api/renders";
export const RENDER_SAMPLE_RATES = [44_100, 48_000] as const;
/** Stereo 16-bit: 4 bytes a frame. */
export const RENDER_BYTES_PER_FRAME = 4;
/** The longest Render the server keeps: 3 hours. */
export const MAX_RENDER_SEC = 3 * 60 * 60;
/** A segment upload, at most: about 6 minutes at 48 kHz (a Render's segments are about 2). */
export const MAX_RENDER_SEGMENT_BYTES = 64 * 1024 * 1024;
/**
 * Export caps. The WAV is the kept PCM streamed behind a header, so it is bounded only by the
 * 3-hour Render cap and the WAV format's 4 GB. The MP3 is transcoded: 512 MB is 3 h 40 at 320 kbit/s.
 */
export const RENDER_EXPORT_MAX_BYTES: Readonly<Record<ExportFormat, number>> = { wav: 0xffff_ffff, mp3: 512 * 1024 * 1024 };
const MP3_BYTES_PER_SEC = 320_000 / 8;
const WAV_HEADER_BYTES = 44;
const MAX_TRACKS_LISTED = 500;

const TagText = (max: number) => z.string().max(max);

export const RenderStartSchema = z.strictObject({
  /** The plan's name: the file's title tag and name. */
  name: TagText(120),
  /** One "Artist – Title" per track, for the MP3's comment tag. */
  tracks: z.array(TagText(300)).max(MAX_TRACKS_LISTED),
  sampleRate: z.union(RENDER_SAMPLE_RATES.map((rate) => z.literal(rate))),
  frames: z.int().positive(),
});
export type RenderStart = z.infer<typeof RenderStartSchema>;

export type FormatAvailability = { readonly available: true; readonly bytes: number } | { readonly available: false; readonly reason: string };

export interface RenderSession {
  readonly id: string;
  readonly frames: number;
  readonly sampleRate: number;
  readonly receivedFrames: number;
  readonly complete: boolean;
  readonly formats: Readonly<Record<ExportFormat, FormatAvailability>>;
}

export const renderPath = (id: string) => `${RENDERS_PATH}/${encodeURIComponent(id)}`;
export const renderSegmentPath = (id: string, index: number) => `${renderPath(id)}/segments/${String(index)}`;
export const renderExportPath = (id: string, format: ExportFormat) => `${renderPath(id)}/export.${format}`;

export const wavBytes = (frames: number) => WAV_HEADER_BYTES + frames * RENDER_BYTES_PER_FRAME;
export const mp3Bytes = (frames: number, sampleRate: number) => Math.ceil((frames / sampleRate) * MP3_BYTES_PER_SEC);

/** A 44-byte RIFF/WAVE header for 16-bit stereo PCM of `frames` frames. */
export function wavHeader(frames: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  const dataBytes = frames * RENDER_BYTES_PER_FRAME;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * RENDER_BYTES_PER_FRAME, true);
  view.setUint16(32, RENDER_BYTES_PER_FRAME, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/** A file name from the plan's name: letters, digits and dashes. */
export function renderFileName(name: string, format: ExportFormat): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `${slug === "" ? "mix-plan" : slug}-render.${format}`;
}

// Tags go to ffmpeg as `key=value` arguments (no shell); drop control characters other than line breaks.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const clean = (text: string) => text.replace(CONTROL, "").trim();

export function renderTags(start: Pick<RenderStart, "name" | "tracks">, day: string): ExportTags {
  return { title: clean(start.name) || "Mix plan", artist: "", comment: start.tracks.map(clean).join("\n"), date: day };
}

/** Which formats a Render of this length can be had in, and why not. */
export function renderFormats(frames: number, sampleRate: number, mp3: { readonly available: true } | { readonly available: false; readonly reason: string }): Record<ExportFormat, FormatAvailability> {
  const wav = wavBytes(frames);
  const mp3Size = mp3Bytes(frames, sampleRate);
  return {
    wav: wav <= RENDER_EXPORT_MAX_BYTES.wav ? { available: true, bytes: wav } : { available: false, reason: "The set is too long for a WAV file (over 4 GB). Download the MP3." },
    mp3: !mp3.available
      ? { available: false, reason: mp3.reason }
      : mp3Size <= RENDER_EXPORT_MAX_BYTES.mp3
        ? { available: true, bytes: mp3Size }
        : { available: false, reason: `The MP3 would be over ${String(RENDER_EXPORT_MAX_BYTES.mp3 / 1024 / 1024)} MB. Download the WAV.` },
  };
}
