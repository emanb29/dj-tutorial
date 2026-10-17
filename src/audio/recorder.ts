// Records an attempt in the canonical shape the Checks read (`Attempt` in shared/attempt.ts):
// control events at heard time in the Checks' units, the playhead model of each deck, grids, cue points,
// 50 Hz meters per bus, the mixer at the start and interruptions.
//
// Extras the Checks ignore: each event's `appliedCtx` (when it took effect in the audio and the playhead
// model) and `inputDevice`, plus `engineEvents`, every command the engine saw (including ones the
// contract has no control id for, refused ones and the engine's own, such as SYNC dropped).
//
// Pointer-rate moves of continuous controls are coalesced to `coalesceHz` per control: the first move is
// kept at once, later moves within the interval are held and only the newest is kept, and a gesture's
// last event (CommandInput.gestureEnd) and the held move at stop are always recorded. Refused moves and
// the engine's own are coalesced the same way, each on their own so they never displace accepted moves.
//
// Capacity: an attempt is never lost to its size. Its control-event budget comes from its expected
// duration (start({ expectedDurationSec })) or `capacity`. Past NEAR_CAPACITY_FRACTION of it the recorder
// emits `recorder-near-capacity` and coalesces continuous moves at a quarter of `coalesceHz`; at the
// budget it stops adding continuous moves but keeps every discrete event, and marks the attempt `degraded`.

import type {
  Attempt,
  ControlEvent,
  ControlId,
  CuePointSet,
  DeckRecording,
  BeatGrid,
  Interruption,
  MeterFrame,
  MixerSnapshot,
} from "@shared/attempt.ts";
import { CONTINUOUS_CONTROLS, type EngineCommand } from "./commands.ts";
import { eqKnobToDecibels, toTimelineDecibels, trimKnobToDecibels } from "./curves.ts";
import type { TrackRecord } from "./deck.ts";
import type { AudioEngine, CommandEvent, EngineMixerSnapshot } from "./engine.ts";
import { Emitter, type Unsubscribe } from "./events.ts";
import { METER_FRAMES_PER_SECOND } from "./loudness.ts";
import type { BusMeterFrame, MeterBus } from "./meter.ts";
import { fail, OK, type Result } from "./result.ts";
import { DECK_IDS, type CtxTime, type DeckId, type InputDevice } from "./types.ts";

/** A contract control event plus extras the Checks ignore. */
export interface RecordedControlEvent extends ControlEvent {
  /** When the change took effect in the audio and the playhead model (`ctx` is when it was heard/made). */
  readonly appliedCtx: CtxTime;
  readonly inputDevice: InputDevice;
}

export interface RecordedAttempt extends Attempt {
  readonly events: readonly RecordedControlEvent[];
  /** Every command the engine saw during the attempt, in order. */
  readonly engineEvents: readonly CommandEvent[];
  readonly startedCtx: CtxTime;
  readonly endedCtx: CtxTime;
  /**
   * True when the recorder ran out of room and kept less than usual: continuous moves past the ceiling or
   * meter frames past their capacity were left out. Discrete (button) events are always all kept.
   */
  readonly degraded: boolean;
}

/** What only the app knows about an attempt, given at stop. */
export interface AttemptDetails {
  readonly attemptId: string;
  readonly learnerId: string;
  readonly endReason: Attempt["endReason"];
  readonly abandoned: boolean;
  readonly phraseMarkers: Attempt["phraseMarkers"];
  readonly answers: Attempt["answers"];
  /** Overrides the attempt's input device, which is otherwise the device of most recorded commands. */
  readonly inputDevice?: InputDevice;
}

export interface RecorderCapacity {
  readonly controlEvents: number;
  readonly meterFrames: number;
}

export interface RecorderStartOptions {
  /**
   * How long the attempt is expected to last. Sizes its control-event budget (duration × an estimate of
   * controls in motion at once × coalesceHz × headroom) and its meter capacity, in place of `capacity`.
   */
  readonly expectedDurationSec?: number;
}

/** How full the current attempt is. */
export interface RecorderUsage {
  readonly controlEvents: number;
  readonly controlEventBudget: number;
  readonly meterFrames: number;
  readonly meterFrameCapacity: number;
  /** Past NEAR_CAPACITY_FRACTION of the control-event budget: continuous moves are coalesced harder. */
  readonly nearCapacity: boolean;
  readonly degraded: boolean;
}

