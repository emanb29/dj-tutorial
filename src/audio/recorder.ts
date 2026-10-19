// Records an attempt in the canonical shape the Checks read (`Attempt` in shared/attempt.ts):
// control events at heard time in the Checks' units, each with the time it took effect (`appliedCtx`), the
// playhead model of each deck, grids, cue points, 50 Hz meters per bus, the mixer and the decks' controls
// at the start, and interruptions. The engine-to-contract mapping is CONTRACT_CONTROLS and contractValue.
//
// Extras the Checks ignore: each event's `inputDevice`, and `engineEvents`, every command the engine saw
// (including ones the contract has no control id for and refused ones), for debugging.
//
// Pointer-rate moves of continuous controls are coalesced to `coalesceHz` per control: the first move is
// kept at once, later moves within the interval are held and only the newest is kept, and a gesture's
// last event (CommandInput.gestureEnd) and the held move at stop are always recorded. Refused moves and
// the engine's own are coalesced the same way, each on their own so they never displace accepted moves.
// Jog bends are never coalesced: the playhead model keeps every rate change, and the Checks divide the
// bend back out of that rate (src/checks/phase.ts `tempoBpmAt`), so a dropped bend reads as a tempo
// jump for as long as it lasted (ISS-103). The controller already sends at most one a frame.
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
  DeckStateSnapshot,
  BeatGrid,
  Interruption,
  MeterFrame,
  MixerSnapshot,
} from "@shared/attempt.ts";
import { CONTINUOUS_CONTROLS, type Control, type EngineCommand } from "./commands.ts";
import { eqKnobToDecibels, toTimelineDecibels, trimKnobToDecibels } from "./curves.ts";
import type { TrackRecord } from "./deck.ts";
import type { AudioEngine, CommandEvent, EngineDeckSnapshot, EngineMixerSnapshot } from "./engine.ts";
import { Emitter, type Unsubscribe } from "./events.ts";
import { METER_FRAMES_PER_SECOND } from "./loudness.ts";
import type { BusMeterFrame, MeterBus } from "./meter.ts";
import { fail, OK, type Result } from "./result.ts";
import { DECK_IDS, type CtxTime, type DeckId, type InputDevice } from "./types.ts";

/** A contract control event, always with its applied time, plus the input device (an extra the Checks ignore). */
export interface RecordedControlEvent extends ControlEvent {
  readonly appliedCtx: CtxTime;
  /** `"engine"` for a change the engine made itself (`byEngine`). */
  readonly inputDevice: InputDevice | "engine";
}

