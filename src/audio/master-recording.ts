// The master recording for the final project (docs/lesson-catalogue.md "Final project"): what the
// audience hears (the master bus, post master level), compressed by MediaRecorder as it plays. Only
// this: a general set recorder is out of v1. The engine owns it (AudioEngine.recordMaster), so the
// tap sits on the same bus the meters read; nothing here plays anything.
//
// Memory stays bounded: chunks are compressed (about 160 kbit/s, 1.2 MB a minute) and the recording
// stops taking chunks past `maxBytes`, marking itself truncated.
import { fail, type Result } from "./result.ts";

/** Preferred first: AAC in MP4 uploads anywhere; Opus in Ogg or WebM is what Chromium and Firefox always have. */
export const RECORDING_FORMATS = ["audio/mp4;codecs=mp4a.40.2", "audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"] as const;
export const RECORDING_BITS_PER_SECOND = 160_000;
const CHUNK_MS = 1_000;

/** The first format the browser's MediaRecorder can write, or null. */
export function pickRecordingFormat(isTypeSupported: (type: string) => boolean): (typeof RECORDING_FORMATS)[number] | null {
  return RECORDING_FORMATS.find((type) => isTypeSupported(type)) ?? null;
}

/** The container a format string names, without codecs: what the server and a file extension need. */
export function containerOf(mimeType: string): "audio/mp4" | "audio/ogg" | "audio/webm" | null {
  const base = mimeType.split(";")[0]?.trim().toLowerCase();
  return base === "audio/mp4" || base === "audio/ogg" || base === "audio/webm" ? base : null;
}

export function fileExtensionOf(mimeType: string): string {
  const container = containerOf(mimeType);
  return container === "audio/mp4" ? "m4a" : container === "audio/ogg" ? "ogg" : "webm";
}

export interface FinishedRecording {
  readonly blob: Blob;
  /** The container, e.g. `audio/webm`. */
  readonly mimeType: "audio/mp4" | "audio/ogg" | "audio/webm";
  readonly durationSec: number;
  /** It reached `maxBytes` and stopped keeping audio before the set ended. */
  readonly truncated: boolean;
}

/** A running master recording. */
export class MasterRecording {
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private truncated = false;
  private readonly startedMs = performance.now();
  private readonly finished: Promise<void>;

  constructor(
    private readonly recorder: MediaRecorder,
    private readonly mimeType: FinishedRecording["mimeType"],
    private readonly maxBytes: number,
    private readonly detach: () => void,
  ) {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0 || this.truncated) return;
      if (this.bytes + event.data.size > this.maxBytes) {
        this.truncated = true;
        console.warn(`[audio] the master recording reached ${String(maxBytes)} bytes; the rest of the set is not recorded`);
        return;
      }
      this.chunks.push(event.data);
      this.bytes += event.data.size;
    });
    this.finished = new Promise((resolve) => {
      recorder.addEventListener("stop", () => {
        resolve();
      }, { once: true });
    });
    recorder.start(CHUNK_MS);
  }

  /** Stops and returns the file. Calling it again returns the same file. */
  async stop(): Promise<FinishedRecording> {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.finished;
    this.detach();
    return {
      blob: new Blob(this.chunks, { type: this.mimeType }),
      mimeType: this.mimeType,
      durationSec: (performance.now() - this.startedMs) / 1000,
      truncated: this.truncated,
    };
  }
}

/** Starts recording `source` (the master bus). Typed errors: no MediaRecorder, or no format it can write. */
export function startMasterRecording(context: BaseAudioContext, source: AudioNode, maxBytes: number): Result<{ recording: MasterRecording }> {
  if (!(context instanceof AudioContext) || typeof MediaRecorder === "undefined") {
    return fail({ kind: "recording-unsupported", reason: "this browser (or an offline render) has no MediaRecorder for audio" });
  }
  const format = pickRecordingFormat((type) => MediaRecorder.isTypeSupported(type));
  const container = format === null ? null : containerOf(format);
  if (format === null || container === null) {
    return fail({ kind: "recording-unsupported", reason: `MediaRecorder writes none of ${RECORDING_FORMATS.join(", ")}` });
  }
  const destination = context.createMediaStreamDestination();
  source.connect(destination);
  const recorder = new MediaRecorder(destination.stream, { mimeType: format, audioBitsPerSecond: RECORDING_BITS_PER_SECOND });
  const detach = () => {
    source.disconnect(destination);
    for (const track of destination.stream.getTracks()) track.stop();
  };
  return { ok: true, recording: new MasterRecording(recorder, container, maxBytes, detach) };
}
