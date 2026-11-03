// The Render's track pass (ISS-190): one track's whole playback in the set (its tempo, tempo rides and
// loops, from timeline.ts), rendered once, before any mixing. The mix pass then plays the result at
// its own speed with Master Tempo off, which is what lets it split the set into segments with no
// seam (docs/research/offline-master-tempo.md: the stretcher cannot continue from a snapshot).
//
// Three ways, cheapest first:
// - copied: the track plays at its own tempo with no loop, so its samples are the playback;
// - looped: at its own tempo, with a loop: sources, wrapping where the loop does;
// - stretched (Master Tempo on): signalsmith-stretch, alone in one offline render, following the
//   timeline as its time map, so the key holds at any tempo;
// - re-pitched (Master Tempo off, or the stretcher failed to load): sources at the playback rate, so
//   the key moves with the tempo, as on a deck with Master Tempo off.
// Loop wraps and the track's first and last moments get a short fade, so nothing clicks.
import SignalsmithStretch from "signalsmith-stretch";
import type { PlaybackPiece, TrackPlayback } from "./timeline.ts";

export type TrackPassKind = "copied" | "looped" | "stretched" | "re-pitched";

export interface TrackRender {
  readonly index: number;
  /** The playback from `firstFrame` (a set frame) on, stereo at the Render's rate. Any context at that rate can play it. */
  readonly buffer: AudioBuffer;
  readonly firstFrame: number;
  readonly kind: TrackPassKind;
}

export interface TrackPassOptions {
  readonly sampleRate: number;
  /** Key lock: stretch rather than re-pitch a track played off its own tempo. */
  readonly masterTempo: boolean;
  readonly signal?: AbortSignal;
}

/** Fades at a loop's wrap and at the track's ends. */
export const EDGE_FADE_SEC = 0.004;
/**
 * Silence after the playback's end. A source that ends is disconnected when its \`ended\` event
 * reaches the main thread, which in an offline render comes at no fixed sample; the mixer's filters
 * still ringing then would be cut at a different sample in each render. Zeros keep them fed until
 * they are quiet.
 */
export const END_PAD_SEC = 0.05;
/** The stretcher compensates its latency only for changes this far ahead (it measured 0.12 s). */
const STRETCH_LEAD_SEC = 0.5;
/** A long offline render stops here to see whether it was cancelled. */
const CANCEL_CHECK_SEC = 5;

export class RenderCancelled extends Error {
  constructor() {
    super("The Render was cancelled.");
    this.name = "RenderCancelled";
  }
}

const isJumpBetween = (piece: PlaybackPiece, next: PlaybackPiece) => Math.abs(piece.trackSec + (piece.toSec - piece.fromSec) * piece.rate - next.trackSec) > 1e-6;

/** Runs of pieces that play on without a jump (a loop wrap starts a new run). */
function runsOf(pieces: readonly PlaybackPiece[]): PlaybackPiece[][] {
  const runs: PlaybackPiece[][] = [];
  for (const [index, piece] of pieces.entries()) {
    const previous = pieces[index - 1];
    const run = runs.at(-1);
    if (run === undefined || previous === undefined || isJumpBetween(previous, piece)) runs.push([piece]);
    else run.push(piece);
  }
  return runs;
}

function channelsOf(decoded: AudioBuffer): [Float32Array, Float32Array] {
  return [decoded.getChannelData(0), decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1))];
}

/** A short linear fade in at the start and out at the end of the playback, and silence after it. */
function fadeEdges(channels: readonly Float32Array[], sampleRate: number, playedLength: number): void {
  const fade = Math.round(EDGE_FADE_SEC * sampleRate);
  for (const data of channels) {
    for (let index = 0; index < Math.min(fade, playedLength); index++) {
      const gain = index / fade;
      data[index] = (data[index] ?? 0) * gain;
      data[playedLength - 1 - index] = (data[playedLength - 1 - index] ?? 0) * gain;
    }
    data.fill(0, playedLength);
  }
}

/**
 * Renders an OfflineAudioContext, stopping every few seconds of output to check `signal`. A cancelled
 * render is left suspended (a suspended offline context is garbage once dropped) and rejects.
 */
export function renderCancellable(context: OfflineAudioContext, signal: AbortSignal | undefined, everySec = CANCEL_CHECK_SEC): Promise<AudioBuffer> {
  if (signal === undefined) return context.startRendering();
  return new Promise((resolve, reject) => {
    const check = (time: number) => {
      if (time >= context.length / context.sampleRate) return;
      void context.suspend(time).then(() => {
        if (signal.aborted) {
          reject(new RenderCancelled());
          return;
        }
        check(time + everySec);
        void context.resume();
      });
    };
    check(everySec);
    context.startRendering().then(resolve, reject);
  });
}

