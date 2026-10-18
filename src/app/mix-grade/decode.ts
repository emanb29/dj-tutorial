// Reading the one file the Learner picked: bounds first (size, kind, length), then a decode in the
// browser at the analysis rate. Nothing else on the device is read.
import { MIX_RATE, type MixError } from "@analysis/mix/index.ts";
import type { DecodedAudio } from "@analysis/types.ts";
import { MIX_MAX_BYTES, MIX_MAX_SEC, MIX_MIN_SEC } from "@shared/outside-practice.ts";

/** Extensions Chromium decodes, for files the OS gives no type. */
const AUDIO_EXTENSIONS = /\.(mp3|wav|wave|m4a|aac|flac|ogg|oga|opus|weba|aif|aiff)$/i;

const HEADER_TIMEOUT_MS = 5000;

export type FileProblem =
  | { readonly kind: "too-big"; readonly bytes: number }
  | { readonly kind: "not-audio" }
  | { readonly kind: "unreadable" }
  | Extract<MixError, { kind: "too-short" | "too-long" }>;

/** What is wrong with the file before reading it, or null. Video files are refused: audio only. */
export function fileProblem(file: { readonly name: string; readonly size: number; readonly type: string }): FileProblem | null {
  if (file.type.startsWith("video/")) return { kind: "not-audio" };
  if (!file.type.startsWith("audio/") && !AUDIO_EXTENSIONS.test(file.name)) return { kind: "not-audio" };
  if (file.size > MIX_MAX_BYTES) return { kind: "too-big", bytes: file.size };
  if (file.size === 0) return { kind: "unreadable" };
  return null;
}

export function durationProblem(durationSec: number): FileProblem | null {
  if (durationSec < MIX_MIN_SEC) return { kind: "too-short", durationSec, minimumSec: MIX_MIN_SEC };
  if (durationSec > MIX_MAX_SEC) return { kind: "too-long", durationSec, maximumSec: MIX_MAX_SEC };
  return null;
}

export function fileProblemText(problem: FileProblem): string {
  switch (problem.kind) {
    case "too-big":
      return `That's ${String(Math.round(problem.bytes / 1024 / 1024))} MB. Up to ${String(MIX_MAX_BYTES / 1024 / 1024)} MB: export it as MP3.`;
    case "not-audio":
      return "That isn't an audio file. Pick the mix's MP3, WAV, M4A or FLAC.";
    case "unreadable":
      return "Couldn't read that file as audio. Export the mix again and pick that.";
    case "too-short":
      return `That's ${String(Math.round(problem.durationSec))} s. Pick a mix of at least ${String(MIX_MIN_SEC)} s.`;
    case "too-long":
      return `That's ${String(Math.round(problem.durationSec / 60))} min. Up to ${String(MIX_MAX_SEC / 60)} min: trim it or pick a shorter one.`;
  }
}

/** The file's length from its header, without decoding it; null when the browser can't tell. */
function headerDuration(file: Blob, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let finished = false;
    const done = (value: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };
    // Some files never say: then the decode finds out.
    const timer = setTimeout(() => {
      done(null);
    }, HEADER_TIMEOUT_MS);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      done(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => {
      done(null);
    };
    signal.addEventListener("abort", () => {
      done(null);
    }, { once: true });
    audio.src = url;
  });
}

export type Decoded = { readonly ok: true; readonly audio: DecodedAudio } | { readonly ok: false; readonly problem: FileProblem | { readonly kind: "aborted" } };

/**
 * Decodes the mix at MIX_RATE (the analysis rate; it halves the memory a 44.1 kHz decode needs).
 * A file the header says is too long is refused before it is decoded.
 */
export async function decodeMix(file: File, signal: AbortSignal): Promise<Decoded> {
  // A function, so the check after each await is not narrowed away.
  const aborted = () => signal.aborted;
  const early = fileProblem(file);
  if (early !== null) return { ok: false, problem: early };
  const length = await headerDuration(file, signal);
  if (aborted()) return { ok: false, problem: { kind: "aborted" } };
  const tooLong = length === null ? null : durationProblem(length);
  if (tooLong?.kind === "too-long") return { ok: false, problem: tooLong };
  let buffer: AudioBuffer;
  try {
    buffer = await new OfflineAudioContext(2, 1, MIX_RATE).decodeAudioData(await file.arrayBuffer());
  } catch (error) {
    console.warn("[mix] the file could not be decoded", error);
    return { ok: false, problem: { kind: "unreadable" } };
  }
  if (aborted()) return { ok: false, problem: { kind: "aborted" } };
  const problem = durationProblem(buffer.duration);
  if (problem !== null) return { ok: false, problem };
  // Copies: the worker takes these over, and an AudioBuffer's own arrays cannot be handed over.
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice());
  return { ok: true, audio: { channels, sampleRate: buffer.sampleRate } };
}