/** Emitted once per attempt when it passes NEAR_CAPACITY_FRACTION of its control-event budget. */
export interface RecorderNearCapacity {
  readonly kind: "recorder-near-capacity";
  readonly controlEvents: number;
  readonly controlEventBudget: number;
  /** The coalescing rate continuous controls are recorded at from now on. */
  readonly coalesceHz: number;
}

export interface RecorderEvents {
  "recorder-near-capacity": RecorderNearCapacity;
}

export interface RecorderOptions {
  /** Used when start() is given no expected duration. */
  readonly capacity: RecorderCapacity;
  readonly coalesceHz: number;
  /** How long stop() waits for meter frames up to the end of the attempt. */
  readonly drainTimeoutMs: number;
  readonly wallClock: () => Date;
}

/** For an attempt started without an expected duration: meters for 30 minutes, about 5 recorded commands a second. */
export const DEFAULT_RECORDER_CAPACITY: RecorderCapacity = { controlEvents: 10_000, meterFrames: 3 * 50 * 60 * 30 };
/** Share of the budget past which continuous moves are coalesced harder, and the app is told. */
export const NEAR_CAPACITY_FRACTION = 0.8;
/** Near capacity, continuous controls are coalesced to this fraction of coalesceHz. */
const NEAR_CAPACITY_COALESCE_FACTOR = 0.25;
/** Continuous controls assumed in motion at once, on average, when sizing a budget from a duration. */
const ESTIMATED_ACTIVE_CONTROLS = 2;
/** Headroom over the estimate, for busy passages and attempts that run long. */
const BUDGET_HEADROOM = 2;
const METERED_BUSES = 3;

/** Discrete events kept past the ceiling, at least: a press a second for almost three hours. */
const DISCRETE_RESERVE_MIN = 10_000;
const DEFAULT_OPTIONS: RecorderOptions = {
  capacity: DEFAULT_RECORDER_CAPACITY,
  coalesceHz: 30,
  drainTimeoutMs: 500,
  wallClock: () => new Date(),
};

const CONTRACT_CONTROLS: Partial<Record<EngineCommand["control"], ControlId>> = {
  "channel-fader": "channelFader",
  crossfader: "crossfader",
  trim: "trim",
  "eq-high": "eqHigh",
  "eq-mid": "eqMid",
  "eq-low": "eqLow",
  "headphone-cue": "cueMonitor",
  "deck-cue": "deckCue",
  tap: "tap",
  ready: "ready",
  done: "done",
};

/** The command's value in the Checks' units: positions as they are, trim and EQ in dB, buttons as 1/0. */
function contractValue(command: EngineCommand): number {
  switch (command.control) {
    case "trim":
      return toTimelineDecibels(trimKnobToDecibels(command.value));
    case "eq-high":
    case "eq-mid":
    case "eq-low":
      return toTimelineDecibels(eqKnobToDecibels(command.value));
    case "tap":
    case "done":
    case "ready":
      return 1;
    default:
      return "value" in command ? Number(command.value) : 1;
  }
}

function contractMixer(state: EngineMixerSnapshot): MixerSnapshot {
  const channel = (deck: DeckId) => {
    const knobs = state.channels[deck];
    return {
      channelFader: knobs["channel-fader"],
      trimDb: toTimelineDecibels(trimKnobToDecibels(knobs.trim)),
      eqHighDb: toTimelineDecibels(eqKnobToDecibels(knobs["eq-high"])),
      eqMidDb: toTimelineDecibels(eqKnobToDecibels(knobs["eq-mid"])),
      eqLowDb: toTimelineDecibels(eqKnobToDecibels(knobs["eq-low"])),
      cueMonitor: knobs.cue,
    };
  };
  return { A: channel("A"), B: channel("B"), crossfader: state.crossfader };
}

interface Recorded {
  readonly engine: CommandEvent;
  readonly contract: RecordedControlEvent | null;
}

interface Recording {
  readonly capacity: RecorderCapacity;
  readonly startedCtx: CtxTime;
  readonly startedAt: string;
  readonly initialMixer: MixerSnapshot;
  readonly initialTracks: Readonly<Record<DeckId, TrackRecord | null>>;
  readonly loadedDuring: Record<DeckId, TrackRecord[]>;
  readonly recorded: Recorded[];
  readonly held: Map<string, Recorded>;
  readonly lastKeptCtx: Map<string, CtxTime>;
  readonly meters: Record<MeterBus, BusMeterFrame[]>;
  /** The latest frame each bus delivered, kept or not: how far its meter has got. */
  readonly lastFrameCtx: Record<MeterBus, CtxTime>;
  readonly cuePoints: CuePointSet[];
  readonly interruptions: Interruption[];
  readonly deviceCounts: Map<InputDevice, number>;
  readonly unsubscribe: Unsubscribe;
  meterFrameCount: number;
  nearCapacity: boolean;
  outputDown: boolean;
  degraded: boolean;
}