function copied(decoded: AudioBuffer, playback: TrackPlayback, firstFrame: number, length: number, sampleRate: number): AudioBuffer {
  const piece = playback.pieces[0];
  const source = channelsOf(decoded);
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  if (piece === undefined) return buffer;
  const out = [buffer.getChannelData(0), buffer.getChannelData(1)];
  // The track sample heard at set frame `firstFrame`: rate 1 throughout, so one offset holds.
  const offset = Math.round((piece.trackSec - piece.fromSec) * sampleRate) + firstFrame;
  for (const [channel, data] of out.entries()) {
    const from = source[channel] ?? source[0];
    const start = Math.max(0, offset);
    const end = Math.min(from.length, offset + length);
    if (end > start) data.set(from.subarray(start, end), start - offset);
  }
  return buffer;
}

async function rePitched(decoded: AudioBuffer, playback: TrackPlayback, firstFrame: number, length: number, options: TrackPassOptions): Promise<AudioBuffer> {
  const { sampleRate } = options;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const base = firstFrame / sampleRate;
  const runs = runsOf(playback.pieces);
  for (const [index, run] of runs.entries()) {
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) continue;
    const source = new AudioBufferSourceNode(context, { buffer: decoded, playbackRate: first.rate });
    for (const piece of run.slice(1)) source.playbackRate.setValueAtTime(piece.rate, piece.fromSec - base);
    const level = new GainNode(context, { gain: index === 0 ? 1 : 0 });
    source.connect(level).connect(context.destination);
    const start = first.fromSec - base;
    const end = last.toSec - base;
    // A wrap crossfades: this run fades in as the one before it fades out, playing on past its loop end.
    if (index > 0) level.gain.setValueAtTime(0, start).linearRampToValueAtTime(1, start + EDGE_FADE_SEC);
    const lastRun = index === runs.length - 1;
    if (!lastRun) level.gain.setValueAtTime(1, end).linearRampToValueAtTime(0, end + EDGE_FADE_SEC);
    source.start(start, first.trackSec);
    source.stop(lastRun ? end : end + EDGE_FADE_SEC);
  }
  return renderCancellable(context, options.signal);
}

/** One change of the stretcher's time map: from `fromSec` (set seconds), `trackSec` on at `rate`. */
export interface StretchEntry {
  readonly fromSec: number;
  readonly trackSec: number;
  readonly rate: number;
}

/**
 * The stretcher's time map for a playback, with no change closer than `minSec` to the next. The
 * worklet keeps one pending change (a new one drops any that has not started), so each is sent
 * after the one before has started and still a latency ahead of its own time. A tempo ramp's short
 * steps merge (the rate over each merged step keeps the track position exact at its ends); a loop
 * shorter than `minSec` cannot be scheduled, which gives null.
 */
export function stretchMap(pieces: readonly PlaybackPiece[], minSec: number): StretchEntry[] | null {
  const runs = runsOf(pieces);
  const entries: StretchEntry[] = [];
  for (const [index, run] of runs.entries()) {
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) continue;
    const runEnd = last.toSec;
    if (index < runs.length - 1 && runEnd - first.fromSec < minSec) return null;
    // A change starts at a piece far enough from the last change, and from the run's end.
    const starts: PlaybackPiece[] = [];
    for (const piece of run) {
      const previous = starts.at(-1);
      if (previous === undefined || (piece.fromSec - previous.fromSec >= minSec && runEnd - piece.fromSec >= minSec)) starts.push(piece);
    }
    for (const [at, start] of starts.entries()) {
      const next = starts[at + 1];
      const endSec = next?.fromSec ?? runEnd;
      const endTrackSec = next?.trackSec ?? last.trackSec + (runEnd - last.fromSec) * last.rate;
      entries.push({ fromSec: start.fromSec, trackSec: start.trackSec, rate: (endTrackSec - start.trackSec) / (endSec - start.fromSec) });
    }
  }
  return entries;
}

/** No stretcher change closer than this to the next (its latency, about 0.12 s, plus room). */
const STRETCH_ENTRY_MIN_SEC = 0.35;
const RENDER_QUANTUM = 128;

class StretchUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StretchUnsupported";
  }
}

