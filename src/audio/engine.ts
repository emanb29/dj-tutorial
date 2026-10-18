// The audio engine (ADR 0001): owns the only AudioContext, two decks, the mixer, the monitor output and
// the meters. The UI and input adapters talk to it only through `command`, `load`, queries and typed events.
//
// Scheduling: a change made now takes effect at a scheduled time a little ahead (`lookaheadSec`; for a
// Master Tempo deck, past the stretcher's latency). That one time is used for the audio, the playhead
// model, the phase arithmetic and `CommandEvent.appliedCtx`, so they always agree.

import SignalsmithStretch, { type StretchNode } from "signalsmith-stretch";
import { BEAT_FX_DEFAULT } from "@shared/attempt.ts";
import { BeatFx, BEAT_FX_BEATS, type BeatFxSnapshot } from "./beat-fx.ts";
import { barBeatAt, beatAt, beatGridProblems } from "./beat-grid.ts";
import { decibelsToGain, headphoneLevelToDecibels } from "./curves.ts";
import { CONTROL_RANGES, type ChannelControl, type CommandInput, type EngineCommand } from "./commands.ts";
import { Deck, type DeckSnapshot, type MasterTempoAvailability, type TrackInfo, type TrackRecord } from "./deck.ts";
import { Emitter, type Unsubscribe } from "./events.ts";
import { createMeter, loadMeterProcessor, type BusMeterFrame } from "./meter.ts";
import { startMasterRecording, type MasterRecording } from "./master-recording.ts";
import { Mixer, type EqBand, type MixerState } from "./mixer.ts";
import { MasterOnlyMonitor, type MonitorOutput } from "./monitor.ts";
import { boundedCorrectionMs, correctedInputTime } from "./input-latency.ts";
import { audioContextClock, renderTimeClock, type OutputClock } from "./output-clock.ts";
import { createOutputRouting } from "./output-routing.ts";
import type { OutputPlan } from "./output.ts";
import { PendingWork } from "./pending-work.ts";
import { fail, OK, type AudioEngineError, type Result } from "./result.ts";
import { phaseAlignedPosition, syncTempo } from "./sync.ts";
import { TEMPO_RANGES } from "./tempo.ts";
import { DECK_IDS, otherDeck, type CtxTime, type DeckId, type InputDevice } from "./types.ts";

export interface AudioEngineOptions {
  /** The context to own. Defaults to a new interactive AudioContext; tests pass an OfflineAudioContext. */
  readonly context: AudioContext | OfflineAudioContext;
  /** Defaults to MasterOnlyMonitor (speakers). Use SplitCueMonitor for headphone cueing on one output. */
  readonly monitor: MonitorOutput;
  /**
   * Where the sound goes (output.ts): builds the context and the monitor for the plan, in place of
   * `context` and `monitor`. `headphones` is whether the Lesson cues in headphones.
   */
  readonly output: { readonly plan: OutputPlan; readonly headphones: boolean };
  /** Defaults to getOutputTimestamp() for an AudioContext and render time for an OfflineAudioContext. */
  readonly clock: OutputClock;
  /** Load signalsmith-stretch for Master Tempo. Defaults to true. */
  readonly masterTempo: boolean;
  /**
   * How far ahead of `currentTime` changes are scheduled. Defaults to baseLatency + 2 render quanta for an
   * AudioContext (so the change lands in a block not yet rendered) and 0 for an OfflineAudioContext.
   */
  readonly lookaheadSec: number;
  /**
   * The Learner's measured input latency in ms (input-latency.ts; positive = their taps land late),
   * taken off every input's event time before it is mapped to heard time. Held to ±150 ms. Default 0.
   */
  readonly inputCorrectionMs: number;
}

/**
 * A command as the engine received it, emitted whether or not it was accepted.
 * - `heardCtx`: heard (output-timeline) time of the input: the Learner's intent. Checks grade on this.
 * - `appliedCtx`: context time the change takes effect in the audio and the playhead model.
 * `device: "engine"` marks a change the engine made itself (e.g. SYNC dropped).
 */
export interface CommandEvent {
  readonly command: EngineCommand;
  readonly device: InputDevice | "engine";
  readonly heardCtx: CtxTime | null;
  readonly appliedCtx: CtxTime;
  readonly gestureEnd: boolean;
  readonly rejected: AudioEngineError | null;
}

export type ChannelSnapshot = Readonly<Record<ChannelControl, number>> & { readonly cue: boolean };