export interface RecordedAttempt extends Attempt {
  readonly events: readonly RecordedControlEvent[];
  /**
   * Every command the engine saw during the attempt, in order, for debugging: refused ones too, and controls
   * the contract has no id for. The Checks never read it; everything they grade is in the contract fields.
   */
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
  /**
   * Allow tracks to be loaded on a deck during the attempt (a Check that runs on several tracks in turn:
   * `cue-point`'s slices, a `final-mix` set). The deck's recording is then its last track, with the
   * tracks it held before in `earlier`, and `grids` holds every track loaded during the attempt, so
   * cue points (which carry their track id) grade on the right grid. Off by default: a Lesson Check
   * has one track per deck.
   */
  readonly allowTrackChanges?: boolean;
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
const METERED_BUSES = 4;

/** Discrete events kept past the ceiling, at least: a press a second for almost three hours. */
const DISCRETE_RESERVE_MIN = 10_000;
/** Continuous controls recorded at every move: the bend is divided out of the recorded rate. */
const NEVER_COALESCED: ReadonlySet<Control> = new Set(["jog-bend"]);
const DEFAULT_OPTIONS: RecorderOptions = {
  capacity: DEFAULT_RECORDER_CAPACITY,
  coalesceHz: 30,
  drainTimeoutMs: 500,
  wallClock: () => new Date(),
};

/**
 * The contract control each engine command is recorded as (units in shared/attempt.ts `ControlId`), or
 * null with the reason it is not one. Every engine control is listed, so a new one needs a decision here.
 */
const CONTRACT_CONTROLS: Readonly<Record<Control, ControlId | null>> = {
  "channel-fader": "channelFader",
  crossfader: "crossfader",
  trim: "trim",
  "eq-high": "eqHigh",
  "eq-mid": "eqMid",
  "eq-low": "eqLow",
  filter: "filter",
  "headphone-cue": "cueMonitor",
  play: "play",
  "deck-cue": "deckCue",
  tempo: "tempo",
  // A range switch changes the rate the fader gives, so it is recorded as the new tempo.
  "tempo-range": "tempo",
  "jog-bend": "jogBend",
  sync: "sync",
  "master-tempo": "masterTempo",
  "hot-cue-set": "hotCueSet",
  "hot-cue": "hotCue",
  "loop-in": "loopIn",
  "loop-out": "loopOut",
  "loop-auto": "loopAuto",
  "loop-double": "loopDouble",
  "loop-halve": "loopHalve",
  "loop-exit": "loopExit",
  "beat-fx": "beatFx",
  "beat-fx-channel": "beatFxChannel",
  "beat-fx-beats": "beatFxBeats",
  "beat-fx-depth": "beatFxDepth",
  // The echo's tempo (TAP / AUTO) only shapes what is heard: the Checks grade the echo from the FX return meter.
  "beat-fx-bpm": null,
  tap: "tap",
  ready: "ready",
  done: "done",
  // Clearing a pad changes no sound and no grade: a cleared pad pressed again records a new hotCueSet.
  "hot-cue-clear": null,
  // Pausing, seeking and jog search (the jog on a paused deck) move the playhead: the playhead model holds them.
  pause: null,
  seek: null,
  "jog-search": null,
  // These shape only what the Learner monitors (master knob, headphone mix and level); no criterion grades them.
  "master-level": null,
  "cue-mix": null,
  "headphone-level": null,
};

/**
 * The command's value in the Checks' units: positions as they are, trim and EQ in dB, buttons and
 * switches as 1/0, tempo as the deck's rate ratio after the command (read from the engine, since the
 * fader's rate depends on its range).
 */
function contractValue(command: EngineCommand, engine: AudioEngine): number {
  switch (command.control) {
    case "trim":
      return toTimelineDecibels(trimKnobToDecibels(command.value));
    case "eq-high":
    case "eq-mid":
    case "eq-low":
      return toTimelineDecibels(eqKnobToDecibels(command.value));
    case "tempo":
    case "tempo-range":
      return engine.deckState(command.deck).tempoRate;
    case "hot-cue-set":
    case "hot-cue":
      return command.slot + 1;
    case "loop-out":
    case "loop-auto":
    case "loop-double":
    case "loop-halve": {
      const loop = engine.deckState(command.deck).loop;
      return loop === null ? 0 : loop.end - loop.start;
    }
    case "beat-fx-channel":
    case "loop-in":
    case "loop-exit":
    case "tap":
    case "done":
    case "ready":
    case "play":
      return 1;
    default:
      return "value" in command ? Number(command.value) : 1;
  }
}

/** Track seconds the command placed or jumped to (shared/attempt.ts `ControlEvent.pos`), read after it applied. */
function contractPos(command: EngineCommand, engine: AudioEngine): number | undefined {
  switch (command.control) {
    case "hot-cue-set":
    case "hot-cue":
      return engine.deckState(command.deck).hotCues[command.slot] ?? undefined;
    case "loop-in":
      return engine.deckState(command.deck).loopInSec ?? undefined;
    case "loop-out":
    case "loop-auto":
    case "loop-double":
    case "loop-halve":
      return engine.deckState(command.deck).loop?.start;
    default:
      return undefined;
  }
}

/** The deck a command is recorded on: its own, or for CH SELECT the channel it picked (none for MASTER). */
function contractDeck(command: EngineCommand): DeckId | undefined {
  if ("deck" in command) return command.deck;
  return command.control === "beat-fx-channel" && command.value !== "master" ? command.value : undefined;
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
      filter: knobs.filter,
      cueMonitor: knobs.cue,
    };
  };
  return { A: channel("A"), B: channel("B"), crossfader: state.crossfader, beatFx: state.beatFx };
}