async function stretched(decoded: AudioBuffer, playback: TrackPlayback, firstFrame: number, length: number, options: TrackPassOptions): Promise<AudioBuffer> {
  const { sampleRate, signal } = options;
  const entries = stretchMap(playback.pieces, STRETCH_ENTRY_MIN_SEC);
  if (entries === null) throw new StretchUnsupported(`Track ${String(playback.index + 1)} has a loop shorter than ${String(STRETCH_ENTRY_MIN_SEC)} s, which the stretcher cannot schedule.`);
  const leadFrames = Math.round(STRETCH_LEAD_SEC * sampleRate);
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: leadFrames + length, sampleRate });
  const node = await SignalsmithStretch(context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  const latency = await node.latency();
  const ahead = latency + 2 * (RENDER_QUANTUM / sampleRate);
  if (ahead >= STRETCH_ENTRY_MIN_SEC - 0.05) throw new Error(`The stretcher's latency (${String(latency)} s) leaves no room between time-map changes: raise STRETCH_ENTRY_MIN_SEC.`);
  const channels = channelsOf(decoded).map((data) => data.slice());
  await node.addBuffers(channels, channels.map((data) => data.buffer));
  node.connect(context.destination);

  // Output times run from the lead (dropped below), so the first change is a latency ahead too.
  const outputOf = (sec: number) => leadFrames / sampleRate + sec - firstFrame / sampleRate;
  const changes = [
    ...entries.map((entry) => ({ output: outputOf(entry.fromSec), input: entry.trackSec, rate: entry.rate, active: true })),
    { output: outputOf(playback.stopSec), active: false },
  ];
  const [first, ...later] = changes;
  if (first !== undefined) await node.schedule(first);
  // Each later change is sent a latency ahead of its time, at a render quantum; a cancel check every few seconds.
  const sends = new Map<number, (typeof changes)[number][]>();
  const at = (time: number) => Math.max(RENDER_QUANTUM, Math.floor((time * sampleRate) / RENDER_QUANTUM) * RENDER_QUANTUM);
  for (const change of later) sends.set(at(change.output - ahead), [...(sends.get(at(change.output - ahead)) ?? []), change]);
  for (let time = CANCEL_CHECK_SEC; time < (leadFrames + length) / sampleRate; time += CANCEL_CHECK_SEC) if (!sends.has(at(time))) sends.set(at(time), []);
  const rendered = await new Promise<AudioBuffer>((resolve, reject) => {
    for (const [frame, batch] of sends) {
      if (frame >= leadFrames + length) continue;
      context
        .suspend(frame / sampleRate)
        .then(async () => {
          if (signal?.aborted === true) throw new RenderCancelled();
          for (const change of batch) await node.schedule(change);
          await context.resume();
        })
        .catch(reject);
    }
    context.startRendering().then(resolve, reject);
  });
  node.disconnect();
  const out = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  for (const channel of [0, 1]) out.copyToChannel(rendered.getChannelData(channel).subarray(leadFrames, leadFrames + length), channel);
  return out;
}

/**
 * One track's playback, from its first set frame to its stop, at the Render's sample rate
 * (`decoded` must be decoded at it). Master Tempo falls back to re-pitching if the stretcher fails;
 * `kind` says which ran.
 */
export async function renderTrackPlayback(decoded: AudioBuffer, playback: TrackPlayback, options: TrackPassOptions): Promise<TrackRender> {
  const { sampleRate } = options;
  if (decoded.sampleRate !== sampleRate) throw new Error(`Track ${String(playback.index + 1)} is decoded at ${String(decoded.sampleRate)} Hz but the Render runs at ${String(sampleRate)} Hz: decode it with decoderAt(${String(sampleRate)}).`);
  const firstFrame = Math.floor(playback.enterSec * sampleRate);
  const playedLength = Math.max(1, Math.ceil(playback.stopSec * sampleRate) - firstFrame);
  const length = playedLength + Math.round(END_PAD_SEC * sampleRate);
  const offTempo = playback.pieces.some((piece) => Math.abs(piece.rate - 1) > 1e-9);
  const looped = runsOf(playback.pieces).length > 1;
  const finish = (buffer: AudioBuffer, kind: TrackPassKind): TrackRender => {
    fadeEdges([buffer.getChannelData(0), buffer.getChannelData(1)], sampleRate, playedLength);
    return { index: playback.index, buffer, firstFrame, kind };
  };

  if (!offTempo && !looped) return finish(copied(decoded, playback, firstFrame, length, sampleRate), "copied");
  if (offTempo && options.masterTempo) {
    try {
      return finish(await stretched(decoded, playback, firstFrame, length, options), "stretched");
    } catch (error) {
      if (error instanceof RenderCancelled) throw error;
      // Recovered: the track still plays, with the key moving with the tempo; the result says so.
      console.warn("[mix-render] the stretcher failed, so this track is re-pitched (Master Tempo off)", { track: playback.index + 1, error });
    }
  }
  return finish(await rePitched(decoded, playback, firstFrame, length, options), offTempo ? "re-pitched" : "looped");
}
