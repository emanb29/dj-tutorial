// Exporting the kept final project for posting. SoundCloud takes WAV, FLAC, AIFF, MP3, AAC and Ogg
// (lossless preferred), but not WebM: https://help.soundcloud.com/hc/en-us/articles/360039171614.
// The server transcodes the stored recording with ffmpeg (server/audio-export.ts); this file holds
// what the client and the server share.
import type { FinalProject, LearnerId } from "./learner.ts";

/** `wav` is lossless (what SoundCloud's high-quality streaming needs); `mp3` is 320 kbit/s CBR. */
export const EXPORT_FORMATS = ["wav", "mp3"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUS_PATH = "/api/final-project/export-status";

export type ExportStatus = { readonly available: true } | { readonly available: false; readonly reason: string };

export function finalProjectExportPath(learnerId: LearnerId, format: ExportFormat): string {
  return `/api/learners/${encodeURIComponent(learnerId)}/final-project/export.${format}`;
}

export interface ExportTags {
  readonly title: string;
  readonly artist: string;
  /** The set's track list, one "Artist – Title" line per track. */
  readonly comment: string;
  /** YYYY-MM-DD, the day the set was recorded. */
  readonly date: string;
}

// Tags go to ffmpeg as `key=value` arguments (no shell); drop control characters other than the
// line breaks the track list uses.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const clean = (text: string) => text.replace(CONTROL, "").trim();

/** Title "My first set — <day>", the Learner's name as artist (blank when none is stored), and the track list. */
export function exportTags(project: Pick<FinalProject, "recordedAt" | "tracks">, learnerName = ""): ExportTags {
  const date = project.recordedAt.slice(0, 10);
  return {
    title: `My first set — ${date}`,
    artist: clean(learnerName),
    comment: project.tracks.map((track) => `${clean(track.artist) || "Unknown artist"} – ${clean(track.title)}`).join("\n"),
    date,
  };
}

export function exportFileName(project: Pick<FinalProject, "recordedAt">, format: ExportFormat): string {
  return `dj-tutorial-set-${project.recordedAt.slice(0, 10)}.${format}`;
}
