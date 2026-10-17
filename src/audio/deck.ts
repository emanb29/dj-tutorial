// One deck: a loaded track, its transport, tempo, Master Tempo, jog bend and cue point.
// Every change is first written to the track's PlayheadTracker (which may refuse it with a typed error)
// and only then sent to the voice, so what is heard and what the model says cannot diverge.

import type { StretchNode } from "signalsmith-stretch";
import type { BeatGrid } from "./beat-grid.ts";
import type { PendingWork } from "./pending-work.ts";
import { PlayheadTracker } from "./playhead.ts";
import { fail, OK, type Result } from "./result.ts";
import { tempoRate, type TempoRangePercent } from "./tempo.ts";
import type { CtxTime, DeckId } from "./types.ts";
import { RateVoice, StretchVoice, type DeckVoice } from "./voices.ts";

export type MasterTempoAvailability = { available: true } | { available: false; reason: string };

export interface TrackInfo {
  readonly trackId: string;
  readonly grid: BeatGrid | null;
}

/** What the engine keeps about a load: metadata and the playhead model, never the audio. */
export interface TrackRecord extends TrackInfo {
  readonly loadedAtCtx: CtxTime;
  readonly durationSec: number;
  readonly playhead: PlayheadTracker;
}

export interface DeckSnapshot {
  readonly deck: DeckId;
  readonly trackId: string | null;
  readonly loading: boolean;
  readonly playing: boolean;
  /** Playing because deck CUE is held at the cue point; releasing it returns there. */
  readonly previewing: boolean;
  readonly tempoFader: number;
  readonly tempoRangePercent: TempoRangePercent;
  /** Tempo multiplier from the fader, before any jog bend. */
  readonly tempoRate: number;
  readonly jogBend: number;
  readonly masterTempo: boolean;
  readonly masterTempoAvailability: MasterTempoAvailability;
  readonly cuePointSec: number;
}

interface Loaded {
  readonly record: TrackRecord;
  readonly rateVoice: RateVoice;
  readonly stretchVoice: StretchVoice | null;
}

export const DEFAULT_TEMPO_RANGE: TempoRangePercent = 10;
/** How much longer than the audio needs a load waits for the old track's stop (see Deck.untilContextTime). */
const CONTEXT_WAIT_GRACE_MS = 1_000;

export class Deck {
  private track: Loaded | null = null;
  private loadsInFlight = 0;
  private playing = false;
  private previewing = false;
  private tempoFader = 0;
  private tempoRangePercent: TempoRangePercent = DEFAULT_TEMPO_RANGE;
  private jogBend = 0;
  private masterTempo = false;
  private cuePointSec = 0;
  /** Context time until which the stretcher may still be playing a track's audio (its last scheduled stop). */
  private stretchAudibleUntil: CtxTime = 0;

  constructor(
    readonly id: DeckId,
    private readonly context: BaseAudioContext,
    private readonly output: AudioNode,
    private readonly stretch: StretchNode | null,
    readonly masterTempoAvailability: MasterTempoAvailability,
    private readonly pending: PendingWork,
  ) {
    stretch?.connect(output);
  }