function contractDeckState(state: EngineDeckSnapshot): DeckStateSnapshot {
  return { tempo: state.tempoRate, jogBend: state.jogBend, sync: state.syncOn, masterTempo: state.masterTempo, hotCues: state.hotCues, loop: state.loop };
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
  readonly initialDecks: Record<DeckId, DeckStateSnapshot>;
  readonly initialTracks: Readonly<Record<DeckId, TrackRecord | null>>;
  readonly loadedDuring: Record<DeckId, TrackRecord[]>;
  readonly allowTrackChanges: boolean;
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
      initialDecks: { A: contractDeckState(this.engine.deckState("A")), B: contractDeckState(this.engine.deckState("B")) },
      initialTracks: { A: this.engine.trackHistory("A").at(-1) ?? null, B: this.engine.trackHistory("B").at(-1) ?? null },
      loadedDuring: { A: [], B: [] },
      allowTrackChanges: options.allowTrackChanges ?? false,
      recorded: [],
      held: new Map(),
      lastKeptCtx: new Map(),
      meters: { master: [], A: [], B: [], fx: [] },
      lastFrameCtx: { master: Number.NEGATIVE_INFINITY, A: Number.NEGATIVE_INFINITY, B: Number.NEGATIVE_INFINITY, fx: Number.NEGATIVE_INFINITY },
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

    const decks = this.deckRecordings(recording, endedCtx);
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
        meters: { master: framesUntilEnd("master"), A: framesUntilEnd("A"), B: framesUntilEnd("B"), fxReturn: framesUntilEnd("fx") },
        initialMixer: recording.initialMixer,
        initialDecks: recording.initialDecks,
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
    endedCtx: CtxTime,
  ): Result<{ decks: Partial<Record<DeckId, DeckRecording>>; grids: Record<string, BeatGrid> }> {
    const decks: Partial<Record<DeckId, DeckRecording>> = {};
    const grids: Record<string, BeatGrid> = {};
    for (const deck of DECK_IDS) {
      const initial = recording.initialTracks[deck];
      const loaded = recording.loadedDuring[deck];
      if (!recording.allowTrackChanges && loaded.length > (initial === null ? 1 : 0)) return fail({ kind: "recorder-track-changed", deck });
      const held = [initial, ...loaded].filter((record) => record !== null);
      const track = held.at(-1);
      if (track === undefined) continue;
      const onDeck = (record: TrackRecord) => ({ trackId: record.trackId, playhead: { segments: record.playhead.segments(endedCtx) }, loadedCtx: record.loadedAtCtx });
      const earlier = held.slice(0, -1).map(onDeck);
      decks[deck] = { ...onDeck(track), ...(earlier.length === 0 ? {} : { earlier }) };
      for (const each of held) if (each.grid != null) grids[each.trackId] = each.grid;
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
      (["master", "A", "B", "fx"] as const).every((bus) => recording.lastFrameCtx[bus] >= target - 1e-9);
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
      !NEVER_COALESCED.has(event.command.control) &&
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

  /**
   * The command as a contract event, or null when the Checks do not read it: refused commands, controls
   * the contract has no id for, and input heard while the output was down (the attempt is then void).
   * A change the engine made itself has no heard time: it is placed when it took effect.
   */
  private contractEvent(event: CommandEvent): RecordedControlEvent | null {
    const control = CONTRACT_CONTROLS[event.command.control];
    if (control === null || event.rejected !== null) return null;
    const value = contractValue(event.command, this.engine);
    const pos = contractPos(event.command, this.engine);
    const deck = contractDeck(event.command);
    const base =
      event.device === "engine"
        ? { ctx: event.appliedCtx, control, value, appliedCtx: event.appliedCtx, inputDevice: "engine" as const, byEngine: true }
        : event.heardCtx === null
          ? null
          : { ctx: event.heardCtx, control, value, appliedCtx: event.appliedCtx, inputDevice: event.device };
    if (base === null) return null;
    return { ...base, ...(deck === undefined ? {} : { deck }), ...(pos === undefined ? {} : { pos }) };
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
