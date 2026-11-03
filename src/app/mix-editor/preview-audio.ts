// A Transition's preview as Web Audio: each track through its own EQ, filter, fader and echo send,
// automated sample-accurately from the schedule (preview-schedule.ts). It runs on any BaseAudioContext,
// so a browser test renders it offline; PreviewPlayer plays it live and follows edits.
//
// The preview has its own small graph instead of the Lessons' engine: it never touches the decks, so the
// FLX4 stays the source of truth while it plays, and nothing needs adopting again when it stops.
import { PREVIEW_ECHO_FEEDBACK, previewSchedule, type ParamPoint, type PreviewGrids, type PreviewSchedule, type TrackSchedule } from "./preview-schedule.ts";
import type { Transition } from "@shared/mix-plan.ts";
import { transitionFocus } from "./timeline.ts";

const LOW_SHELF_HZ = 250;
const MID_PEAK_HZ = 1000;
const HIGH_SHELF_HZ = 2500;
const FILTER_Q_DB = 1;
/** Scheduling a little ahead, so the first values are in place before the sound starts. */
const LEAD_SEC = 0.05;

export interface PreviewBuffers {
  readonly outgoing: AudioBuffer;
  readonly incoming: AudioBuffer;
}

export interface ScheduledPreview {
  /** Context time of the schedule's first beat. */
  readonly startCtx: number;
  readonly endCtx: number;
  /** The Transition beat heard at a context time. */
  beatAt(ctxTime: number): number;
  stop(): void;
}

function automate(param: AudioParam, points: readonly ParamPoint[], timeOf: (beat: number) => number): void {
  const [first, ...rest] = points;
  if (first === undefined) return;
  param.setValueAtTime(first.value, timeOf(first.beat));
  let previous = first;
  for (const point of rest) {
    if (point.beat === previous.beat) param.setValueAtTime(point.value, timeOf(point.beat));
    else param.linearRampToValueAtTime(point.value, timeOf(point.beat));
    previous = point;
  }
}

function trackGraph(context: BaseAudioContext, track: TrackSchedule, buffer: AudioBuffer, destination: AudioNode, timeOf: (beat: number) => number): () => void {
  const input = new GainNode(context);
  const low = new BiquadFilterNode(context, { type: "lowshelf", frequency: LOW_SHELF_HZ });
  const mid = new BiquadFilterNode(context, { type: "peaking", frequency: MID_PEAK_HZ, Q: Math.SQRT1_2 });
  const high = new BiquadFilterNode(context, { type: "highshelf", frequency: HIGH_SHELF_HZ });
  const lowPass = new BiquadFilterNode(context, { type: "lowpass", Q: FILTER_Q_DB });
  const highPass = new BiquadFilterNode(context, { type: "highpass", Q: FILTER_Q_DB });
  const fader = new GainNode(context, { gain: 0 });
  input.connect(low).connect(mid).connect(high).connect(lowPass).connect(highPass).connect(fader).connect(destination);
  const nodes: AudioNode[] = [input, low, mid, high, lowPass, highPass, fader];
  automate(low.gain, track.lowDb, timeOf);
  automate(mid.gain, track.midDb, timeOf);
  automate(high.gain, track.highDb, timeOf);
  automate(lowPass.frequency, track.lowPassHz, timeOf);
  automate(highPass.frequency, track.highPassHz, timeOf);
  automate(fader.gain, track.gain, timeOf);
  if (track.echoDelaySec !== null) {
    const send = new GainNode(context, { gain: 0 });
    const delay = new DelayNode(context, { delayTime: track.echoDelaySec, maxDelayTime: Math.max(1, track.echoDelaySec) });
    const feedback = new GainNode(context, { gain: PREVIEW_ECHO_FEEDBACK });
    fader.connect(send).connect(delay).connect(destination);
    delay.connect(feedback).connect(delay);
    automate(send.gain, track.echoSend, timeOf);
    nodes.push(send, delay, feedback);
  }
  const sources = track.segments.map((segment) => {
    const source = new AudioBufferSourceNode(context, { buffer });
    automate(
      source.playbackRate,
      track.rate.filter((point) => point.beat >= segment.startBeat && point.beat <= segment.endBeat),
      timeOf,
    );
    source.connect(input);
    if (segment.offsetSec < buffer.duration) {
      source.start(timeOf(segment.startBeat), segment.offsetSec);
      source.stop(timeOf(segment.endBeat));
    }
    return source;
  });
  return () => {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Never started (past the file's end): nothing to stop.
      }
      source.disconnect();
    }
    for (const node of nodes) node.disconnect();
  };
}