export class AttemptRecorder {
  private readonly options: RecorderOptions;
  private readonly emitter = new Emitter<RecorderEvents>();
  private recording: Recording | null = null;
  /** A stopped recording still collecting its last meter frames. */
  private draining: Recording | null = null;

  constructor(
    private readonly engine: AudioEngine,
    options: Partial<RecorderOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  on<Name extends keyof RecorderEvents>(name: Name, listener: (payload: RecorderEvents[Name]) => void): Unsubscribe {
    return this.emitter.on(name, listener);
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  start(options: RecorderStartOptions = {}): Result {
    if (this.recording !== null) return fail({ kind: "recorder-already-recording" });
    const { expectedDurationSec } = options;
    if (expectedDurationSec !== undefined && !(Number.isFinite(expectedDurationSec) && expectedDurationSec > 0)) {
      return fail({ kind: "value-out-of-range", control: "expectedDurationSec", value: expectedDurationSec, min: 0, max: Number.MAX_VALUE });
    }
    const started = this.engine.heardTime();
    if (!started.ok) return started;

    const subscriptions = [
      this.engine.on("command", (event) => {
        this.onCommand(event);
      }),
      this.engine.on("meter", (frame) => {
        this.onMeterFrame(frame);
      }),
      this.engine.on("cue-point", (cuePoint) => this.recording?.cuePoints.push(cuePoint)),
      this.engine.on("interruption", (interruption) => this.recording?.interruptions.push(interruption)),
      this.engine.on("track-loaded", ({ deck, record }) => this.recording?.loadedDuring[deck].push(record)),
    ];
    this.recording = {
      capacity: expectedDurationSec === undefined ? this.options.capacity : this.capacityFor(expectedDurationSec),
      startedCtx: started.ctx,
      startedAt: this.options.wallClock().toISOString(),
      initialMixer: contractMixer(this.engine.mixerState()),
      initialTracks: { A: this.engine.trackHistory("A").at(-1) ?? null, B: this.engine.trackHistory("B").at(-1) ?? null },
      loadedDuring: { A: [], B: [] },
      recorded: [],
      held: new Map(),
      lastKeptCtx: new Map(),
      meters: { master: [], A: [], B: [] },
      lastFrameCtx: { master: Number.NEGATIVE_INFINITY, A: Number.NEGATIVE_INFINITY, B: Number.NEGATIVE_INFINITY },
      cuePoints: [],
      interruptions: [],
      deviceCounts: new Map(),
      unsubscribe: () => {
        for (const unsubscribe of subscriptions) unsubscribe();
      },
      meterFrameCount: 0,
      nearCapacity: false,
      outputDown: false,
      degraded: false,
    };
    return OK;
  }

  /** How full the current attempt is, or null when not recording. */
  usage(): RecorderUsage | null {
    const recording = this.recording;
    if (recording === null) return null;
    return {
      controlEvents: recording.recorded.length,
      controlEventBudget: recording.capacity.controlEvents,
      meterFrames: recording.meterFrameCount,
      meterFrameCapacity: recording.capacity.meterFrames,
      nearCapacity: recording.nearCapacity,
      degraded: recording.degraded,
    };
  }

  /** The app reports that the tab was hidden (at `performanceTimeMs`, or now). */
  markTabHidden(performanceTimeMs?: number): void {
    const recording = this.recording;
    if (recording === null) return;
    const heard = this.engine.heardTime(performanceTimeMs);
    recording.interruptions.push({ ctx: heard.ok ? heard.ctx : this.engine.context.currentTime, kind: "tabHidden" });
  }

  /** Ends the attempt, waiting for meter frames up to its end, and returns it in the contract's shape. */
  async stop(details: AttemptDetails): Promise<Result<{ attempt: RecordedAttempt }>> {
    const recording = this.recording;
    if (recording === null) return fail({ kind: "recorder-not-recording" });
    this.recording = null;
    this.draining = recording;

    const ended = this.engine.heardTime();
    if (!ended.ok) this.interrupt(recording, this.engine.context.currentTime);
    // If the output stopped, the attempt carries an interruption; the end is then the last known moment.
    const endedCtx = ended.ok ? ended.ctx : Math.max(recording.startedCtx, ...recording.recorded.map(({ engine }) => engine.appliedCtx));
    const drained = await this.drainMeters(recording, endedCtx);
    this.draining = null;
    recording.unsubscribe();
    if (!drained.ok) return drained;

    const decks = this.deckRecordings(recording);
    if (!decks.ok) return decks;
    for (const held of recording.held.values()) recording.recorded.push(held);
    const recorded = [...recording.recorded].sort((a, b) => timeOf(a.engine) - timeOf(b.engine));
    const events = recorded.flatMap(({ contract }) => (contract === null ? [] : [contract]));
    const inputDevice = details.inputDevice ?? mostUsed(recording.deviceCounts);
    if (inputDevice === null) return fail({ kind: "recorder-no-input-device" });
    const framesUntilEnd = (bus: MeterBus): MeterFrame[] =>
      recording.meters[bus].filter((frame) => frame.ctx <= endedCtx).map(({ ctx, samplePeakDb, momentaryLufs, shortTermLufs }) => ({
        ctx,
        samplePeakDb,
        momentaryLufs,
        shortTermLufs,
      }));

    return {
      ok: true,
      attempt: {
        attemptId: details.attemptId,
        learnerId: details.learnerId,
        startedAt: recording.startedAt,
        endedAt: this.options.wallClock().toISOString(),
        endReason: details.endReason,
        inputDevice,
        abandoned: details.abandoned,
        interruptions: recording.interruptions,
        events,
        decks: decks.decks,
        grids: decks.grids,
        phraseMarkers: details.phraseMarkers,
        cuePoints: recording.cuePoints,
        meters: { master: framesUntilEnd("master"), A: framesUntilEnd("A"), B: framesUntilEnd("B") },
        initialMixer: recording.initialMixer,
        answers: details.answers,
        engineEvents: recorded.map(({ engine }) => engine),
        startedCtx: recording.startedCtx,
        endedCtx,
        degraded: recording.degraded,
      },
    };
  }

  private capacityFor(durationSec: number): RecorderCapacity {
    return {
      controlEvents: Math.ceil(durationSec * ESTIMATED_ACTIVE_CONTROLS * this.options.coalesceHz * BUDGET_HEADROOM),
      meterFrames: Math.ceil(durationSec * METERED_BUSES * METER_FRAMES_PER_SECOND * BUDGET_HEADROOM),
    };
  }

  private deckRecordings(
    recording: Recording,
  ): Result<{ decks: Partial<Record<DeckId, DeckRecording>>; grids: Record<string, BeatGrid> }> {
    const decks: Partial<Record<DeckId, DeckRecording>> = {};
    const grids: Record<string, BeatGrid> = {};
    for (const deck of DECK_IDS) {
      const initial = recording.initialTracks[deck];
      const loaded = recording.loadedDuring[deck];
      if (loaded.length > (initial === null ? 1 : 0)) return fail({ kind: "recorder-track-changed", deck });
      const track = loaded[0] ?? initial;
      if (track === null) continue;
      decks[deck] = { trackId: track.trackId, playhead: { segments: track.playhead.segments() } };
      if (track.grid !== null) grids[track.trackId] = track.grid;
    }
    return { ok: true, decks, grids };
  }

  /** Waits until every bus has delivered its frames up to the end (or as far as the context has rendered). */
  private async drainMeters(recording: Recording, endedCtx: CtxTime): Promise<Result> {
    // The last frame that ends at or before the end (frames are a whole number of samples long).
    const { sampleRate } = this.engine.context;
    const frameSec = Math.round(sampleRate / METER_FRAMES_PER_SECOND) / sampleRate;
    const until = Math.min(endedCtx, this.engine.context.currentTime);
    const target = Math.floor(until / frameSec + 1e-9) * frameSec;
    const drained = () =>
      target <= recording.startedCtx ||
      (["master", "A", "B"] as const).every((bus) => recording.lastFrameCtx[bus] >= target - 1e-9);
    const startedAt = performance.now();
    while (!drained()) {
      if (performance.now() - startedAt > this.options.drainTimeoutMs) {
        return fail({ kind: "meter-drain-timeout", waitedMs: this.options.drainTimeoutMs });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return OK;
  }

  private interrupt(recording: Recording, ctx: CtxTime): void {
    if (recording.outputDown) return;
    recording.outputDown = true;
    recording.interruptions.push({ ctx, kind: "contextSuspended" });
  }

  private onCommand(event: CommandEvent): void {
    const recording = this.recording;
    if (recording === null) return;
    if (event.heardCtx === null && event.device !== "engine") this.interrupt(recording, event.appliedCtx);
    else if (event.heardCtx !== null) recording.outputDown = false;
    if (event.device !== "engine") recording.deviceCounts.set(event.device, (recording.deviceCounts.get(event.device) ?? 0) + 1);

    const entry: Recorded = { engine: event, contract: this.contractEvent(event) };
    // Refused and engine-made moves are coalesced on their own, so they never replace an accepted move.
    const origin = event.rejected !== null ? "refused" : event.device === "engine" ? "engine" : "input";
    const key = `${"deck" in event.command ? event.command.deck : "-"}:${event.command.control}:${origin}`;
    const time = timeOf(event);
    const lastKept = recording.lastKeptCtx.get(key);
    const coalesce =
      CONTINUOUS_CONTROLS.has(event.command.control) &&
      !event.gestureEnd &&
      lastKept !== undefined &&
      time - lastKept < 1 / this.coalesceHz(recording);
    if (coalesce) {
      recording.held.set(key, entry);
      return;
    }
    recording.held.delete(key);
    if (!this.hasRoomFor(recording, event)) {
      recording.degraded = true;
      return;
    }
    recording.recorded.push(entry);
    recording.lastKeptCtx.set(key, time);
    this.checkNearCapacity(recording);
  }

  private coalesceHz(recording: Recording): number {
    return this.options.coalesceHz * (recording.nearCapacity ? NEAR_CAPACITY_COALESCE_FACTOR : 1);
  }

  private checkNearCapacity(recording: Recording): void {
    const budget = recording.capacity.controlEvents;
    if (recording.nearCapacity || recording.recorded.length < NEAR_CAPACITY_FRACTION * budget) return;
    recording.nearCapacity = true;
    this.emitter.emit("recorder-near-capacity", {
      kind: "recorder-near-capacity",
      controlEvents: recording.recorded.length,
      controlEventBudget: budget,
      coalesceHz: this.coalesceHz(recording),
    });
  }

  /**
   * Continuous moves fill the budget up to its ceiling. Discrete events go on past it into a reserve at
   * least as large again (and never under DISCRETE_RESERVE_MIN presses), which no Learner reaches; past
   * that, even they stop, so memory stays bounded.
   */
  private hasRoomFor(recording: Recording, event: CommandEvent): boolean {
    const ceiling = recording.capacity.controlEvents;
    if (CONTINUOUS_CONTROLS.has(event.command.control)) return recording.recorded.length < ceiling;
    return recording.recorded.length < ceiling + Math.max(ceiling, DISCRETE_RESERVE_MIN);
  }

  private contractEvent(event: CommandEvent): RecordedControlEvent | null {
    const control = CONTRACT_CONTROLS[event.command.control];
    if (control === undefined || event.rejected !== null || event.heardCtx === null || event.device === "engine") return null;
    const base = { ctx: event.heardCtx, control, value: contractValue(event.command), appliedCtx: event.appliedCtx, inputDevice: event.device };
    return "deck" in event.command ? { ...base, deck: event.command.deck } : base;
  }

  private onMeterFrame(frame: BusMeterFrame): void {
    const recording = this.recording ?? this.draining;
    if (recording === null || frame.ctx < recording.startedCtx) return;
    recording.lastFrameCtx[frame.bus] = Math.max(recording.lastFrameCtx[frame.bus], frame.ctx);
    if (recording.meterFrameCount >= recording.capacity.meterFrames) {
      recording.degraded = true;
      return;
    }
    recording.meters[frame.bus].push(frame);
    recording.meterFrameCount++;
  }
}

function timeOf(event: CommandEvent): CtxTime {
  return event.heardCtx ?? event.appliedCtx;
}

function mostUsed(counts: ReadonlyMap<InputDevice, number>): InputDevice | null {
  let best: { device: InputDevice; count: number } | null = null;
  for (const [device, count] of counts) if (best === null || count > best.count) best = { device, count };
  return best?.device ?? null;
}
