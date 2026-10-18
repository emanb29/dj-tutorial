// Audible jog search on a paused deck, as a CDJ scrubs: each search plays a short grain of the audio the
// playhead just moved over, sped up or slowed down so the grain lasts about as long as the jog took to
// move, and backwards when the jog turns back. Grains chain: a new one fades in while the one before
// fades out. When the jog stops, no more grains come and the last one ends within SCRUB_GRAIN_MAX_SEC.
//
// The grains go into the deck's output, the same node as its voices, so the channel strip (trim, EQ,
// fader, crossfader and headphone CUE) shapes them as it shapes playback. Pitch follows the scrub speed,
// as on a record or a CDJ in vinyl mode, whether or not Master Tempo is on.

import type { CtxTime } from "./types.ts";

/** How long a grain lasts when there is no search before it to time it by (the jog just started). */
export const SCRUB_GRAIN_SEC = 0.03;
/** A grain never lasts longer than this: a jog that stopped goes quiet this soon. */
export const SCRUB_GRAIN_MAX_SEC = 0.08;
/** Speed limits for a grain: slower is a drone, faster is a chirp with nothing to hear in it. */
export const SCRUB_MIN_RATE = 0.25;
export const SCRUB_MAX_RATE = 4;
/** Fade at each end of a grain, so grains join without clicks. */
export const SCRUB_FADE_SEC = 0.003;

interface Grain {
  readonly source: AudioBufferSourceNode;
  readonly level: GainNode;
  readonly endsAt: CtxTime;
}

export class ScrubVoice {
  private grain: Grain | null = null;
  private lastSearchCtx: CtxTime | null = null;

  constructor(
    private readonly context: BaseAudioContext,
    private readonly buffer: AudioBuffer,
    private readonly output: AudioNode,
  ) {}

  /** The playhead moved from `fromSec` to `toSec` at `when`: play what it moved over, ending at `toSec`. */
  scrub(when: CtxTime, fromSec: number, toSec: number): void {
    const sinceLast = this.lastSearchCtx === null ? Number.POSITIVE_INFINITY : when - this.lastSearchCtx;
    this.lastSearchCtx = when;
    const moved = toSec - fromSec;
    if (moved === 0) return;
    const duration = sinceLast > SCRUB_GRAIN_MAX_SEC ? SCRUB_GRAIN_SEC : Math.max(SCRUB_FADE_SEC * 4, sinceLast);
    const rate = Math.min(SCRUB_MAX_RATE, Math.max(SCRUB_MIN_RATE, Math.abs(moved) / duration));
    // The grain always ends where the playhead now is, so what is heard last is what the cue would set.
    const span = rate * duration;
    const forward = moved > 0;
    const segment = forward ? { from: Math.max(0, toSec - span), to: toSec } : { from: toSec, to: Math.min(this.buffer.duration, toSec + span) };
    if (segment.to - segment.from <= 0) return;
    this.play(when, this.segmentBuffer(segment.from, segment.to, !forward), rate);
  }

  /** Ends any grain at `when` (the deck starts playing, or the track is replaced). */
  stop(when: CtxTime): void {
    this.lastSearchCtx = null;
    const grain = this.grain;
    this.grain = null;
    if (grain === null || grain.endsAt <= when) return;
    fadeOut(grain, when);
  }

  private play(when: CtxTime, buffer: AudioBuffer, rate: number): void {
    const length = buffer.duration / rate;
    const level = new GainNode(this.context, { gain: 0 });
    const source = new AudioBufferSourceNode(this.context, { buffer, playbackRate: rate });
    source.connect(level).connect(this.output);
    source.onended = () => {
      source.disconnect();
      level.disconnect();
    };
    const fade = Math.min(SCRUB_FADE_SEC, length / 2);
    level.gain.setValueAtTime(0, when);
    level.gain.linearRampToValueAtTime(1, when + fade);
    level.gain.setValueAtTime(1, when + length - fade);
    level.gain.linearRampToValueAtTime(0, when + length);
    source.start(when);
    source.stop(when + length);
    const before = this.grain;
    if (before !== null && before.endsAt > when) fadeOut(before, when);
    this.grain = { source, level, endsAt: when + length };
  }

  /** A copy of the track between two positions, reversed for a backward scrub. */
  private segmentBuffer(fromSec: number, toSec: number, reversed: boolean): AudioBuffer {
    const sampleRate = this.buffer.sampleRate;
    const first = Math.floor(fromSec * sampleRate);
    const end = Math.max(first + 1, Math.min(this.buffer.length, Math.ceil(toSec * sampleRate)));
    const copy = new AudioBuffer({ length: end - first, numberOfChannels: this.buffer.numberOfChannels, sampleRate });
    for (let channel = 0; channel < this.buffer.numberOfChannels; channel++) {
      const data = this.buffer.getChannelData(channel).slice(first, end);
      if (reversed) data.reverse();
      copy.copyToChannel(data, channel);
    }
    return copy;
  }
}

function fadeOut(grain: Grain, when: CtxTime): void {
  // Held at whatever the envelope reaches at `when` (which is ahead of now), then faded from there.
  grain.level.gain.cancelAndHoldAtTime(when);
  grain.level.gain.linearRampToValueAtTime(0, when + SCRUB_FADE_SEC);
  grain.source.stop(when + SCRUB_FADE_SEC);
}