  isLoading(): boolean {
    return this.loadsInFlight > 0;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  usesStretch(): boolean {
    return this.masterTempo;
  }

  record(): TrackRecord | null {
    return this.track?.record ?? null;
  }

  /** The latest time any change was scheduled; later changes must not come before it. */
  lastChangeCtx(): CtxTime {
    return this.track?.record.playhead.lastCtx() ?? 0;
  }

  /** Starts a load synchronously: the old track stops at `when` and transport is refused until it finishes. */
  beginLoad(when: CtxTime): void {
    this.loadsInFlight++;
    const track = this.track;
    if (track !== null && this.playing) {
      track.record.playhead.setRate(when, 0);
      this.voiceOf(track).stop(when);
      if (this.masterTempo) this.stretchAudibleUntil = Math.max(this.stretchAudibleUntil, when);
    }
    this.track = null;
    this.playing = false;
    this.previewing = false;
    this.jogBend = 0;
    this.cuePointSec = 0;
  }

  /** Finishes a load started with beginLoad. `schedule` gives the start time once the audio is in place. */
  async finishLoad(buffer: AudioBuffer, info: TrackInfo, schedule: () => CtxTime): Promise<Result<{ record: TrackRecord }>> {
    try {
      if (this.stretch !== null) {
        // One copy per channel, transferred to the worklet; it needs two channels even for mono tracks.
        const channels = [0, 1].map((index) => buffer.getChannelData(Math.min(index, buffer.numberOfChannels - 1)).slice());
        // The old track keeps playing through the stretcher until its scheduled stop; dropping its audio
        // earlier would cut it short by up to the stretch lead.
        await this.untilContextTime(this.stretchAudibleUntil);
        await this.stretch.dropBuffers();
        await this.stretch.addBuffers(channels, channels.map((channel) => channel.buffer));
      }
      const when = schedule();
      const playhead = new PlayheadTracker({ durationSec: buffer.duration });
      playhead.seek(when, 0);
      const record: TrackRecord = { trackId: info.trackId, grid: info.grid, loadedAtCtx: when, durationSec: buffer.duration, playhead };
      this.track = {
        record,
        rateVoice: new RateVoice(this.context, buffer, this.output),
        stretchVoice: this.stretch === null ? null : new StretchVoice(this.stretch, this.pending),
      };
      return { ok: true, record };
    } catch (error) {
      return fail({ kind: "track-load-failed", deck: this.id, reason: String(error) });
    } finally {
      this.loadsInFlight--;
    }
  }

  /** Ends a load started with beginLoad without loading anything, because a later load replaced it. */
  skipLoad(): { ok: true; record: null } {
    this.loadsInFlight--;
    return { ok: true, record: null };
  }

  /** Tempo multiplier from the fader, without the jog bend. Sync matches this. */
  tempoRate(): number {
    return tempoRate(this.tempoFader, this.tempoRangePercent);
  }

  rangePercent(): TempoRangePercent {
    return this.tempoRangePercent;
  }

  positionAt(ctx: CtxTime): number | null {
    return this.track?.record.playhead.positionAt(ctx) ?? null;
  }

  play(when: CtxTime, fromPositionSec?: number): Result {
    const track = this.requireTrack();
    if (!track.ok) return track;
    this.previewing = false;
    if (this.playing && fromPositionSec === undefined) return OK;
    return this.start(track.track, when, fromPositionSec ?? track.track.record.playhead.positionAt(when));
  }

  pause(when: CtxTime): Result {
    const track = this.requireTrack();
    if (!track.ok) return track;
    this.previewing = false;
    if (!this.playing) return OK;
    const changed = track.track.record.playhead.setRate(when, 0);
    if (!changed.ok) return changed;
    this.voiceOf(track.track).stop(when);
    this.playing = false;
    return OK;
  }

  seek(when: CtxTime, positionSec: number): Result {
    const track = this.requireTrack();
    if (!track.ok) return track;
    const { durationSec, playhead } = track.track.record;
    if (!Number.isFinite(positionSec) || positionSec < 0 || positionSec > durationSec) {
      return fail({ kind: "value-out-of-range", control: "seek", value: positionSec, min: 0, max: durationSec });
    }
    const moved = playhead.seek(when, positionSec);
    if (!moved.ok) return moved;
    if (this.playing) this.voiceOf(track.track).play(when, positionSec, this.rate());
    return OK;
  }

  /** Deck CUE pressed. Returns the new cue point when the press set one. */
  cuePress(when: CtxTime): Result<{ cuePointSet: number | null }> {
    const track = this.requireTrack();
    if (!track.ok) return track;
    if (this.playing) {
      const back = this.returnToCue(when);
      return back.ok ? { ok: true, cuePointSet: null } : back;
    }
    const position = track.track.record.playhead.positionAt(when);
    if (position !== this.cuePointSec) {
      this.cuePointSec = position;
      return { ok: true, cuePointSet: position };
    }
    const started = this.start(track.track, when, position);
    if (!started.ok) return started;
    this.previewing = true;
    return { ok: true, cuePointSet: null };
  }

  /** Deck CUE released: ends a preview by returning to the cue point. */
  cueRelease(when: CtxTime): Result {
    return this.previewing ? this.returnToCue(when) : OK;
  }

  setTempoFader(when: CtxTime, fader: number): Result {
    return this.withRate(when, () => (this.tempoFader = fader));
  }

  setTempoRange(when: CtxTime, rangePercent: TempoRangePercent): Result {
    return this.withRate(when, () => (this.tempoRangePercent = rangePercent));
  }

  setJogBend(when: CtxTime, bend: number): Result {
    return this.withRate(when, () => (this.jogBend = bend));
  }

  setMasterTempo(when: CtxTime, on: boolean): Result {
    if (on && !this.masterTempoAvailability.available) {
      return fail({ kind: "master-tempo-unavailable", reason: this.masterTempoAvailability.reason });
    }
    if (on === this.masterTempo) return OK;
    const track = this.track;
    if (track === null || !this.playing) {
      this.masterTempo = on;
      return OK;
    }
    const allowed = track.record.playhead.canChangeAt(when);
    if (!allowed.ok) return allowed;
    const position = track.record.playhead.positionAt(when);
    this.voiceOf(track).stop(when);
    if (!on) this.stretchAudibleUntil = Math.max(this.stretchAudibleUntil, when);
    this.masterTempo = on;
    this.voiceOf(track).play(when, position, this.rate());
    return OK;
  }

  /** Marks the deck stopped once its playhead has reached the end of the track. Returns true if it just ended. */
  refresh(now: CtxTime): boolean {
    const track = this.track;
    if (track === null || !this.playing || track.record.playhead.positionAt(now) < track.record.durationSec) return false;
    const when = Math.max(now, this.lastChangeCtx());
    track.record.playhead.setRate(when, 0);
    this.voiceOf(track).stop(when);
    this.playing = false;
    this.previewing = false;
    return true;
  }

  stopAll(): void {
    const track = this.track;
    if (track !== null && this.playing) this.voiceOf(track).stop(Math.max(this.context.currentTime, this.lastChangeCtx()));
    this.stretch?.disconnect();
  }

  snapshot(): DeckSnapshot {
    return {
      deck: this.id,
      trackId: this.track?.record.trackId ?? null,
      loading: this.isLoading(),
      playing: this.playing,
      previewing: this.previewing,
      tempoFader: this.tempoFader,
      tempoRangePercent: this.tempoRangePercent,
      tempoRate: this.tempoRate(),
      jogBend: this.jogBend,
      masterTempo: this.masterTempo,
      masterTempoAvailability: this.masterTempoAvailability,
      cuePointSec: this.cuePointSec,
    };
  }

  /**
   * Waits until the context has played up to `target`. Bounded: a context that is not advancing (suspended
   * by the browser) is waited for at most as long as it would take running, plus a grace period; the
   * stop is then at most a stretch lead away, so the cost of going on is a cut that short.
   */
  private async untilContextTime(target: CtxTime): Promise<void> {
    const remainingSec = () => target - this.context.currentTime;
    if (remainingSec() <= 0) return;
    const deadline = performance.now() + remainingSec() * 1000 + CONTEXT_WAIT_GRACE_MS;
    while (remainingSec() > 0 && this.context.state !== "closed") {
      if (performance.now() >= deadline) {
        console.warn(`[audio] deck ${this.id}: the context did not reach ${String(target)} s; replacing the old track's audio now.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(5, remainingSec() * 1000))));
    }
  }

  private start(track: Loaded, when: CtxTime, position: number): Result {
    const { playhead } = track.record;
    const allowed = playhead.canChangeAt(when);
    if (!allowed.ok) return allowed;
    playhead.seek(when, position);
    playhead.setRate(when, this.rate());
    this.voiceOf(track).play(when, position, this.rate());
    this.playing = true;
    return OK;
  }

  private returnToCue(when: CtxTime): Result {
    const paused = this.pause(when);
    return paused.ok ? this.seek(when, this.cuePointSec) : paused;
  }

  /** Applies a change that alters the rate: the model first, then the voice; nothing changes if the model refuses. */
  private withRate(when: CtxTime, change: () => void): Result {
    const track = this.track;
    if (track === null || !this.playing) {
      change();
      return OK;
    }
    const allowed = track.record.playhead.canChangeAt(when);
    if (!allowed.ok) return allowed;
    change();
    track.record.playhead.setRate(when, this.rate());
    this.voiceOf(track).setRate(when, this.rate());
    return OK;
  }

  private rate(): number {
    return this.tempoRate() * (1 + this.jogBend);
  }

  private voiceOf(track: Loaded): DeckVoice {
    if (!this.masterTempo) return track.rateVoice;
    if (track.stretchVoice === null) {
      throw new Error(`Deck ${this.id} has Master Tempo on without a stretch voice; setMasterTempo must refuse this.`);
    }
    return track.stretchVoice;
  }

  private requireTrack(): Result<{ track: Loaded }> {
    if (this.isLoading()) return fail({ kind: "deck-loading", deck: this.id });
    return this.track === null ? fail({ kind: "no-track-loaded", deck: this.id }) : { ok: true, track: this.track };
  }
}