export interface EngineMixerSnapshot extends Readonly<MixerState> {
  readonly channels: Readonly<Record<DeckId, ChannelSnapshot>>;
  readonly cueMix: number;
  /** Headphone LEVEL, 0…1 (0.5 is unity). */
  readonly headphoneLevel: number;
  readonly beatFx: BeatFxSnapshot;
  /** The BPM Beat FX was tapped to (TAP), or null when it follows the selected deck (AUTO). */
  readonly beatFxBpm: number | null;
}

export interface EngineDeckSnapshot extends DeckSnapshot {
  /** True when this deck follows the other deck's tempo. */
  readonly syncOn: boolean;
}

export interface PlayheadReading {
  readonly ctx: CtxTime;
  readonly positionSec: number;
  /** Fractional beat index on the track's grid; null without a grid. */
  readonly beat: number | null;
  readonly bar: number | null;
  readonly beatInBar: number | null;
}

export interface CuePointEvent {
  /** Heard time of the press (applied time if the output was not running). */
  readonly ctx: CtxTime;
  readonly deck: DeckId;
  readonly trackId: string;
  readonly pos: number;
}

export interface EngineEvents {
  meter: BusMeterFrame;
  command: CommandEvent;
  deck: EngineDeckSnapshot;
  "cue-point": CuePointEvent;
  "track-loaded": { readonly deck: DeckId; readonly record: TrackRecord };
  /** The AudioContext stopped running (an AudioContext only; offline renders suspend on purpose). */
  interruption: { readonly ctx: CtxTime; readonly kind: "contextSuspended" };
}

/** Track loads kept per deck for attempt timelines; older loads are dropped. */
export const TRACK_HISTORY_LIMIT = 32;
const RENDER_QUANTUM = 128;
/** Beat FX follows this BPM when no deck it could follow has a beat grid. */
const FALLBACK_FX_BPM = 120;
/** Tapped Beat FX tempos the engine accepts (a 4-beat echo at 60 BPM is the delay's longest). */
const MIN_FX_BPM = 60;
const MAX_FX_BPM = 300;

export async function createAudioEngine(options: Partial<AudioEngineOptions> = {}): Promise<AudioEngine> {
  const routing = options.output === undefined ? null : createOutputRouting(options.output.plan, { headphones: options.output.headphones });
  const context = routing?.context ?? options.context ?? new AudioContext({ latencyHint: "interactive" });
  const monitor = routing?.monitor ?? options.monitor ?? new MasterOnlyMonitor();
  try {
    await loadMeterProcessor(context);
    const stretch = options.masterTempo === false ? disabledStretch() : await loadStretchNodes(context);
    const clock = masterDelayed(options.clock ?? (context instanceof AudioContext ? audioContextClock(context) : renderTimeClock(context)), monitor);
    const quanta = (2 * RENDER_QUANTUM) / context.sampleRate;
    const lookaheadSec = options.lookaheadSec ?? (context instanceof AudioContext ? context.baseLatency + quanta : 0);
    const stretchLeadSec = Math.max(lookaheadSec, stretch.latencySec + quanta);
    const engine = new AudioEngine(context, monitor, clock, stretch, { lookaheadSec, stretchLeadSec }, routing?.plan ?? null);
    engine.setInputCorrection(options.inputCorrectionMs ?? 0);
    return engine;
  } catch (error) {
    // Do not leak a context this function created.
    if (options.context === undefined && context instanceof AudioContext) await context.close();
    throw error;
  }
}

/** Heard time on the master device: an output that delays the master is heard that much later. */
function masterDelayed(clock: OutputClock, monitor: MonitorOutput): OutputClock {
  if (monitor.masterDelaySec === undefined) return clock;
  return {
    heardTime(performanceTimeMs) {
      const heard = clock.heardTime(performanceTimeMs);
      return heard.ok ? { ok: true, ctx: heard.ctx - (monitor.masterDelaySec?.() ?? 0) } : heard;
    },
  };
}

interface StretchNodes {
  readonly nodes: Readonly<Record<DeckId, StretchNode>> | null;
  readonly availability: MasterTempoAvailability;
  readonly latencySec: number;
}

function disabledStretch(): StretchNodes {
  return { nodes: null, availability: { available: false, reason: "Master Tempo was disabled in the engine options" }, latencySec: 0 };
}