/** Schedules `schedule` on `context`, its first beat at `startCtx`. */
export function schedulePreview(
  context: BaseAudioContext,
  schedule: PreviewSchedule,
  buffers: PreviewBuffers,
  options: { readonly destination?: AudioNode; readonly startCtx?: number } = {},
): ScheduledPreview {
  const destination = options.destination ?? context.destination;
  const startCtx = options.startCtx ?? context.currentTime + LEAD_SEC;
  const timeOf = (beat: number) => startCtx + (beat - schedule.fromBeat) * schedule.secPerBeat;
  const stops = [
    trackGraph(context, schedule.outgoing, buffers.outgoing, destination, timeOf),
    trackGraph(context, schedule.incoming, buffers.incoming, destination, timeOf),
  ];
  return {
    startCtx,
    endCtx: timeOf(schedule.toBeat),
    beatAt: (ctxTime) => schedule.fromBeat + (ctxTime - startCtx) / schedule.secPerBeat,
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}

export type PreviewState = { readonly kind: "stopped" } | { readonly kind: "playing"; readonly transition: number; readonly loop: boolean };

interface Playing {
  readonly transitionIndex: number;
  readonly grids: PreviewGrids;
  readonly buffers: PreviewBuffers;
  scheduled: ScheduledPreview;
  transition: Transition;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Plays one Transition's preview live, at most one at a time. `update` re-schedules it from the beat
 * being heard, so the preview follows edits; with the loop on it starts again at the end.
 */
export class PreviewPlayer {
  private context: AudioContext | null = null;
  private playing: Playing | null = null;
  private loop = false;
  private readonly listeners = new Set<() => void>();
  private state: PreviewState = { kind: "stopped" };

  /** The context, made on first use (inside the click or key that asked for sound). */
  audioContext(): AudioContext {
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    return this.context;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): PreviewState => this.state;

  /** The Transition beat being heard, or null while stopped. */
  beatNow(): number | null {
    const playing = this.playing;
    if (playing === null || this.context === null) return null;
    return playing.scheduled.beatAt(this.context.currentTime);
  }

  async play(transitionIndex: number, transition: Transition, grids: PreviewGrids, buffers: PreviewBuffers): Promise<void> {
    this.stop();
    const context = this.audioContext();
    if (context.state !== "running") await context.resume();
    const playing: Playing = { transitionIndex, grids, buffers, transition, timer: null, scheduled: schedulePreview(context, previewSchedule(transition, grids), buffers) };
    this.playing = playing;
    this.armEnd(playing);
    this.publish();
  }

  /** The edited Transition, heard from where the preview is now (or from the start once past its end). */
  update(transitionIndex: number, transition: Transition): void {
    const playing = this.playing;
    if (playing?.transitionIndex !== transitionIndex || playing.transition === transition || this.context === null) return;
    const focus = transitionFocus(transition);
    const now = playing.scheduled.beatAt(this.context.currentTime);
    const from = now >= focus.toBeat || now < focus.fromBeat ? focus.fromBeat : now;
    playing.scheduled.stop();
    playing.transition = transition;
    playing.scheduled = schedulePreview(this.context, previewSchedule(transition, playing.grids, { fromBeat: from, toBeat: focus.toBeat }), playing.buffers);
    this.armEnd(playing);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.publish();
  }

  stop(): void {
    const playing = this.playing;
    if (playing === null) return;
    if (playing.timer !== null) clearTimeout(playing.timer);
    playing.scheduled.stop();
    this.playing = null;
    this.publish();
  }

  async close(): Promise<void> {
    this.stop();
    await this.context?.close();
    this.context = null;
  }

  private armEnd(playing: Playing): void {
    if (playing.timer !== null) clearTimeout(playing.timer);
    const context = this.context;
    if (context === null) return;
    const left = Math.max(0, playing.scheduled.endCtx - context.currentTime);
    playing.timer = setTimeout(() => {
      if (this.playing !== playing) return;
      if (!this.loop) {
        this.stop();
        return;
      }
      playing.scheduled.stop();
      playing.scheduled = schedulePreview(context, previewSchedule(playing.transition, playing.grids), playing.buffers);
      this.armEnd(playing);
    }, left * 1000);
  }

  private publish(): void {
    const playing = this.playing;
    this.state = playing === null ? { kind: "stopped" } : { kind: "playing", transition: playing.transitionIndex, loop: this.loop };
    for (const listener of this.listeners) listener();
  }
}
