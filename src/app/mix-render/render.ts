// The Render of a Mix Plan (ISS-190): the whole set played offline through the app's engine, exactly
// as planned, and handed on as 16-bit PCM segment by segment (to the API, which keeps it for
// download). The plan's tracks are the Learner's own files, decoded here and never uploaded.
//
//   timeline (where each track plays) → mixer commands (through the Execution plan) → segments →
//   for each segment: the track pass for any track it hears first, then the mix pass, then 16-bit PCM.
//
// Memory stays flat however long the set is: a track is decoded, rendered once and its decode
// dropped; its render is dropped once the last segment that hears it is done; a segment is about 2
// minutes. Progress is reported as it goes, and `signal` cancels between steps and inside long
// offline renders.
import { decoderAt } from "@tracks/load-audio.ts";
import type { MixPlan, PlanGrid } from "@shared/mix-plan.ts";
import { mixCommands } from "./commands.ts";
import { renderSegment } from "./mix-pass.ts";
import { PcmEncoder, type RenderLevels } from "./pcm.ts";
import { planSegments, PREROLL_SEC, SEGMENT_TARGET_SEC } from "./segments.ts";
import { setTimeline, type TimelineProblem, type TrackPlayback } from "./timeline.ts";
import { RenderCancelled, renderTrackPlayback, type TrackPassKind, type TrackRender } from "./track-pass.ts";

/** 44.1 kHz: what most libraries are, so most tracks decode without resampling (the spike's advice). */
export const RENDER_SAMPLE_RATE = 44_100;
/** PCM is encoded this many seconds at a time, so the page keeps drawing in between. */
const ENCODE_CHUNK_SEC = 10;

export interface RenderTrackSource {
  /** For messages, e.g. "Kay Grove - Brothers.mp3". */
  readonly name: string;
  /** The file, from the Learner's music folder (or picked by hand). */
  readonly read: () => Promise<Blob>;
}

/** Where the Render's audio goes, in order. */
export interface RenderSink {
  begin(info: { readonly frames: number; readonly sampleRate: number; readonly segments: number }): Promise<void>;
  /** One segment of 16-bit little-endian stereo PCM. */
  segment(index: number, pcm: Uint8Array<ArrayBuffer>): Promise<void>;
}

export interface RenderProgress {
  /** 0…1. */
  readonly fraction: number;
  /** One line, e.g. "Mixing 12:00–14:00 of 61:20". */
  readonly caption: string;
}

/** How each track was played off its own tempo: whether the key held. */
export type MasterTempoNote =
  | { readonly kind: "not-needed" }
  | { readonly kind: "kept" }
  /** Rendered without Master Tempo for these tracks (1-based): the key shifts with tempo. */
  | { readonly kind: "off"; readonly tracks: readonly number[] };

export interface RenderResult {
  readonly frames: number;
  readonly sampleRate: number;
  readonly durationSec: number;
  readonly segments: number;
  readonly levels: RenderLevels;
  readonly masterTempo: MasterTempoNote;
}

export type RenderFailure =
  | { readonly kind: "plan"; readonly problems: readonly TimelineProblem[] }
  | { readonly kind: "track"; readonly track: number; readonly message: string; readonly fix: string }
  | { readonly kind: "sink"; readonly message: string; readonly fix: string }
  | { readonly kind: "cancelled" };

export type RenderOutcome = { readonly ok: true; readonly result: RenderResult } | { readonly ok: false; readonly failure: RenderFailure };

export interface RenderInput {
  readonly plan: MixPlan;
  /** Each track's beat grid, in plan order; `durationSec` is its length. */
  readonly grids: readonly PlanGrid[];
  readonly sources: readonly RenderTrackSource[];
  readonly sink: RenderSink;
  readonly sampleRate?: number;
  /** Key lock for tracks played off their own tempo. Default on; off is the degraded path. */
  readonly masterTempo?: boolean;
  readonly segmentSec?: number;
  readonly onProgress?: (progress: RenderProgress) => void;
  readonly signal?: AbortSignal;
}

class TrackFailure extends Error {
  constructor(readonly failure: Extract<RenderFailure, { kind: "track" }>) {
    super(failure.message);
    this.name = "TrackFailure";
  }
}

class SinkFailure extends Error {
  constructor(readonly failure: Extract<RenderFailure, { kind: "sink" }>) {
    super(failure.message);
    this.name = "SinkFailure";
  }
}