async function loadStretchNodes(context: BaseAudioContext): Promise<StretchNodes> {
  const create = () => SignalsmithStretch(context, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  try {
    const [a, b] = await Promise.all([create(), create()]);
    const latencySec = Math.max(await a.latency(), await b.latency());
    return { nodes: { A: a, B: b }, availability: { available: true }, latencySec };
  } catch (error) {
    // Recovered: decks still play with key lock off, and the state says why Master Tempo is missing.
    const reason = `signalsmith-stretch failed to load (${String(error)})`;
    console.warn(`[audio] ${reason}; Master Tempo is unavailable.`);
    return { nodes: null, availability: { available: false, reason }, latencySec: 0 };
  }
}

const EQ_BANDS: Partial<Record<ChannelControl, EqBand>> = { "eq-low": "low", "eq-mid": "mid", "eq-high": "high" };

export class AudioEngine {
  readonly mixer: Mixer;
  readonly beatFx: BeatFx;
  private readonly decks: Readonly<Record<DeckId, Deck>>;
  private readonly emitter = new Emitter<EngineEvents>();
  private readonly pending = new PendingWork();
  private readonly history: Record<DeckId, TrackRecord[]> = { A: [], B: [] };
  private readonly loadQueue: Record<DeckId, Promise<unknown>> = { A: Promise.resolve(), B: Promise.resolve() };
  /** Counts load() calls per deck, so a load can tell that a later one has overtaken it. */
  private readonly loadGeneration: Record<DeckId, number> = { A: 0, B: 0 };
  private readonly meters: AudioWorkletNode[];
  private readonly cueOn: Record<DeckId, boolean> = { A: false, B: false };
  private readonly channelState: Record<DeckId, Record<ChannelControl, number>> = {
    A: { trim: 0, "eq-low": 0, "eq-mid": 0, "eq-high": 0, filter: 0, "channel-fader": 1 },
    B: { trim: 0, "eq-low": 0, "eq-mid": 0, "eq-high": 0, filter: 0, "channel-fader": 1 },
  };
  private readonly lookaheadSec: number;
  private readonly stretchLeadSec: number;
  private readonly onStateChange: () => void;
  private cueMix = 0;
  /** A tapped Beat FX tempo (TAP); null follows the selected deck (AUTO). */
  private beatFxBpm: number | null = null;
  private headphoneLevel = 0.5;
  private follower: DeckId | null = null;
  private closed = false;
  private inputCorrectionMs = 0;

  constructor(
    readonly context: AudioContext | OfflineAudioContext,
    private readonly monitor: MonitorOutput,
    private readonly clock: OutputClock,
    stretch: StretchNodes,
    timing: { lookaheadSec: number; stretchLeadSec: number },
    /** Where the sound goes, when the engine was made from an output plan (a fallback says so); null otherwise. */
    readonly output: OutputPlan | null = null,
  ) {
    this.lookaheadSec = timing.lookaheadSec;
    this.stretchLeadSec = timing.stretchLeadSec;
    this.mixer = new Mixer(context);
    this.decks = {
      A: new Deck("A", context, this.mixer.strips.A.input, stretch.nodes?.A ?? null, stretch.availability, this.pending),
      B: new Deck("B", context, this.mixer.strips.B.input, stretch.nodes?.B ?? null, stretch.availability, this.pending),
    };
    monitor.attach({ context, master: this.mixer.master, cue: this.mixer.cue });
    this.beatFx = new BeatFx(context, { A: this.mixer.strips.A.output, B: this.mixer.strips.B.output, master: this.mixer.masterBus }, BEAT_FX_DEFAULT);
    this.beatFx.wet.connect(this.mixer.master);

    const masterMeter = createMeter(context, "master", (frame) => {
      this.emitter.emit("meter", frame);
      this.refreshDecks();
    });
    this.mixer.master.connect(masterMeter);
    this.meters = [masterMeter];
    for (const deck of DECK_IDS) {
      const meter = createMeter(context, deck, (frame) => {
        this.emitter.emit("meter", frame);
      });
      this.mixer.strips[deck].preFader.connect(meter);
      this.meters.push(meter);
    }
    const fxMeter = createMeter(context, "fx", (frame) => {
      this.emitter.emit("meter", frame);
    });
    this.beatFx.wet.connect(fxMeter);
    this.meters.push(fxMeter);

    this.onStateChange = () => {
      if (context instanceof AudioContext && context.state !== "running") {
        this.emitter.emit("interruption", { ctx: context.currentTime, kind: "contextSuspended" });
      }
    };
    context.addEventListener("statechange", this.onStateChange);
  }

  on<Name extends keyof EngineEvents>(name: Name, listener: (payload: EngineEvents[Name]) => void): Unsubscribe {
    return this.emitter.on(name, listener);
  }

  /**
   * Loads a track. The deck stops and refuses transport at once; overlapping loads on one deck run in
   * order and the last one wins: an overtaken load resolves OK but is never loaded, recorded in the
   * history or announced with `track-loaded`. Bad input is refused with every problem listed.
   */
  async load(deck: DeckId, buffer: AudioBuffer, info: TrackInfo): Promise<Result> {
    if (this.closed) return fail({ kind: "engine-closed" });
    const problems = this.trackProblems(buffer, info);
    if (problems.length > 0) return fail({ kind: "invalid-track", problems });

    if (this.follower === deck) this.dropSync(deck);
    this.decks[deck].beginLoad(this.deckTime(deck));
    this.emitDecks();

    const generation = ++this.loadGeneration[deck];
    const superseded = () => generation !== this.loadGeneration[deck];
    // A load overtaken by a later one is skipped when its turn comes: the deck never holds its track.
    const loaded = this.loadQueue[deck].then((): Result<{ record: TrackRecord | null }> | Promise<Result<{ record: TrackRecord }>> =>
      superseded() ? this.decks[deck].skipLoad() : this.decks[deck].finishLoad(buffer, info, () => this.deckTime(deck)),
    );
    this.loadQueue[deck] = loaded;
    const result = await loaded;
    if (result.ok && result.record !== null) {
      const history = this.history[deck];
      history.push(result.record);
      if (history.length > TRACK_HISTORY_LIMIT) history.shift();
      this.emitter.emit("track-loaded", { deck, record: result.record });
      if (this.follower === otherDeck(deck)) this.resyncFollower();
      this.followBeatFxTempo(this.mixerTime());
    }
    this.emitDecks();
    return result.ok ? OK : result;
  }

  /**
   * The Learner's input latency (ms, positive = late), taken off each input's event time before it is
   * mapped to heard time: the one place it is applied, so every Check and live feedback sees it.
   */
  setInputCorrection(correctionMs: number): void {
    this.inputCorrectionMs = boundedCorrectionMs(correctionMs);
  }

  get inputCorrection(): number {
    return this.inputCorrectionMs;
  }

  /** Applies a command and reports it on the `command` event, accepted or not. */
  command(command: EngineCommand, input: CommandInput): Result {
    // An input's own time, less the Learner's measured latency; the engine's own changes have no event time.
    const heard = this.clock.heardTime(input.eventTimeMs === undefined ? undefined : correctedInputTime(input.eventTimeMs, this.inputCorrectionMs));
    const heardCtx = heard.ok ? heard.ctx : null;
    const appliedCtx = this.appliedTimeFor(command);
    const loopedBefore = "deck" in command ? this.decks[command.deck].loop() !== null : false;
    const result = this.closed ? fail({ kind: "engine-closed" }) : this.apply(command, heardCtx, appliedCtx);
    this.emitter.emit("command", {
      command,
      device: input.device,
      heardCtx,
      appliedCtx,
      gestureEnd: input.gestureEnd ?? false,
      rejected: result.ok ? null : result.error,
    });
    if (result.ok && "deck" in command) {
      // A seek, a hot cue, a CUE return or a search left the loop: recorded as the engine's own exit.
      if (loopedBefore && command.control !== "loop-exit" && this.decks[command.deck].loop() === null) this.endedLoop(command.deck, appliedCtx);
    }
    if (result.ok) this.followBeatFxTempo(appliedCtx);
    return result;
  }

  deckState(deck: DeckId): EngineDeckSnapshot {
    return { ...this.decks[deck].snapshot(), syncOn: this.follower === deck };
  }

  mixerState(): EngineMixerSnapshot {
    return {
      ...this.mixer.snapshot(),
      channels: { A: { ...this.channelState.A, cue: this.cueOn.A }, B: { ...this.channelState.B, cue: this.cueOn.B } },
      cueMix: this.cueMix,
      headphoneLevel: this.headphoneLevel,
      beatFx: this.beatFx.snapshot(),
      beatFxBpm: this.beatFxBpm,
    };
  }

  /** Track loads on a deck, oldest first (at most TRACK_HISTORY_LIMIT). Metadata and playhead models only. */
  trackHistory(deck: DeckId): readonly TrackRecord[] {
    return [...this.history[deck]];
  }

  /** Context time heard now, or at `performanceTimeMs` (a DOM event's timeStamp). */
  heardTime(performanceTimeMs?: number): Result<{ ctx: CtxTime }> {
    return this.clock.heardTime(performanceTimeMs);
  }

  /** The position heard now (or at `performanceTimeMs`), for drawing playheads on requestAnimationFrame. */
  playhead(deck: DeckId, performanceTimeMs?: number): Result<PlayheadReading> {
    const heard = this.clock.heardTime(performanceTimeMs);
    if (!heard.ok) return heard;
    const reading = this.playheadAt(deck, heard.ctx);
    return reading === null ? fail({ kind: "no-track-loaded", deck }) : { ok: true, ...reading };
  }

  /** The position at context time `ctx`, or null when no track is loaded. */
  playheadAt(deck: DeckId, ctx: CtxTime): PlayheadReading | null {
    const track = this.decks[deck].record();
    if (track === null) return null;
    const positionSec = track.playhead.positionAt(ctx);
    if (track.grid === null) return { ctx, positionSec, beat: null, bar: null, beatInBar: null };
    return { ctx, positionSec, beat: beatAt(track.grid, positionSec), ...barBeatAt(track.grid, positionSec) };
  }

  /** Resolves when every message sent to the stretch worklets so far has been handled; rethrows a failure. */
  async settled(): Promise<void> {
    await this.pending.settled();
  }

  /**
   * Records the master (what the audience hears) to a compressed file, for the final project. Only on
   * an AudioContext with MediaRecorder; an offline render cannot record.
   */
  recordMaster(maxBytes: number): Result<{ recording: MasterRecording }> {
    if (this.closed) return fail({ kind: "engine-closed" });
    return startMasterRecording(this.context, this.mixer.master, maxBytes);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.context.removeEventListener("statechange", this.onStateChange);
    for (const deck of DECK_IDS) this.decks[deck].stopAll();
    this.monitor.detach();
    for (const meter of this.meters) {
      meter.port.onmessage = null;
      meter.disconnect();
    }
    this.beatFx.disconnect();
    this.mixer.disconnect();
    if (this.context instanceof AudioContext) await this.context.close();
  }

  private trackProblems(buffer: AudioBuffer, info: TrackInfo): string[] {
    return [
      info.trackId.length > 0 ? null : "trackId must not be empty",
      buffer.length > 0 ? null : "the buffer is empty",
      buffer.sampleRate === this.context.sampleRate
        ? null
        : `the buffer is at ${String(buffer.sampleRate)} Hz but the engine runs at ${String(this.context.sampleRate)} Hz; decode it with the engine's context`,
      ...(info.grid === null ? [] : beatGridProblems(info.grid)),
    ].filter((problem) => problem !== null);
  }

  /** When a change to `deck` made now takes effect: never before the deck's last change. */
  private deckTime(deck: DeckId, forMasterTempoSwitch = false): CtxTime {
    const lead = forMasterTempoSwitch || this.decks[deck].usesStretch() ? this.stretchLeadSec : this.lookaheadSec;
    return Math.max(this.context.currentTime + lead, this.decks[deck].lastChangeCtx());
  }

  private mixerTime(): CtxTime {
    return this.context.currentTime + this.lookaheadSec;
  }

  private appliedTimeFor(command: EngineCommand): CtxTime {
    if (!("deck" in command)) return this.mixerTime();
    switch (command.control) {
      case "master-tempo":
        return this.deckTime(command.deck, true);
      case "trim":
      case "eq-low":
      case "eq-mid":
      case "eq-high":
      case "filter":
      case "channel-fader":
      case "headphone-cue":
      case "ready":
        return this.mixerTime();
      default:
        return this.deckTime(command.deck);
    }
  }

  private apply(command: EngineCommand, heardCtx: CtxTime | null, when: CtxTime): Result {
    switch (command.control) {
      case "play":
        return this.afterDeckChange(this.play(command.deck, when));
      case "pause":
        return this.afterDeckChange(this.decks[command.deck].pause(when));
      case "deck-cue":
        return this.afterDeckChange(command.value ? this.cuePress(command.deck, heardCtx ?? when, when) : this.decks[command.deck].cueRelease(when));
      case "seek":
        return this.afterDeckChange(this.decks[command.deck].seek(when, command.value));
      case "tempo":
        return this.validated(command.control, command.value, () => this.setTempo(command.deck, command.value, when));
      case "tempo-range":
        if (!TEMPO_RANGES.includes(command.value)) {
          return fail({ kind: "value-out-of-range", control: "tempo-range", value: command.value, min: 6, max: 16 });
        }
        return this.setTempoRange(command.deck, command.value, when);
      case "master-tempo":
        return this.afterDeckChange(this.decks[command.deck].setMasterTempo(when, command.value));
      case "jog-search":
        if (!Number.isFinite(command.value)) {
          return fail({ kind: "value-out-of-range", control: "jog-search", value: command.value, min: -Number.MAX_VALUE, max: Number.MAX_VALUE });
        }
        return this.afterDeckChange(this.decks[command.deck].search(when, command.value));
      case "jog-bend":
        return this.validated(command.control, command.value, () => this.afterDeckChange(this.decks[command.deck].setJogBend(when, command.value)));
      case "sync":
        return this.afterDeckChange(command.value ? this.enableSync(command.deck) : this.disableSync(command.deck));
      case "headphone-cue":
        this.cueOn[command.deck] = command.value;
        this.mixer.strips[command.deck].setCue(command.value, when);
        return OK;
      case "trim":
      case "eq-low":
      case "eq-mid":
      case "eq-high":
      case "filter":
      case "channel-fader": {
        const { control, deck, value } = command;
        return this.validated(control, value, () => {
          this.channelState[deck][control] = value;
          this.applyChannelControl(deck, control, value, when);
          return OK;
        });
      }
      case "crossfader":
        return this.validated(command.control, command.value, () => {
          this.mixer.setCrossfader(command.value, when);
          return OK;
        });
      case "master-level":
        return this.validated(command.control, command.value, () => {
          this.mixer.setMasterLevel(command.value, when);
          return OK;
        });
      case "cue-mix":
        return this.validated(command.control, command.value, () => {
          this.cueMix = command.value;
          this.monitor.setCueMix(command.value);
          return OK;
        });
      case "headphone-level":
        return this.validated(command.control, command.value, () => {
          this.headphoneLevel = command.value;
          this.monitor.setHeadphoneGain(decibelsToGain(headphoneLevelToDecibels(command.value)));
          return OK;
        });
      case "hot-cue-set": {
        const pos = command.pos ?? this.pressPosition(command.deck, heardCtx, when);
        if (pos === null) return fail({ kind: "no-track-loaded", deck: command.deck });
        return this.afterDeckChange(this.decks[command.deck].hotCueSet(command.slot, pos));
      }
      case "hot-cue-clear":
        return this.afterDeckChange(this.decks[command.deck].hotCueClear(command.slot));
      case "hot-cue":
        return this.afterDeckChange(this.decks[command.deck].hotCueTrigger(when, command.slot));
      case "loop-in": {
        const pos = this.pressPosition(command.deck, heardCtx, when);
        return pos === null ? fail({ kind: "no-track-loaded", deck: command.deck }) : this.afterDeckChange(this.decks[command.deck].loopIn(pos));
      }
      case "loop-out": {
        const pos = this.pressPosition(command.deck, heardCtx, when);
        return pos === null ? fail({ kind: "no-track-loaded", deck: command.deck }) : this.afterDeckChange(this.decks[command.deck].loopOut(when, pos));
      }
      case "loop-auto": {
        if (!(Number.isInteger(Math.log2(command.value)) && command.value >= 1 && command.value <= 32)) {
          return fail({ kind: "value-out-of-range", control: "loop-auto", value: command.value, min: 1, max: 32 });
        }
        const deck = this.decks[command.deck];
        const pos = this.pressPosition(command.deck, heardCtx, when);
        if (pos === null) return fail({ kind: "no-track-loaded", deck: command.deck });
        return this.afterDeckChange(deck.loopAuto(when, pos, command.value, deck.record()?.grid ?? null));
      }
      case "loop-double":
      case "loop-halve":
        return this.afterDeckChange(this.decks[command.deck].loopResize(when, command.control === "loop-double" ? 2 : 0.5));
      case "loop-exit":
        return this.afterDeckChange(this.decks[command.deck].loopExit(when));
      case "beat-fx":
        this.beatFx.set({ on: command.value }, when);
        return OK;
      case "beat-fx-channel":
        this.beatFx.set({ channel: command.value }, when);
        return OK;
      case "beat-fx-beats":
        if (!(BEAT_FX_BEATS as readonly number[]).includes(command.value)) {
          return fail({ kind: "value-out-of-range", control: "beat-fx-beats", value: command.value, min: BEAT_FX_BEATS[0], max: BEAT_FX_BEATS[BEAT_FX_BEATS.length - 1] ?? 4 });
        }
        this.beatFx.set({ beats: command.value }, when);
        return OK;
      case "beat-fx-bpm":
        if (command.value !== null && !(Number.isFinite(command.value) && command.value >= MIN_FX_BPM && command.value <= MAX_FX_BPM)) {
          return fail({ kind: "value-out-of-range", control: "beat-fx-bpm", value: command.value, min: MIN_FX_BPM, max: MAX_FX_BPM });
        }
        this.beatFxBpm = command.value;
        return OK;
      case "beat-fx-depth":
        return this.validated(command.control, command.value, () => {
          this.beatFx.set({ depth: command.value }, when);
          return OK;
        });
      case "tap":
      case "done":
      case "ready":
        return OK;
    }
  }

  /**
   * The track position a press means (a hot cue set, a loop point): what was heard at the press, but
   * never from before the deck's latest change. A press heard before a seek or jog search reached the
   * output (made a moment after it, inside the output latency) means the new position, which is what the
   * Learner sees, not the one it replaced. On a paused deck that is simply where it stands.
   */
  private pressPosition(deck: DeckId, heardCtx: CtxTime | null, when: CtxTime): number | null {
    const at = Math.min(when, Math.max(heardCtx ?? when, this.decks[deck].lastChangeCtx()));
    return this.decks[deck].positionAt(at);
  }

  /** Records a loop the engine ended itself (a seek or hot cue left it), as SYNC dropped is. */
  private endedLoop(deck: DeckId, when: CtxTime): void {
    this.emitter.emit("command", { command: { control: "loop-exit", deck }, device: "engine", heardCtx: null, appliedCtx: when, gestureEnd: false, rejected: null });
  }

  /**
   * Beat FX follows the tapped BPM (TAP), else the heard BPM of the deck it takes in (for MASTER: deck
   * A, else B), from its grid and tempo. Without a grid it falls back to 120 BPM, which only changes how
   * far apart the echoes are.
   */
  private followBeatFxTempo(when: CtxTime): void {
    if (this.beatFxBpm !== null) {
      this.beatFx.setTempo(this.beatFxBpm, when);
      return;
    }
    const { channel } = this.beatFx.snapshot();
    const candidates: readonly DeckId[] = channel === "master" ? ["A", "B"] : [channel];
    const deck = candidates.find((candidate) => this.decks[candidate].record()?.grid != null);
    const grid = deck === undefined ? null : (this.decks[deck].record()?.grid ?? null);
    const bpm = deck === undefined || grid === null ? FALLBACK_FX_BPM : grid.bpm * this.decks[deck].tempoRate();
    this.beatFx.setTempo(bpm, when);
  }

  private validated(control: keyof typeof CONTROL_RANGES, value: number, apply: () => Result): Result {
    const [min, max] = CONTROL_RANGES[control];
    if (!Number.isFinite(value) || value < min || value > max) {
      return fail({ kind: "value-out-of-range", control, value, min, max });
    }
    return apply();
  }

  private applyChannelControl(deck: DeckId, control: ChannelControl, value: number, when: CtxTime): void {
    const strip = this.mixer.strips[deck];
    const band = EQ_BANDS[control];
    if (band !== undefined) strip.setEq(band, value, when);
    else if (control === "trim") strip.setTrim(value, when);
    else if (control === "filter") strip.setFilter(value, when);
    else strip.setFader(value, when);
  }

  private cuePress(deck: DeckId, heardCtx: CtxTime, when: CtxTime): Result {
    const pressed = this.decks[deck].cuePress(when);
    if (!pressed.ok) return pressed;
    const trackId = this.decks[deck].record()?.trackId;
    if (pressed.cuePointSet !== null && trackId !== undefined) {
      this.emitter.emit("cue-point", { ctx: heardCtx, deck, trackId, pos: pressed.cuePointSet });
    }
    return OK;
  }

  private play(deck: DeckId, when: CtxTime): Result {
    if (this.follower !== deck || this.decks[deck].isPlaying()) return this.decks[deck].play(when);
    // A synced deck starts on the leader's beat phase.
    const aligned = this.alignedPosition(deck, when);
    return aligned === null ? this.decks[deck].play(when) : this.decks[deck].play(when, aligned);
  }

  private setTempo(deck: DeckId, fader: number, when: CtxTime): Result {
    if (this.follower === deck) return fail({ kind: "tempo-locked-by-sync", deck });
    const changed = this.decks[deck].setTempoFader(when, fader);
    if (!changed.ok) return changed;
    if (this.follower === otherDeck(deck)) this.resyncFollower();
    return this.afterDeckChange(OK);
  }

  private setTempoRange(deck: DeckId, rangePercent: (typeof TEMPO_RANGES)[number], when: CtxTime): Result {
    const changed = this.decks[deck].setTempoRange(when, rangePercent);
    if (!changed.ok) return changed;
    if (this.follower !== null) this.resyncFollower();
    return this.afterDeckChange(OK);
  }

  private enableSync(deck: DeckId): Result {
    const tempo = this.syncedTempo(deck);
    if (!tempo.ok) return tempo;
    // The deck that presses SYNC follows; if the other deck was following, it now leads.
    if (this.follower === otherDeck(deck)) this.dropSync(otherDeck(deck));
    const when = this.deckTime(deck);
    const follower = this.decks[deck];
    const changed = follower.setTempoFader(when, tempo.fader);
    if (!changed.ok) return changed;
    this.follower = deck;
    if (follower.isPlaying()) {
      const aligned = this.alignedPosition(deck, when);
      if (aligned !== null) return follower.seek(when, aligned);
    }
    return OK;
  }

  private disableSync(deck: DeckId): Result {
    if (this.follower === deck) this.follower = null;
    return OK;
  }

  /** Turns SYNC off on a deck on the engine's own initiative, as a recorded command. */
  private dropSync(deck: DeckId): void {
    if (this.follower !== deck) return;
    this.follower = null;
    this.emitter.emit("command", {
      command: { control: "sync", deck, value: false },
      device: "engine",
      heardCtx: null,
      appliedCtx: this.deckTime(deck),
      gestureEnd: false,
      rejected: null,
    });
  }

  private syncedTempo(deck: DeckId): Result<{ fader: number }> {
    const follower = this.decks[deck];
    const leader = this.decks[otherDeck(deck)];
    const followerTrack = follower.record();
    const leaderTrack = leader.record();
    if (followerTrack === null) return fail({ kind: "no-track-loaded", deck });
    if (leaderTrack === null) return fail({ kind: "no-track-loaded", deck: leader.id });
    if (followerTrack.grid === null) return fail({ kind: "no-beat-grid", deck });
    if (leaderTrack.grid === null) return fail({ kind: "no-beat-grid", deck: leader.id });
    return syncTempo({
      leaderGrid: leaderTrack.grid,
      leaderRate: leader.tempoRate(),
      followerGrid: followerTrack.grid,
      followerRangePercent: follower.rangePercent(),
    });
  }

  /** Keeps the follower on the leader's tempo; drops sync if the follower can no longer reach it. */
  private resyncFollower(): void {
    const deck = this.follower;
    if (deck === null) return;
    const tempo = this.syncedTempo(deck);
    const changed = tempo.ok ? this.decks[deck].setTempoFader(this.deckTime(deck), tempo.fader) : tempo;
    if (!changed.ok) this.dropSync(deck);
  }

  private alignedPosition(deck: DeckId, when: CtxTime): number | null {
    const followerTrack = this.decks[deck].record();
    const leaderTrack = this.decks[otherDeck(deck)].record();
    if (followerTrack?.grid == null || leaderTrack?.grid == null) return null;
    const aligned = phaseAlignedPosition({
      leaderGrid: leaderTrack.grid,
      leaderPos: leaderTrack.playhead.positionAt(when),
      followerGrid: followerTrack.grid,
      followerPos: followerTrack.playhead.positionAt(when),
    });
    // Before the track start, take the same phase one beat later instead.
    const inTrack = aligned < 0 ? aligned + 60 / followerTrack.grid.bpm : aligned;
    return Math.min(followerTrack.durationSec, inTrack);
  }

  /** Announces an accepted deck change. A command answers only OK or the error, never the deck's details. */
  private afterDeckChange(result: Result): Result {
    if (!result.ok) return result;
    this.emitDecks();
    return OK;
  }

  private emitDecks(): void {
    for (const deck of DECK_IDS) this.emitter.emit("deck", this.deckState(deck));
  }

  private refreshDecks(): void {
    const now = this.context.currentTime;
    const ended = DECK_IDS.filter((deck) => this.decks[deck].refresh(now));
    if (ended.length > 0) this.emitDecks();
  }
}