/** "m:ss", as a set's clock reads. */
export function clock(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function decodeTrack(source: RenderTrackSource, index: number, sampleRate: number): Promise<AudioBuffer> {
  const n = String(index + 1);
  let bytes: ArrayBuffer;
  try {
    bytes = await (await source.read()).arrayBuffer();
  } catch (error) {
    console.warn("[mix-render] a track could not be read", { track: index + 1, error });
    throw new TrackFailure({ kind: "track", track: index, message: `Track ${n} ("${source.name}") could not be read from your music folder.`, fix: "Check the file is still there (or find it again on this page), then render again." });
  }
  try {
    return await decoderAt(sampleRate)(bytes);
  } catch (error) {
    console.warn("[mix-render] a track could not be decoded", { track: index + 1, error });
    throw new TrackFailure({ kind: "track", track: index, message: `Track ${n} ("${source.name}") could not be decoded: this browser cannot read its format.`, fix: "Convert it to MP3, AAC or WAV, or pick another track for that place." });
  }
}

/** Renders `plan` into `sink`. Failures are values; only a bug throws. */
export async function renderMixPlan(input: RenderInput): Promise<RenderOutcome> {
  const sampleRate = input.sampleRate ?? RENDER_SAMPLE_RATE;
  const masterTempo = input.masterTempo ?? true;
  const { plan, signal } = input;
  const timed = setTimeline(plan, input.grids);
  if (!timed.ok) return { ok: false, failure: { kind: "plan", problems: timed.problems } };
  const { timeline } = timed;
  const commands = mixCommands(plan, timeline);
  const segments = planSegments(timeline, commands, sampleRate, input.segmentSec ?? SEGMENT_TARGET_SEC);
  const frames = segments.at(-1)?.toFrame ?? 0;
  const count = String(plan.tracks.length);

  // Progress: every set second mixed, and every track second prepared at half that weight.
  const trackSeconds = (track: TrackPlayback) => track.stopSec - track.enterSec;
  const total = timeline.durationSec + 0.5 * timeline.tracks.reduce((sum, track) => sum + trackSeconds(track), 0);
  let done = 0;
  const report = (caption: string) => input.onProgress?.({ fraction: Math.min(1, done / total), caption });
  const checkCancelled = () => {
    if (signal?.aborted === true) throw new RenderCancelled();
  };

  const prepared = new Map<number, TrackRender>();
  const kinds = new Map<number, TrackPassKind>();
  const encoder = new PcmEncoder(sampleRate);

  try {
    try {
      await input.sink.begin({ frames, sampleRate, segments: segments.length });
    } catch (error) {
      throw new SinkFailure({ kind: "sink", message: `The Render could not start saving (${String(error)}).`, fix: "Check the app's server is running (npm run dev), then render again." });
    }
    for (const [segmentIndex, segment] of segments.entries()) {
      const fromSec = segment.fromFrame / sampleRate;
      const toSec = segment.toFrame / sampleRate;
      const heard = timeline.tracks.filter((track) => track.stopSec > fromSec - PREROLL_SEC && track.enterSec < toSec);
      for (const track of heard.filter((each) => !prepared.has(each.index))) {
        checkCancelled();
        const source = input.sources[track.index];
        if (source === undefined) throw new Error(`No source for track ${String(track.index + 1)}: pass one per plan track.`);
        report(`Reading track ${String(track.index + 1)} of ${count} (${source.name})`);
        const decoded = await decodeTrack(source, track.index, sampleRate);
        checkCancelled();
        const offTempo = track.pieces.some((piece) => Math.abs(piece.rate - 1) > 1e-9);
        report(offTempo ? `Playing track ${String(track.index + 1)} of ${count} at the set's tempo${masterTempo ? ", key held" : ""}` : `Preparing track ${String(track.index + 1)} of ${count}`);
        const render = await renderTrackPlayback(decoded, track, { sampleRate, masterTempo, ...(signal === undefined ? {} : { signal }) });
        prepared.set(track.index, render);
        kinds.set(track.index, render.kind);
        done += 0.5 * trackSeconds(track);
      }
      checkCancelled();
      report(`Mixing ${clock(fromSec)}–${clock(toSec)} of ${clock(timeline.durationSec)}`);
      const [left, right] = await renderSegment({
        timeline,
        commands,
        segment,
        sampleRate,
        track: (index) => {
          const render = prepared.get(index);
          if (render === undefined) throw new Error(`Track ${String(index + 1)} was not prepared before the segment that hears it.`);
          return render;
        },
        ...(signal === undefined ? {} : { signal }),
      });
      const pcm = new Uint8Array(left.length * 4);
      const chunk = Math.round(ENCODE_CHUNK_SEC * sampleRate);
      for (let from = 0; from < left.length; from += chunk) {
        pcm.set(encoder.encode(left.subarray(from, from + chunk), right.subarray(from, from + chunk)), from * 4);
        await nextTask();
      }
      checkCancelled();
      try {
        await input.sink.segment(segmentIndex, pcm);
      } catch (error) {
        throw new SinkFailure({ kind: "sink", message: `Saving part ${String(segmentIndex + 1)} of ${String(segments.length)} of the Render failed (${String(error)}).`, fix: "Check the app's server is running, then render again." });
      }
      done += toSec - fromSec;
      for (const track of timeline.tracks) if (track.stopSec <= toSec) prepared.delete(track.index);
    }
  } catch (error) {
    if (error instanceof RenderCancelled) return { ok: false, failure: { kind: "cancelled" } };
    if (error instanceof TrackFailure || error instanceof SinkFailure) return { ok: false, failure: error.failure };
    throw error;
  }

  const offTempo = [...kinds.entries()].filter(([, kind]) => kind === "stretched" || kind === "re-pitched");
  const rePitched = offTempo.filter(([, kind]) => kind === "re-pitched").map(([index]) => index + 1);
  const note: MasterTempoNote = offTempo.length === 0 ? { kind: "not-needed" } : rePitched.length > 0 ? { kind: "off", tracks: rePitched } : { kind: "kept" };
  input.onProgress?.({ fraction: 1, caption: "Rendered" });
  return { ok: true, result: { frames, sampleRate, durationSec: frames / sampleRate, segments: segments.length, levels: encoder.levels(), masterTempo: note } };
}
