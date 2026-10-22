// One Lesson on one engine, outside React (ADR 0001): sets the decks up for the hook, practice and the
// Check, turns engine commands into `Observation`s for the runtime, records the Check attempt with the
// AttemptRecorder and grades it. The pure runtime (src/lessons/runtime.ts) decides what happens next.
//
// The audio part of a Check ends (and the recorder stops) before any questions are asked, so the
// grading window and the end reason never include the time spent answering.
import { AttemptRecorder, eqKnobToDecibels, trimKnobToDecibels, type AudioEngine, type CommandEvent, type EngineCommand, type RecordedAttempt, type Result } from "@audio";
import { CLASH_LOW_DB, cuePlacement, runCheck } from "@checks";
import {
  askDone,
  blendPose,
  checkDecksFor,
  checkSpecFor,
  classifyTap,
  EQ_CENTRED_DB,
  EQ_CUT_DB,
  FILTER_CENTRED,
  GAIN_ZONE_DB,
  LESSON_GRADING,
  practiceDecksFor,
  practiceLoopFor,
  practiceRep,
  sliceTrack,
  tempoPercentApart,
  trackOnDeck,
  followBlend,
  PHRASE_COUNT_START,
  phraseCountStep,
  phrasePosition,
  START_BLEND,
  triggerStep,
  withPlannedGrids,
  type BlendFollow,
  type CheckPlan,
  type EqBand,
  type ListeningClip,
  type PhrasePreviews,
  phrasePreviewSpan,
  previewPhraseAt,
  type DeckSetup,
  type DeckSetups,
  type Grading,
  type LessonDefinition,
  type LessonTrack,
  type HookTrigger,
  type LoopPlan,
  type Observation,
  type PhraseCountState,
  type PhrasePosition,
  type PositionCue,
  type SetUpReading,
  type SetUpStepPlan,
  trimmedPeakDb,
} from "@lessons";
import type { DeckId, LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { commandFor, type ContinuousControlId } from "../controller/gestures.ts";
import { CONTINUOUS_CONTROLS, describeTarget, liveHardwareView, matchItems, settledValue, setUpTargets, stepTargets, type HardwareView, type MatchItem, type SetUpTarget } from "./hardware-sync.ts";
import { DrillRunner, liveReading, type DrillStatus } from "./practice-drill.ts";

/** How often the session looks at the playhead to end the audio part or loop practice. */
const WATCH_MS = 25;
/**
 * How long after sending the Check's cue the heard playhead may still show the old position: the
 * engine's scheduling lookahead (base latency plus a render quantum, or the stretch lead with Master
 * Tempo on), with room to spare. Ending or looping waits this long; no Check ends that soon.
 */
const CUE_SETTLE_SEC = 0.3;
/** After a fade out, keep recording this long so the meters see the silence. */
const FADE_OUT_SETTLE_MS = 300;
const FADER_UP = 0.9;
/** A channel fader this low counts as closed (Placement's faded-out-then tasks). */
const FADER_DOWN = 0.05;
/**
 * The fader's bottom: a faded-out Check ends only there, where its fade-out criterion grades the fader
 * (deck-basics, "fader ended at 0%"). Ending on the way down (it once ended at 5%) cut off a finger still
 * pulling, or a final move a busy main thread had not got to yet, and failed a fade that reached 0.
 */
const FADER_BOTTOM = 0;
/** Level readings for the gain-staging hook and practice: the peak over the last second, twice a second. */
const LEVEL_WINDOW_SEC = 1;
const LEVEL_EVERY_MS = 500;
/** Practice Ready: both decks' peaks this close count as matched (the Check's loud-match limit). */
const LEVEL_MATCH_DB = 1.5;
/** A cut on the phrase in practice: Play B within this of A's phrase start (the Lesson's ±120 ms). */
const CUT_TOLERANCE_MS = 120;
/** A "held" Check end trusts the decks between two live looks at most this far apart. */
const HELD_GAP_MS = 150;
/** A loop, an EXIT or an echo cut counts as on a downbeat within this (the Checks' ±1 beat). */
const DOWNBEAT_SLACK_BEATS = 1;
/** tempo-fader practice: B's BPM this close to the target is on it (the Check's set-bpm limit). */
const BPM_TOLERANCE = 0.05;
const EQ_BANDS: Readonly<Record<"eq-low" | "eq-mid" | "eq-high", EqBand>> = { "eq-low": "low", "eq-mid": "mid", "eq-high": "high" };
/** A's LOW going down and B's coming up pair as one swap within this (the bass-swap Check's pairing). */
const SWAP_PAIR_BARS = 2;
const DEVICE = { device: "keyboard" } as const;
const DECKS: readonly DeckId[] = ["A", "B"];
/** A set-up step loops deck A's first phrase: 8 bars. */
const BARS_PER_PHRASE = 8;
/** A set-up step's line once everything it asks is done: it goes on where A's phrase comes round. */
const ALL_SET_CAPTION = "All set: starts on the next phrase";
/** Practice's set-up step for a Lesson whose Check names none (none does: every practiceSetUp Lesson has one). */
const NO_ASKS: SetUpStepPlan = { caption: "Set up", asks: [] };

export type GradeOutcome =
  | { readonly ok: true; readonly outcome: CheckResult | VoidAttempt }
  | { readonly ok: false; readonly message: string };

/** The live 8-bar count in the phrases hook and practice: where deck A is heard, and whether it shows. */
export interface PhraseCount extends PhrasePosition {
  /** False once the Learner taps phrases by ear ("now by ear"); back after 2 misses in a row. */
  readonly shown: boolean;
}

export interface BeatClock {
  /** performance.now() milliseconds of the next beat heard. */
  readonly nextBeatAtMs: number;
  /** The next beat's index on the track's grid. */
  readonly nextBeat: number;
  readonly beatMs: number;
  /** 1–4. */
  readonly beatInBar: number;
}

/**
 * The set-up step showing now: the controller's faders and knobs to match before the decks start
 * (hardware-sync.ts), and the set-up's own caption ("Set up: CUE 🎧 B on, fader B up"), if it has one.
 * With no caption it goes on once every item ticks, or Skip. With one, once every item has ticked and
 * everything the caption asks is done, where deck A's looped phrase comes round; or at once on R
 * (every item ticked), or Skip.
 */
export interface SetUpPending {
  /** The set-up step's own line (`CheckPlan.setUp`, `practiceSetUp`), "All set: …" once it is; null for none. */
  readonly caption: string | null;
  readonly items: readonly MatchItem[];
}

/**
 * A set-up waiting: what it sets, and what it does once matched (or skipped). `step` is a set-up step
 * of the Lesson's own (`CheckPlan.setUp`, `LessonDefinition.practiceSetUp`), with `own` its caption and
 * asks: deck A loops the phrase from its start while the Learner sets up, and a Check's recorder and
 * clock start only once the step goes on (at the phrase's end once all is set, or on R). Without
 * `step`, the decks are paused until the controller matches.
 */
interface PendingSetUp {
  readonly targets: readonly SetUpTarget[];
  readonly proceed: () => void;
  readonly step: { readonly kind: "check"; readonly plan: CheckPlan } | { readonly kind: "practice" } | null;
  readonly own: SetUpStepPlan | null;
  shown: SetUpPending;
}

interface RunningCheck {
  readonly plan: CheckPlan;
  readonly startedMs: number;
  /** Ready presses so far, per deck: heard time of the last one. */
  readonly readies: Map<DeckId, number>;
  readyCount: number;
  /** cue-point: the slice on deck A now (index into plan.slices), and whether its cue point is set. */
  slice: number;
  sliceCued: boolean;
  /** Set once the audio part ended: the recorder's stop, with the end reason. */
  stopped: Promise<Result<{ attempt: RecordedAttempt }>> | null;
  /** A "held" end: performance.now() since B has stayed with A, while it does. */
  heldFromMs: number | null;
  /** A "held" end: performance.now() of the last live look at the decks. */
  heldSeenMs: number | null;
  /** performance.now() when the Learner last closed each channel fader, while it stays closed. */
  readonly closedAtMs: Map<DeckId, number>;
  /**
   * The audio clock when the Check's own cue (seek to its start, then Play) was sent. Until heard time
   * reaches it, the heard playhead still shows wherever practice left the deck, possibly past the
   * Check's end, so no position may end the Check or loop it before then.
   */
  readonly cueCtx: number;
  /** hot-cues: the stop deck A waits at (index into plan.stops), and whether a pad was set there. */
  stop: number;
  stopSet: boolean;
  /**
   * performance.now() when the Check's audio part proper began: at the start, or after the last stop.
   * `plan.timeoutSec` counts from here; the stops have their own `plan.stopsTimeoutSec`.
   */
  playingFromMs: number | null;
  /** Steps of plan.stepCues done so far, in order. */
  steps: number;
  /** How often the `did-then` end's action happened, and when it last did (performance.now()). */
  did: number;
  didAtMs: number | null;
  /** The far-tap cue shows until deck A is heard at this track position (plan.farTapCue). */
  farTapUntilPos: number | null;
}

export class LessonSession {
  private readonly recorder: AttemptRecorder;
  private readonly unsubscribe: () => void;
  private watch: ReturnType<typeof setInterval> | null = null;
  private readonly levelTimer: ReturnType<typeof setInterval>;
  private check: RunningCheck | null = null;
  /** The plan of the Check graded last, while its result shows: the result card's ▶ replays its phrases. */
  private gradedPlan: CheckPlan | null = null;
  /** The track on each deck now: the Lesson track, or a cue-point slice on A. */
  private readonly onDeck: Record<DeckId, LessonTrack | null>;
  /** The track id of the last load asked for on deck A (it wins in the engine). */
  private requestedA: string;
  private readonly peaks: Record<DeckId, { ctx: number; peak: number }[]> = { A: [], B: [] };
  private readonly lastLevel: Record<DeckId, number | null> = { A: null, B: null };
  private faderWasUp = false;
  /** Decks whose LOW is cut now (at or below the kill line), for the eq-basics practice rep. */
  private readonly lowCut: Record<DeckId, boolean> = { A: false, B: false };
  /** Each deck's LOW in dB as the Learner left it, for the bass-swap practice rep. */
  private readonly lowDb: Record<DeckId, number> = { A: 0, B: 0 };
  /** Heard time of each half of a swap not yet paired: A's LOW down through −6 dB, B's up through it. */
  private readonly swapHalf: Record<DeckId, number | null> = { A: null, B: null };
  /** The high-pass sweep on CFX A now (filter-transition practice): heard time it began, deepest point. */
  private sweep: { readonly fromCtx: number; depth: number } | null = null;
  /** Whether each channel fader is open now, so a close is seen once. */
  private readonly faderOpen: Record<DeckId, boolean> = { A: true, B: true };
  /** sync-blend: how far the Learner is through the stepped blend (blend-steps.ts). */
  private blend: BlendFollow = START_BLEND;
  /** The listening clip playing now (tempo-fader questions), if any. */
  private clip: ListeningClip | null = null;
  /** The phrases hook and practice's 8-bar count, and the phrase whose start it last judged. */
  private phraseCountState: PhraseCountState = PHRASE_COUNT_START;
  private judgedPhrase: number | null = null;
  /**
   * The phrase preview playing now (phrases' questions): the chip it was started from (1-based), where
   * it stops, and when its seek takes effect (before then, the heard playhead is still where A was).
   */
  private preview: { readonly phrase: number; readonly previews: PhrasePreviews; readonly untilPos: number; readonly seekCtx: number } | null = null;
  /** The by-ear practice drill running now (Lessons 14–16), if any. */
  private drill: DrillRunner | null = null;
  /**
   * Check attempts started, for the plan's per-attempt variation (which clip has Master Tempo on). It
   * starts at a random count, so a Lesson opened again does not replay the same answers in order.
   */
  private checksStarted = Math.floor(Math.random() * 1000);
  /** Commands the session sends itself (set-up) are not the Learner's: no observations from them. */
  private settingUp = false;
  /** Bumped by every set-up, so a slow load that finishes late does not set up an old phase. */
  private generation = 0;
  private closed = false;
  /** The set-up waiting for the Learner (to match the controller, or to press R), if any. */
  private pendingSetUp: PendingSetUp | null = null;
  /** Deliberate controls the Learner skipped matching: set in software from then on, for this session. */
  private readonly skippedControls = new Set<ContinuousControlId>();
  private readonly setUpListeners = new Set<() => void>();
  /** While a set-up step's decks are cued: its faders and knobs stay where the hardware has them. */
  private cueingStep = false;
  private readonly stopHardware: () => void;

  constructor(
    private readonly engine: AudioEngine,
    private readonly definition: LessonDefinition,
    readonly track: LessonTrack,
    private readonly audio: AudioBuffer,
    private readonly learnerId: string,
    private readonly listener: {
      readonly observed: (observation: Observation) => void;
      readonly audioEnded: () => void;
      /** The Check could not start recording; it will not end or grade by itself. */
      readonly checkFailed: (message: string) => void;
      /** A by-ear practice drill's feedback line, and whether the covered displays show now. */
      readonly drillStatus?: (status: DrillStatus) => void;
    },
    hasDeckB: boolean,
    /** How attempts are graded: a Lesson Check, or (Placement) a short-form task. */
    private readonly grading: Grading = LESSON_GRADING,
    /** The DDJ-FLX4, when connected: set-ups follow its faders and knobs (hardware-sync.ts). */
    private readonly hardware: HardwareView = liveHardwareView(),
  ) {
    this.recorder = new AttemptRecorder(engine);
    this.stopHardware = hardware.subscribe(() => {
      this.hardwareChanged();
    });
    this.onDeck = { A: track, B: hasDeckB ? trackOnDeck(track, "B") : null };
    this.requestedA = track.trackId;
    const stops = [
      engine.on("command", (event) => {
        this.onCommand(event);
        // CUE 🎧, SYNC, a fader or a knob may be what a set-up step asks for (or SYNC dropped).
        this.showStep();
      }),
      engine.on("cue-point", (cue) => {
        this.onCuePoint(cue.deck, cue.pos);
      }),
      engine.on("meter", (frame) => {
        if (frame.bus === "A" || frame.bus === "B") this.peaks[frame.bus].push({ ctx: frame.ctx, peak: frame.samplePeakDb });
      }),
    ];
    this.unsubscribe = () => {
      for (const stop of stops) stop();
    };
    this.levelTimer = setInterval(() => {
      this.readLevels();
    }, LEVEL_EVERY_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Whether a Lesson plays a track on deck B too (gain-staging, headphone-cue, cut-on-phrase). */
  static usesDeckB(definition: LessonDefinition, track: LessonTrack): boolean {
    return practiceDecksFor(definition, track).B !== undefined || definition.planCheck(track).deckB !== undefined;
  }

  /** The track on a deck now (a cue-point slice on A during that Check). */
  deckTrack(deck: DeckId): LessonTrack | null {
    return this.onDeck[deck];
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") this.recorder.markTabHidden();
  };

  private observe(observation: Observation): void {
    // Matching the controller is not the Lesson yet; a set-up step's moves (CUE B on, …) are the Learner's.
    if (this.settingUp || (this.pendingSetUp !== null && this.pendingSetUp.step === null)) return;
    this.progress(observation);
    this.countPhraseAction(observation);
    this.listener.observed(observation);
  }

  /** The practice count fades and comes back on the Lesson's phrase-timed reps (Count phrases' taps are counted in onTap). */
  private countPhraseAction(observation: Observation): void {
    const { definition } = this;
    if (definition.phraseCount !== true || definition.practice.rep === "phrase-tap" || this.check !== null || this.pendingSetUp?.step?.kind === "check") return;
    const good = practiceRep(definition.practice, observation);
    if (good !== null) this.phraseCountState = phraseCountStep(this.phraseCountState, { kind: "action", good });
  }

  /** What a running Check counts from the Learner's actions: its step cues, its `did-then` end, a pad set at a stop. */
  private progress(observation: Observation): void {
    const check = this.check;
    if (check?.stopped !== null) return;
    if (observation.kind === "hot-cue-set") check.stopSet = true;
    // At the stops the Learner sets pads (and may press one to hear it): that is not the Check's playing yet.
    if (check.playingFromMs === null) return;
    const done = (trigger: HookTrigger) => triggerStep(trigger, observation) === 1;
    const step = check.plan.stepCues?.[check.steps];
    if (step !== undefined && done(step.after)) check.steps += 1;
    const end = check.plan.endWhen;
    if (end.kind === "did-then" && done(end.what)) {
      check.did += 1;
      check.didAtMs = performance.now();
    }
  }

  private onCommand(event: CommandEvent): void {
    if (event.rejected !== null || event.device === "engine" || this.settingUp) return;
    const { command } = event;
    switch (command.control) {
      case "play":
      case "pause":
        this.observe({ kind: "play", deck: command.deck, playing: this.engine.deckState(command.deck).playing });
        if (command.control === "play" && command.deck === "B") this.onPlayB(event.heardCtx);
        return;
      case "channel-fader":
        this.onFader(command.deck, command.value, event.heardCtx);
        return;
      case "filter":
        this.onFilter(command.deck, command.value, event.heardCtx);
        return;
      case "hot-cue-set":
        this.observe({ kind: "hot-cue-set", deck: command.deck, slot: command.slot + 1 });
        return;
      case "hot-cue": {
        const offsetMs = this.phraseOffsetMs(command.deck, event.heardCtx);
        this.observe({ kind: "hot-cue", deck: command.deck, slot: command.slot + 1, offsetMs, onPhrase: offsetMs !== null && Math.abs(offsetMs) <= CUT_TOLERANCE_MS });
        return;
      }
      case "loop-in":
        this.observe({ kind: "loop-in", deck: command.deck });
        return;
      case "loop-out":
      case "loop-auto":
      case "loop-double":
      case "loop-halve":
        this.onLoop(command.deck);
        return;
      case "loop-exit": {
        const offset = this.downbeatOffsetBeats(command.deck, event.heardCtx);
        this.observe({ kind: "loop-exit", deck: command.deck, onDownbeat: offset !== null && Math.abs(offset) <= DOWNBEAT_SLACK_BEATS });
        return;
      }
      case "beat-fx":
        this.observe({ kind: "beat-fx", on: command.value });
        return;
      case "beat-fx-channel":
        this.observe({ kind: "touch", control: "beat-fx-channel" });
        return;
      case "beat-fx-beats":
        this.observe({ kind: "touch", control: "beat-fx-beat" });
        return;
      case "beat-fx-depth":
        this.observe({ kind: "touch", control: "beat-fx-depth" });
        return;
      case "headphone-cue":
        this.observe({ kind: "headphone-cue", deck: command.deck, on: command.value });
        return;
      case "sync":
        this.observe({ kind: "sync", deck: command.deck, on: command.value });
        return;
      case "tempo":
      case "tempo-range":
      case "master-tempo":
        this.observe({ kind: "touch", control: `${command.deck}.${command.control}` });
        if (command.control === "tempo") this.observe({ kind: "tempo", deck: command.deck, percent: (this.engine.deckState(command.deck).tempoRate - 1) * 100 });
        if (command.control === "tempo" && this.pendingSetUp === null) this.drill?.tempoMoved(command.deck);
        return;
      case "eq-low":
      case "eq-mid":
      case "eq-high":
        this.onEq(command.deck, EQ_BANDS[command.control], command.value, event.heardCtx);
        return;
      case "crossfader":
        this.observe({ kind: "crossfader", value: command.value });
        return;
      case "trim":
        this.observe({ kind: "touch", control: `${command.deck}.trim` });
        return;
      case "jog-search":
        this.observe({ kind: "touch", control: `${command.deck}.jog` });
        return;
      case "jog-bend":
        // A nudge is the jog too (the cue-point hook counts any turn), and its own part (nudge-phase).
        this.observe({ kind: "touch", control: `${command.deck}.jog` });
        if (command.value !== 0) this.observe({ kind: "touch", control: `${command.deck}.jog-bend` });
        return;
      case "cue-mix":
      case "headphone-level":
        this.observe({ kind: "touch", control: command.control });
        return;
      case "deck-cue":
        if (command.value && this.engine.deckState(command.deck).previewing) this.observe({ kind: "cue-preview", deck: command.deck });
        return;
      case "tap":
        this.onTap(event.heardCtx);
        return;
      default:
        return;
    }
  }

  private onFader(deck: DeckId, value: number, heardCtx: number | null): void {
    const wasOpen = this.faderOpen[deck];
    this.faderOpen[deck] = value > FADER_DOWN;
    this.observe({ kind: "fader", deck, value });
    if (deck === "A" && wasOpen && !this.faderOpen.A && this.definition.practice.rep === "filter-out") this.onFilterOut(heardCtx);
    if (this.definition.practice.rep === "blend-step") this.followBlend();
    if (deck === "A" && wasOpen && value <= FADER_DOWN) {
      // An echo out's cut: on a downbeat, with ECHO taking A in.
      const offset = this.downbeatOffsetBeats("A", heardCtx);
      const fx = this.engine.mixerState().beatFx;
      this.observe({ kind: "echo-cut", onDownbeat: offset !== null && Math.abs(offset) <= DOWNBEAT_SLACK_BEATS, echoOn: fx.on && (fx.channel === "A" || fx.channel === "master") });
    }
    const check = this.check;
    if (check !== null && check.stopped === null) {
      if (value <= FADER_DOWN) {
        if (!check.closedAtMs.has(deck)) check.closedAtMs.set(deck, performance.now());
      } else check.closedAtMs.delete(deck);
    }
    if (deck !== "A") return;
    if (value >= FADER_UP) this.faderWasUp = true;
    if (check?.plan.endWhen.kind === "faded-out" && this.faderWasUp && value <= FADER_BOTTOM) {
      setTimeout(() => {
        // Only the attempt that faded out: a restart within the settle time is a new attempt.
        if (this.check === check) this.endAudio();
      }, FADE_OUT_SETTLE_MS);
    }
  }

  /** The stepped blend: where both channel faders are now, as a step made or missed. */
  private followBlend(): void {
    const { channels } = this.engine.mixerState();
    const { state, result } = followBlend(this.blend, blendPose(channels.A["channel-fader"], channels.B["channel-fader"]));
    this.blend = state;
    if (result !== null) this.observe({ kind: "blend-step", ...result });
  }

  private onTap(heardCtx: number | null): void {
    const deck = this.definition.tapDeck ?? "A";
    const track = this.onDeck[deck];
    if (heardCtx === null || track === null || !this.engine.deckState(deck).playing) return;
    const reading = this.engine.playheadAt(deck, heardCtx);
    if (reading === null) return;
    const tap = classifyTap(track.grid, track.phraseStarts, reading.positionSec);
    this.observe(tap);
    if (this.settingUp) return;
    if (this.check === null && this.definition.phraseCount === true) this.phraseCountState = phraseCountStep(this.phraseCountState, { kind: "tap", onPhraseStart: tap.onPhraseStart });
    this.farTap(track, reading.positionSec);
  }

  /** A Check tap well off every phrase start, after the plan's `farTapCue.fromPos`: its cue shows for a while. */
  private farTap(track: LessonTrack, positionSec: number): void {
    const check = this.check;
    const cue = check?.plan.farTapCue;
    if (check?.stopped !== null || cue === undefined || positionSec < cue.fromPos) return;
    const beat = beatSecOf(track);
    const far = track.phraseStarts.every((start) => Math.abs(positionSec - start) >= cue.beats * beat - 1e-9);
    if (far) check.farTapUntilPos = positionSec + cue.bars * 4 * beat;
  }

  /**
   * The phrases practice count, a bar after each phrase start: was it tapped? Only a step into the next
   * phrase judges one; a loop back to an earlier phrase just follows the deck.
   */
  private followPhraseCount(): void {
    const track = this.onDeck.A;
    const reading = this.engine.playhead("A");
    if (track === null || !reading.ok || !this.engine.deckState("A").playing) return;
    const { phrase, bar } = phrasePosition(track.grid, reading.positionSec);
    if (bar < 2 || phrase === this.judgedPhrase) return;
    if (this.judgedPhrase !== null && phrase === this.judgedPhrase + 1) this.phraseCountState = phraseCountStep(this.phraseCountState, { kind: "phrase-passed" });
    this.judgedPhrase = phrase;
  }

  /** The 8-bar count to show now: in the hook and practice of a Lesson with one, while deck A plays. */
  phraseCount(): PhraseCount | null {
    const track = this.onDeck.A;
    if (this.definition.phraseCount !== true || this.check !== null || this.pendingSetUp?.step?.kind === "check" || track === null || !this.engine.deckState("A").playing) return null;
    const reading = this.engine.playhead("A");
    return reading.ok ? { ...phrasePosition(track.grid, reading.positionSec), shown: this.phraseCountState.shown } : null;
  }

  /** B started while A plays: a cut (or a blend's start), placed against A's nearest phrase start. */
  private onPlayB(heardCtx: number | null): void {
    const offsetMs = this.phraseOffsetMs("A", heardCtx);
    if (offsetMs === null || !this.engine.deckState("A").playing) return;
    const beatMs = 60_000 / (this.track.grid.bpm * this.engine.deckState("A").tempoRate);
    this.observe({ kind: "cut", offsetMs, onPhrase: Math.abs(offsetMs) <= CUT_TOLERANCE_MS, withinBeat: Math.abs(offsetMs) <= beatMs });
  }

  /** A loop went on or changed: its length in bars and whether it starts on a downbeat. */
  private onLoop(deck: DeckId): void {
    const loop = this.engine.deckState(deck).loop;
    const track = this.onDeck[deck];
    if (loop === null || track === null) return;
    const beat = 60 / track.grid.bpm;
    const fromDownbeat = (loop.start - track.grid.firstBeat) / beat - track.grid.downbeatIndex;
    const offset = fromDownbeat - 4 * Math.round(fromDownbeat / 4);
    this.observe({ kind: "loop", deck, bars: (loop.end - loop.start) / (4 * beat), onDownbeat: Math.abs(offset) <= DOWNBEAT_SLACK_BEATS });
  }

  /** Signed beats from the nearest downbeat of what the deck plays at `heardCtx`; null without a reading. */
  private downbeatOffsetBeats(deck: DeckId, heardCtx: number | null): number | null {
    const track = this.onDeck[deck];
    if (heardCtx === null || track === null) return null;
    const reading = this.engine.playheadAt(deck, heardCtx);
    if (reading?.beat == null) return null;
    const fromDownbeat = reading.beat - track.grid.downbeatIndex;
    return fromDownbeat - 4 * Math.round(fromDownbeat / 4);
  }

  /** Heard ms from the deck's nearest phrase start at `heardCtx` (in track time); null without a reading. */
  private phraseOffsetMs(deck: DeckId, heardCtx: number | null): number | null {
    const track = this.onDeck[deck];
    if (heardCtx === null || track === null || track.phraseStarts.length === 0) return null;
    const reading = this.engine.playheadAt(deck, heardCtx);
    if (reading === null) return null;
    const nearest = track.phraseStarts.reduce((best, start) => (Math.abs(start - reading.positionSec) < Math.abs(best - reading.positionSec) ? start : best));
    return Math.round(((reading.positionSec - nearest) / this.engine.deckState(deck).tempoRate) * 1000);
  }

  /** An EQ move: its level, and for the LOW, a return to centre after a cut (eq-basics practice). */
  private onEq(deck: DeckId, band: EqBand, value: number, heardCtx: number | null): void {
    const db = eqKnobToDecibels(value);
    this.observe({ kind: "eq", deck, band, db });
    if (band !== "low" || this.settingUp) return;
    this.onLow(deck, db, heardCtx);
    if (db <= EQ_CUT_DB) {
      this.lowCut[deck] = true;
      return;
    }
    if (!this.lowCut[deck] || db < -EQ_CENTRED_DB) return;
    this.lowCut[deck] = false;
    const offsetMs = this.phraseOffsetMs(deck, heardCtx);
    if (offsetMs === null || !this.engine.deckState(deck).playing) return;
    const beatMs = 60_000 / (trackOnDeck(this.track, deck).grid.bpm * this.engine.deckState(deck).tempoRate);
    this.observe({ kind: "eq-return", deck, onPhrase: Math.abs(offsetMs) <= beatMs });
  }

  /**
   * A LOW crossing −6 dB, for the bass-swap rep: A's going down and B's coming up within 2 bars of each
   * other are one swap, timed (as the Check times it) at the mean of the two heard crossings.
   */
  private onLow(deck: DeckId, db: number, heardCtx: number | null): void {
    const before = this.lowDb[deck];
    this.lowDb[deck] = db;
    const down = before > CLASH_LOW_DB && db <= CLASH_LOW_DB;
    const up = before <= CLASH_LOW_DB && db > CLASH_LOW_DB;
    // The half a swap needs: A's LOW going out, B's coming in. The other way undoes it.
    if (deck === "A" ? up : down) this.swapHalf[deck] = null;
    if (!(deck === "A" ? down : up) || heardCtx === null) return;
    this.swapHalf[deck] = heardCtx;
    const { A: outAt, B: inAt } = this.swapHalf;
    if (outAt === null || inAt === null) return;
    const rateA = this.engine.deckState("A").tempoRate;
    const beatSec = 60 / (this.track.grid.bpm * rateA);
    // Too far apart for one swap: this crossing starts a new one.
    if (Math.abs(outAt - inAt) > SWAP_PAIR_BARS * 4 * beatSec) {
      this.swapHalf[deck === "A" ? "B" : "A"] = null;
      return;
    }
    this.swapHalf.A = null;
    this.swapHalf.B = null;
    const offsetMs = this.phraseOffsetMs("A", (outAt + inAt) / 2);
    const playing = DECKS.every((each) => this.engine.deckState(each).playing);
    this.observe({ kind: "swap", onPhrase: playing && offsetMs !== null && Math.abs(offsetMs) <= beatSec * 1000 });
  }

  /** CFX moves; on A, the high-pass sweep a filter-out rep is timed from (it ends back at centre). */
  private onFilter(deck: DeckId, value: number, heardCtx: number | null): void {
    this.observe({ kind: "filter", deck, value });
    if (deck !== "A") return;
    if (value <= FILTER_CENTRED) this.sweep = null;
    else if (this.sweep !== null) this.sweep.depth = Math.max(this.sweep.depth, value);
    else if (heardCtx !== null) this.sweep = { fromCtx: heardCtx, depth: value };
  }

  /** A's fader closed (filter-transition practice): how deep the sweep went and for how many bars. */
  private onFilterOut(heardCtx: number | null): void {
    if (!this.engine.deckState("A").playing) return;
    const sweep = this.sweep;
    const barSec = (4 * 60) / (this.track.grid.bpm * this.engine.deckState("A").tempoRate);
    this.observe({ kind: "filter-out", depth: sweep?.depth ?? 0, bars: sweep === null || heardCtx === null ? null : (heardCtx - sweep.fromCtx) / barSec });
  }

  private onCuePoint(deck: DeckId, pos: number): void {
    const track = this.onDeck[deck];
    if (track === null || this.settingUp) return;
    // The Check's own measurement: a cue point is a deck position, so no output latency applies.
    const placement = cuePlacement(track.grid, pos);
    this.observe({ kind: "cue-set", deck, offsetMs: placement.signedMs, beatOfBar: placement.beatOfBar, onDownbeat: placement.downbeat });
    if (this.check !== null && deck === "A") this.check.sliceCued = true;
  }

  /** The peak of each playing deck over the last second, for the gain-staging hook and practice. */
  private readLevels(): void {
    const heard = this.engine.heardTime();
    if (!heard.ok) return;
    for (const deck of DECKS) {
      const recent = this.peaks[deck].filter((frame) => frame.ctx > heard.ctx - LEVEL_WINDOW_SEC);
      this.peaks[deck] = recent;
      if (recent.length === 0 || !this.engine.deckState(deck).playing) {
        this.lastLevel[deck] = null;
        continue;
      }
      const peakDb = recent.reduce((highest, frame) => Math.max(highest, frame.peak), Number.NEGATIVE_INFINITY);
      this.lastLevel[deck] = peakDb;
      this.observe({ kind: "level", deck, peakDb });
    }
  }

  private send(command: EngineCommand): Result {
    const result = this.engine.command(command, DEVICE);
    if (!result.ok) console.warn("[lesson] the engine refused a set-up command", command, result.error);
    return result;
  }

  /** Sends set-up commands without observing them as the Learner's. */
  private settingUpWith(run: () => void): void {
    this.settingUp = true;
    try {
      run();
    } finally {
      this.settingUp = false;
    }
  }

  private stopWatching(): void {
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  /** The faders and knobs these set-ups set, as the decks are now (before SYNC and the range change). */
  private targetsFor(decks: DeckSetups): SetUpTarget[] {
    return setUpTargets(decks, this.track, { withB: this.onDeck.B !== null, before: (deck) => this.engine.deckState(deck) });
  }

  /**
   * Sets a fader or knob a set-up sets. With the controller connected, where the hardware is when the
   * target takes it (hardware-sync.ts), so the screen never leaves the hardware behind. The value sent.
   */
  private setContinuous(target: SetUpTarget): number {
    const at = this.hardware.position(target.control);
    // A set-up step leaves a known control where the hardware is: the Learner matches it during the step.
    const value = !this.hardware.connected ? target.value : this.cueingStep && at !== null && !this.skippedControls.has(target.control) ? at : settledValue(target, at);
    const command = commandFor(target.control, value);
    if (command !== null) this.send(command);
    if (target.control === "A.eq-low" || target.control === "B.eq-low") this.lowSetTo(target.control === "A.eq-low" ? "A" : "B", value);
    return value;
  }

  /** A skipped target, set on screen as planned (and the fader state that goes with it). */
  private setSkipped(target: SetUpTarget): void {
    const value = this.setContinuous(target);
    if (target.control === "A.channel-fader" || target.control === "B.channel-fader") this.faderOpen[target.control === "A.channel-fader" ? "A" : "B"] = value > FADER_DOWN;
  }

  /** The LOW as a set-up left it, for the eq-basics and bass-swap reps. */
  private lowSetTo(deck: DeckId, value: number): void {
    const db = eqKnobToDecibels(value);
    this.lowCut[deck] = db <= EQ_CUT_DB;
    this.lowDb[deck] = db;
    this.swapHalf[deck] = null;
  }

  /**
   * With the controller connected, every fader and knob whose hardware position is known goes where
   * the hardware is, except `except` (the set-up's own targets): whatever the screen was left at (a
   * listening clip, a Lesson before), it follows the hardware again.
   */
  private adoptHardware(except: ReadonlySet<ContinuousControlId> = new Set()): void {
    if (!this.hardware.connected) return;
    for (const control of CONTINUOUS_CONTROLS) {
      const at = this.hardware.position(control);
      if (at === null || except.has(control)) continue;
      // A synced deck's tempo is the leader's: its fader refuses to move.
      if ((control === "A.tempo" || control === "B.tempo") && this.engine.deckState(control === "A.tempo" ? "A" : "B").syncOn) continue;
      const command = commandFor(control, at);
      if (command !== null) this.send(command);
      if (control === "A.eq-low" || control === "B.eq-low") this.lowSetTo(control === "A.eq-low" ? "A" : "B", at);
      if (control === "A.channel-fader" || control === "B.channel-fader") this.faderOpen[control === "A.channel-fader" ? "A" : "B"] = at > FADER_DOWN;
    }
  }

  /**
   * Runs `proceed` once the controller matches the deliberate `targets`: at once with no controller, or
   * when it already does. Otherwise the decks pause and the "Match your controller" step shows
   * (`setUpPending`) until every item ticks, or Skip. A later set-up replaces a waiting one.
   */
  private whenMatched(targets: readonly SetUpTarget[], proceed: () => void): void {
    this.cancelSetUp();
    if (!this.hardware.connected) {
      proceed();
      return;
    }
    const items = matchItems(targets, this.hardware, this.skippedControls);
    if (items.every((item) => item.state === "matched")) {
      proceed();
      return;
    }
    this.settingUpWith(() => {
      for (const deck of DECKS) if (this.onDeck[deck] !== null) this.send({ control: "pause", deck });
    });
    this.pendingSetUp = { targets, proceed, step: null, own: null, shown: { caption: null, items } };
    this.setUpChanged();
  }

  /**
   * A set-up step of the Lesson's own (the decks are cued, A loops its first phrase): `own.caption`
   * says what to set up, and the "Match your controller" items tick off meanwhile, less the controls
   * the asks set themselves (stepTargets). Once all is set, it goes on where A's phrase comes round
   * (watchLoop); R (every item ticked) or Skip runs `proceed` at once.
   */
  private waitForStep(step: NonNullable<PendingSetUp["step"]>, own: SetUpStepPlan, targets: readonly SetUpTarget[], proceed: () => void): void {
    this.cancelSetUp();
    const matched = stepTargets(targets, own.asks);
    const items = this.hardware.connected ? matchItems(matched, this.hardware, this.skippedControls) : [];
    const pending: PendingSetUp = { targets: matched, proceed, step, own, shown: { caption: own.caption, items } };
    this.pendingSetUp = pending;
    pending.shown = this.stepShown(pending, items);
    this.setUpChanged();
  }

  /** The decks and the mixer as a set-up step's asks read them (set-up-asks.ts). */
  private setUpReading(): SetUpReading {
    const mixer = this.engine.mixerState();
    const perDeck = <T>(read: (deck: DeckId) => T): Record<DeckId, T> => ({ A: read("A"), B: read("B") });
    return {
      cueOn: perDeck((deck) => mixer.channels[deck].cue),
      syncOn: perDeck((deck) => this.engine.deckState(deck).syncOn),
      lowCut: perDeck((deck) => eqKnobToDecibels(mixer.channels[deck]["eq-low"]) <= EQ_CUT_DB),
      fader: perDeck((deck) => mixer.channels[deck]["channel-fader"]),
      beatFxOn: mixer.beatFx.on,
      levelDb: perDeck((deck) => {
        const track = this.onDeck[deck];
        return track === null ? null : trimmedPeakDb(track, trimKnobToDecibels(mixer.channels[deck].trim));
      }),
    };
  }

  /** Whether a set-up step is set: every item ticked and everything its caption asks done. */
  private stepSet(pending: PendingSetUp, items: readonly MatchItem[] = pending.shown.items): boolean {
    if (pending.own === null || !items.every((item) => item.state === "matched")) return false;
    const reading = this.setUpReading();
    return pending.own.asks.every((ask) => askDone(ask, reading));
  }

  /** What a set-up step shows with these items: its own caption, or "All set" once it is. */
  private stepShown(pending: PendingSetUp, items: readonly MatchItem[]): SetUpPending {
    const own = pending.own;
    return { caption: own === null ? null : this.stepSet(pending, items) ? ALL_SET_CAPTION : own.caption, items };
  }

  /** A set-up step's caption again, after a move that may have set it (or undone it). */
  private showStep(items?: readonly MatchItem[]): void {
    const pending = this.pendingSetUp;
    // Only a set-up step of the Lesson's own has a caption to change.
    if (pending?.own == null) return;
    const shown = this.stepShown(pending, items ?? pending.shown.items);
    if (shown.caption === pending.shown.caption && shown.items.map(matchKey).join() === pending.shown.items.map(matchKey).join()) return;
    pending.shown = shown;
    this.setUpChanged();
  }

  /** A fader or knob moved, or the controller came or went: tick the items off, and go once all have. */
  private hardwareChanged(): void {
    const pending = this.pendingSetUp;
    if (pending === null) return;
    if (!this.hardware.connected && pending.step === null) {
      // No controller to match any more: the set-up goes on as planned.
      this.releaseSetUp();
      return;
    }
    const items = this.hardware.connected ? matchItems(pending.targets, this.hardware, this.skippedControls) : [];
    if (pending.step === null && items.every((item) => item.state === "matched")) {
      this.releaseSetUp();
      return;
    }
    // A set-up step goes on where its phrase comes round (watchLoop): here it only shows "All set".
    if (pending.step !== null) {
      this.showStep(items);
      return;
    }
    if (items.map(matchKey).join() === pending.shown.items.map(matchKey).join()) return;
    pending.shown = { ...pending.shown, items };
    this.setUpChanged();
  }

  private releaseSetUp(): void {
    const pending = this.pendingSetUp;
    if (pending === null) return;
    this.pendingSetUp = null;
    this.setUpChanged();
    pending.proceed();
  }

  private cancelSetUp(): void {
    if (this.pendingSetUp === null) return;
    this.pendingSetUp = null;
    this.setUpChanged();
  }

  /** The set-up step showing now, or null. */
  setUpPending(): SetUpPending | null {
    return this.pendingSetUp?.shown ?? null;
  }

  /** Skip: the set-up goes on without the items not matched yet; they are set on screen from now on. */
  skipSetUp(): void {
    const pending = this.pendingSetUp;
    if (pending === null) return;
    for (const item of pending.shown.items) if (item.state !== "matched") for (const control of item.controls) this.skippedControls.add(control);
    // A set-up step cued its decks with the hardware's values: what was skipped is set on screen now.
    if (pending.step !== null) {
      this.settingUpWith(() => {
        for (const target of pending.targets) if (target.kind === "deliberate" && this.skippedControls.has(target.control)) this.setSkipped(target);
      });
    }
    this.releaseSetUp();
  }

  /** Called whenever the set-up step appears, changes or goes (for useSyncExternalStore). */
  subscribeSetUp = (listener: () => void): (() => void) => {
    this.setUpListeners.add(listener);
    return () => {
      this.setUpListeners.delete(listener);
    };
  };

  private setUpChanged(): void {
    for (const listener of this.setUpListeners) listener();
  }

  /** Cues a deck as `setup` says, paused; Play is the caller's (after the recorder starts, in a Check). */
  private cueDeck(deck: DeckId, setup: DeckSetup, targets: readonly SetUpTarget[]): void {
    this.send({ control: "pause", deck });
    this.send({ control: "seek", deck, value: setup.pos });
    for (const target of targets) {
      if (target.control === `${deck}.channel-fader`) this.faderOpen[deck] = this.setContinuous(target) > FADER_DOWN;
      if (target.control === `${deck}.trim`) this.setContinuous(target);
    }
    if (setup.headphoneCue !== undefined) this.send({ control: "headphone-cue", deck, value: setup.headphoneCue });
    this.setDeckControls(deck, setup, targets);
    if (setup.cuePoint === true && this.engine.deckState(deck).cuePointSec !== setup.pos) {
      this.send({ control: "deck-cue", deck, value: true });
      this.send({ control: "deck-cue", deck, value: false });
    }
  }

  /**
   * SYNC, the tempo range and fader, Master Tempo and the EQs, where the set-up names them. A set-up's
   * faders and knobs go through `targets` (the controller's positions); a listening clip has none.
   */
  private setDeckControls(deck: DeckId, setup: Omit<DeckSetup, "pos" | "fader" | "play">, targets?: readonly SetUpTarget[]): void {
    const state = () => this.engine.deckState(deck);
    const knob = (part: "tempo" | "eq-low" | "eq-mid" | "eq-high" | "filter", planned: number) => {
      const target = targets?.find((each) => each.control === `${deck}.${part}`);
      if (target === undefined) this.send({ control: part, deck, value: planned });
      else this.setContinuous(target);
    };
    // SYNC first: a synced deck's tempo fader is the leader's, and refuses to move.
    if (setup.sync !== undefined && setup.sync !== state().syncOn) this.send({ control: "sync", deck, value: setup.sync });
    if (setup.tempoRange !== undefined && setup.tempoRange !== state().tempoRangePercent) this.send({ control: "tempo-range", deck, value: setup.tempoRange });
    if (setup.tempoPercent !== undefined && !state().syncOn) knob("tempo", setup.tempoPercent / state().tempoRangePercent);
    if (setup.masterTempo !== undefined && setup.masterTempo !== state().masterTempo) this.send({ control: "master-tempo", deck, value: setup.masterTempo });
    if (setup.eqCentred === true) {
      for (const band of ["eq-low", "eq-mid", "eq-high"] as const) knob(band, 0);
      if (targets === undefined) this.lowSetTo(deck, 0);
    }
    if (setup.filterCentred === true) {
      knob("filter", 0);
      if (deck === "A") this.sweep = null;
    }
    setup.hotCues?.forEach((pos, slot) => {
      if (this.engine.deckState(deck).hotCues[slot] !== null) this.send({ control: "hot-cue-clear", deck, slot });
      if (pos !== null) this.send({ control: "hot-cue-set", deck, slot, pos });
    });
  }

  /** Beat FX as a set-up names it. */
  private setBeatFx(fx: DeckSetups["beatFx"], targets: readonly SetUpTarget[]): void {
    if (fx === undefined) return;
    if (fx.channel !== undefined) this.send({ control: "beat-fx-channel", value: fx.channel });
    if (fx.beats !== undefined) this.send({ control: "beat-fx-beats", value: fx.beats });
    const depth = targets.find((target) => target.control === "beat-fx-depth");
    if (depth !== undefined) this.setContinuous(depth);
    if (fx.on !== undefined) this.send({ control: "beat-fx", value: fx.on });
  }

  /** Cues the decks; `forStep`: a set-up step's, which leaves known faders and knobs to the Learner. */
  private cueDecks(decks: DeckSetups, forStep = false): void {
    this.blend = START_BLEND;
    this.cueingStep = forStep;
    try {
      this.cueDecksNow(decks);
    } finally {
      this.cueingStep = false;
    }
  }

  private cueDecksNow(decks: DeckSetups): void {
    const targets = this.targetsFor(decks);
    this.settingUpWith(() => {
      this.adoptHardware(new Set(targets.map((target) => target.control)));
      this.cueDeck("A", decks.A, targets);
      if (decks.B !== undefined && this.onDeck.B !== null) this.cueDeck("B", decks.B, targets);
      const crossfader = targets.find((target) => target.control === "crossfader");
      if (crossfader !== undefined) this.setContinuous(crossfader);
      this.setBeatFx(decks.beatFx, targets);
    });
  }

  private playDecks(decks: DeckSetups): void {
    this.settingUpWith(() => {
      for (const deck of DECKS) {
        const setup = deck === "A" ? decks.A : decks.B;
        if (setup?.play === true && this.onDeck[deck] !== null) this.send({ control: "play", deck });
      }
    });
  }

  /** Loops back: positions only (knobs and faders stay), or the whole set-up. */
  private loopBack(decks: DeckSetups, loop: LoopPlan, cued: () => void, stepFollows = false): void {
    if (loop.reset === "setup") {
      const again = loop.decks ?? decks;
      const restart = () => {
        this.cueDecks(again, stepFollows);
        this.playDecks(again);
        cued();
      };
      // Practice waits for the controller again, only where it differs; a running Check never waits.
      if (this.check === null && !stepFollows) this.whenMatched(this.targetsFor(again), restart);
      else restart();
      return;
    }
    this.settingUpWith(() => {
      for (const deck of DECKS) {
        const setup = deck === "A" ? decks.A : decks.B;
        if (setup !== undefined && this.onDeck[deck] !== null) this.send({ control: "seek", deck, value: setup.pos });
      }
    });
    cued();
  }

  /**
   * Loops where `loop` says, once the decks' last cue or loop back is heard (ISS-99). Until then the
   * heard playhead still shows the old position, past the loop point on a high-latency output, and
   * looping on it would seek again and again and stutter. Called right after the decks are cued, so
   * that cue is the first one waited for; the Check's own `cueHeard` is the same rule.
   */
  private watchLoop(decks: DeckSetups, loop: LoopPlan | null, alsoEvery?: () => void, positionsValid: () => boolean = () => true, afterLoop?: () => void): void {
    let seekCtx = this.engine.context.currentTime;
    const seekHeard = () => {
      const heard = this.engine.heardTime();
      return heard.ok && heard.ctx >= seekCtx + CUE_SETTLE_SEC;
    };
    this.watch = setInterval(() => {
      // Waiting for the Learner to match the controller: the decks are paused, nothing counts. A set-up
      // step's own loop (deck A round its first phrase) goes on.
      if (this.pendingSetUp !== null && this.pendingSetUp.step === null) return;
      const reading = this.engine.playhead(loop?.deck ?? "A");
      if (loop !== null && reading.ok && reading.positionSec >= loop.atPos && positionsValid() && seekHeard()) {
        // A set-up step goes on by itself here, where its phrase comes round, once everything is set:
        // a whole phrase heard first, then the Check (or practice) from the phrase start, as on R.
        const pending = this.pendingSetUp;
        if (pending !== null && this.stepSet(pending)) {
          this.releaseSetUp();
          return;
        }
        // A set-up loop that waits for R again (`afterLoop`) shows its own set-up step: it never pauses
        // for the controller first.
        this.loopBack(decks, loop, () => {
          seekCtx = this.engine.context.currentTime;
          afterLoop?.();
        }, afterLoop !== undefined);
      }
      alsoEvery?.();
    }, WATCH_MS);
  }

  /** Puts the Lesson track back on deck A after a cue-point Check left a slice there. */
  private async lessonTrackOnA(): Promise<boolean> {
    const onDeckNow = this.requestedA === this.track.trackId && this.onDeck.A?.trackId === this.track.trackId;
    return onDeckNow || this.loadOnA(this.track, this.audio);
  }

  /**
   * Loads a track on deck A. The engine keeps the last load asked for, so the session does too: a load
   * overtaken by a later one resolves false and never becomes `onDeck.A`.
   */
  private async loadOnA(track: LessonTrack, audio: AudioBuffer): Promise<boolean> {
    this.requestedA = track.trackId;
    const loaded = await this.engine.load("A", audio, { trackId: track.trackId, grid: track.grid });
    if (this.requestedA !== track.trackId || this.closed) return false;
    if (!loaded.ok) {
      console.warn(`[lesson] deck A refused ${track.trackId}`, loaded.error);
      return false;
    }
    this.onDeck.A = track;
    return true;
  }

  /**
   * Hook and practice: the Lesson's practice set-up, looping where the Lesson loops. In practice (not
   * the hook) a Lesson with `practiceSetUp` first waits for R, deck A looping its first phrase.
   */
  preparePractice(stage: "hook" | "practice" = "practice"): void {
    this.stopPreview();
    this.abandonCheck();
    this.stopClip();
    this.cancelSetUp();
    const generation = ++this.generation;
    void this.lessonTrackOnA().then((ready) => {
      if (!ready || generation !== this.generation || this.closed) return;
      const decks = practiceDecksFor(this.definition, this.track);
      const targets = this.targetsFor(decks);
      // A practice set-up step (not in the hook, nor with a drill) shows the controller's items itself.
      const waits = stage === "practice" && this.definition.practiceSetUp === true && this.definition.drill === undefined;
      if (waits) this.startPractice(decks, targets, true);
      else
        this.whenMatched(targets, () => {
          this.startPractice(decks, targets, false);
        });
    });
  }

  private startPractice(decks: DeckSetups, targets: readonly SetUpTarget[], waits: boolean): void {
    this.cueDecks(decks, waits);
    this.playDecks(decks);
    this.startDrill(decks);
    // Back in practice, the count shows again until the Learner counts by ear.
    this.phraseCountState = PHRASE_COUNT_START;
    this.judgedPhrase = null;
    if (waits) this.waitForPracticeSetUp(decks, targets);
    else this.watchPractice(decks, false);
  }

  /** Practice plays on, looping where the Lesson loops; with `setUpAgain`, each set-up loop waits for R again. */
  private watchPractice(decks: DeckSetups, setUpAgain: boolean): void {
    const drill = this.drill;
    const loop = practiceLoopFor(this.definition, this.track);
    // Count phrases judges each phrase start a bar after it; other Lessons count their reps (observe).
    const counting = this.definition.phraseCount === true && this.definition.practice.rep === "phrase-tap";
    const tick = drill === null && !counting ? undefined : () => {
      drill?.tick();
      if (counting) this.followPhraseCount();
    };
    const again = setUpAgain && loop?.reset === "setup" ? () => {
      const decksAgain = loop.decks ?? decks;
      this.waitForPracticeSetUp(decksAgain, this.targetsFor(decksAgain));
    } : undefined;
    this.watchLoop(decks, loop, tick, undefined, again);
  }

  /** The set-up step's loop: deck A's phrase from `pos` (a phrase start), round and round, until it goes on. */
  private setUpLoop(pos: number): LoopPlan {
    return { atPos: pos + BARS_PER_PHRASE * 4 * beatSecOf(this.track), reset: "positions" };
  }

  /** Practice's set-up step: A loops its first phrase until it goes on, then practice plays on from there. */
  private waitForPracticeSetUp(decks: DeckSetups, targets: readonly SetUpTarget[]): void {
    this.stopWatching();
    const own = this.definition.planCheck(this.track).setUp ?? NO_ASKS;
    this.waitForStep({ kind: "practice" }, own, targets, () => {
      // Set (or R): A from its phrase start, every knob and fader as the Learner set it (no new cue).
      this.stopWatching();
      this.settingUpWith(() => {
        this.send({ control: "seek", deck: "A", value: decks.A.pos });
      });
      this.watchPractice(decks, true);
    });
    this.watchLoop({ A: decks.A }, this.setUpLoop(decks.A.pos));
  }

  /** The Check's set-up step: A loops its first phrase, every other deck waits; nothing is recorded yet. */
  private waitForCheckSetUp(plan: CheckPlan, own: SetUpStepPlan): void {
    const planned = checkDecksFor(plan);
    const waiting: DeckSetups = { ...planned, A: { ...planned.A, play: true }, ...(planned.B === undefined ? {} : { B: { ...planned.B, play: false } }) };
    const targets = this.targetsFor(waiting);
    this.cueDecks(waiting, true);
    this.playDecks(waiting);
    this.waitForStep({ kind: "check", plan }, own, targets, () => {
      // Set (or R): the decks back to their start positions (A from its phrase start), every knob and
      // fader as the Learner set it. The Check then records, and its clock starts.
      this.stopWatching();
      this.settingUpWith(() => {
        for (const deck of DECKS) {
          const setup = deck === "A" ? planned.A : planned.B;
          if (setup === undefined || this.onDeck[deck] === null) continue;
          this.send({ control: "pause", deck });
          this.send({ control: "seek", deck, value: setup.pos });
        }
      });
      this.recordCheck(plan, planned);
    });
    this.watchLoop({ A: waiting.A }, this.setUpLoop(planned.A.pos));
  }

  /** A by-ear drill (Lessons 14–16) over the practice set-up, or null for a Lesson without one. */
  private startDrill(decks: DeckSetups): DrillRunner | null {
    this.stopDrill();
    const drill = this.definition.drill;
    if (drill === undefined) return null;
    this.drill = new DrillRunner(drill, () => liveReading(this.engine, this.onDeck), {
      observe: (observation) => {
        this.observe(observation);
      },
      status: (status) => this.listener.drillStatus?.(status),
      startRound: (round) => {
        this.startRound(decks, round.offsetBeats, round.apartPercent);
      },
    });
    return this.drill;
  }

  private stopDrill(): void {
    this.drill?.stop();
    this.drill = null;
  }

  /**
   * A new drill round: both decks back to their practice positions, playing on, with B `offsetBeats`
   * out of phase and its tempo `apartPercent` off A's (as A plays now).
   */
  private startRound(decks: DeckSetups, offsetBeats: number, apartPercent: number): void {
    const trackB = this.onDeck.B;
    const setupB = decks.B;
    if (trackB === null || setupB === undefined) return;
    const stateB = this.engine.deckState("B");
    const bpmA = this.track.grid.bpm * this.engine.deckState("A").tempoRate;
    const percent = tempoPercentApart(bpmA, trackB.grid.bpm, apartPercent);
    const value = Math.max(-1, Math.min(1, percent / stateB.tempoRangePercent));
    const tempo: SetUpTarget | null = stateB.syncOn ? null : { control: "B.tempo", value, kind: "deliberate", to: describeTarget("B.tempo", value, stateB.tempoRangePercent) };
    const playing = DECKS.filter((deck) => this.engine.deckState(deck).playing);
    let waited = false;
    this.whenMatched(tempo === null ? [] : [tempo], () => {
      this.settingUpWith(() => {
        this.send({ control: "seek", deck: "A", value: decks.A.pos });
        this.send({ control: "seek", deck: "B", value: setupB.pos + offsetBeats * beatSecOf(trackB) });
        if (tempo !== null) this.setContinuous(tempo);
        // The round waited for the controller: the decks play on, and its clock starts now.
        for (const deck of playing) if (waited && !this.engine.deckState(deck).playing) this.send({ control: "play", deck });
      });
      if (waited) this.drill?.restartRound();
    });
    waited = this.pendingSetUp !== null;
  }

  /**
   * Starts (or restarts) the Check's audio part: auto-jump, record, and watch for its end.
   * `passedLessons`: the Learner's, before this Check (the plan's captions may build on them).
   */
  startCheck(passedLessons: readonly LessonId[] = []): void {
    this.stopPreview();
    this.abandonCheck();
    this.stopDrill();
    this.stopClip();
    this.cancelSetUp();
    const generation = ++this.generation;
    this.checksStarted += 1;
    const plan = this.definition.planCheck(this.track, this.checksStarted, passedLessons);
    void this.checkTracksReady(plan).then((ready) => {
      if (generation !== this.generation || this.closed) return;
      if (!ready) {
        this.listener.checkFailed("The deck could not load the Check's track. Try again with Enter.");
        return;
      }
      this.beginCheck(plan);
    });
  }

  private async checkTracksReady(plan: CheckPlan): Promise<boolean> {
    const first = plan.slices?.[0];
    return first === undefined ? this.lessonTrackOnA() : this.loadSlice(plan, 0);
  }

  private async loadSlice(plan: CheckPlan, index: number): Promise<boolean> {
    const slice = plan.slices?.[index];
    if (slice === undefined) return false;
    const track = sliceTrack(this.track, slice, index);
    if (!(await this.loadOnA(track, sliceAudio(this.audio, slice.fromSec, slice.lengthSec)))) return false;
    this.sliceLevels(plan);
    return true;
  }

  /** cue-point's slices: A's fader, TRIM and CUE 🎧 as the Check sets them, for each slice loaded. */
  private sliceLevels(plan: CheckPlan): void {
    const decks = checkDecksFor(plan);
    const targets = this.targetsFor({ A: decks.A });
    this.settingUpWith(() => {
      for (const target of targets) if (target.control === "A.channel-fader" || target.control === "A.trim") this.setContinuous(target);
      if (decks.A.headphoneCue !== undefined) this.send({ control: "headphone-cue", deck: "A", value: decks.A.headphoneCue });
    });
  }

  private beginCheck(plan: CheckPlan): void {
    if (plan.setUp !== undefined) {
      this.waitForCheckSetUp(plan, plan.setUp);
      return;
    }
    const planned = checkDecksFor(plan);
    // hot-cues: A waits paused at its first stop; it plays from the start once the pads are set.
    const firstStop = plan.stops?.[0];
    const decks: DeckSetups = firstStop === undefined ? planned : { ...planned, A: { ...planned.A, pos: firstStop, play: false } };
    // Nothing is recorded and no time runs until the controller matches the Check's set-up.
    this.whenMatched(this.targetsFor(decks), () => {
      this.beginCheckMatched(plan, decks);
    });
  }

  private beginCheckMatched(plan: CheckPlan, decks: DeckSetups): void {
    if (plan.slices === undefined) this.cueDecks(decks);
    else if (this.hardware.connected) this.sliceLevels(plan);
    this.recordCheck(plan, decks);
  }

  /** Records the Check from here: the decks are cued; they play now, and its clock starts. */
  private recordCheck(plan: CheckPlan, decks: DeckSetups): void {
    const firstStop = plan.stops?.[0];
    const started = this.recorder.start({ expectedDurationSec: plan.timeoutSec + (plan.stopsTimeoutSec ?? 0) + 30, allowTrackChanges: plan.slices !== undefined });
    if (!started.ok) {
      console.warn("[lesson] the recorder did not start", started.error);
      this.listener.checkFailed(`The attempt could not be recorded (${started.error.kind}). Try again with Enter.`);
      return;
    }
    const startedMs = performance.now();
    const check: RunningCheck = { plan, startedMs, readies: new Map(), readyCount: 0, slice: 0, sliceCued: false, stopped: null, closedAtMs: new Map(), heldFromMs: null, heldSeenMs: null, cueCtx: this.engine.context.currentTime, stop: 0, stopSet: false, playingFromMs: firstStop === undefined ? startedMs : null, steps: 0, did: 0, didAtMs: null, farTapUntilPos: null };
    this.check = check;
    this.faderWasUp = false;
    this.playDecks(decks);
    this.watchLoop(
      decks,
      plan.loop ?? null,
      () => {
        if (this.ended(check)) this.endAudio();
      },
      () => this.cueHeard(check),
    );
  }

  /** Whether the Check's own cue is being heard yet, so heard positions belong to the Check. */
  private cueHeard(check: RunningCheck): boolean {
    const heard = this.engine.heardTime();
    return heard.ok && heard.ctx >= check.cueCtx + CUE_SETTLE_SEC;
  }

  /** Past the Check's hard stop: the stops' own time while A waits at them, then `timeoutSec` from the playing. */
  private timedOut(check: RunningCheck): boolean {
    const { plan } = check;
    const now = performance.now();
    if (check.playingFromMs === null) return now - check.startedMs > (plan.stopsTimeoutSec ?? plan.timeoutSec) * 1000;
    return now - check.playingFromMs > plan.timeoutSec * 1000;
  }

  private ended(check: RunningCheck): boolean {
    const { plan } = check;
    const elapsedMs = performance.now() - check.startedMs;
    if (this.timedOut(check)) return true;
    const end = plan.endWhen;
    switch (end.kind) {
      case "faded-out":
      case "slices-done":
        return false;
      case "after":
        return elapsedMs >= end.sec * 1000;
      case "faded-out-then": {
        const closedAt = check.closedAtMs.get(end.deck);
        const barMs = (4 * 60_000) / this.track.grid.bpm;
        return closedAt !== undefined && performance.now() - closedAt >= end.bars * barMs;
      }
      case "position": {
        if (!this.cueHeard(check)) return false;
        const reading = this.engine.playhead("A");
        return reading.ok && reading.positionSec >= end.pos;
      }
      case "ready-windows": {
        const heard = this.engine.heardTime();
        const barSec = (4 * 60) / this.track.grid.bpm;
        return heard.ok && end.decks.every((deck) => {
          const at = check.readies.get(deck);
          return at !== undefined && heard.ctx >= at + end.bars * barSec;
        });
      }
      case "readies":
        return check.readyCount >= end.count;
      case "held":
        return this.heldLongEnough(check, end);
      case "did-then": {
        const barMs = (4 * 60_000) / this.track.grid.bpm;
        return check.did >= end.count && check.didAtMs !== null && performance.now() - check.didAtMs >= end.bars * barMs;
      }
    }
  }

  /** A "held" end: B with A (phase, and tempo when asked) for `bars`, A past `notBeforePos`; or A at `orPos`. */
  private heldLongEnough(check: RunningCheck, end: Extract<CheckPlan["endWhen"], { kind: "held" }>): boolean {
    if (!this.cueHeard(check)) return false;
    const position = this.engine.playhead("A");
    if (position.ok && position.positionSec >= end.orPos) return true;
    const live = liveReading(this.engine, this.onDeck);
    const tempoOk = end.tempoBpm === null || (live.bpmA !== null && live.bpmB !== null && Math.abs(live.bpmA - live.bpmB) <= end.tempoBpm);
    const together = live.phaseMs !== null && Math.abs(live.phaseMs) < end.phaseMs && tempoOk;
    // A busy page that looked away for a while cannot vouch for the gap: the hold starts again.
    const looked = check.heldSeenMs !== null && live.nowMs - check.heldSeenMs <= HELD_GAP_MS;
    check.heldSeenMs = live.nowMs;
    check.heldFromMs = together ? (looked ? (check.heldFromMs ?? live.nowMs) : live.nowMs) : null;
    return check.heldFromMs !== null && position.ok && position.positionSec >= end.notBeforePos && live.nowMs - check.heldFromMs >= end.bars * live.barMs;
  }

  /**
   * R: "this is set". In gain-staging's Check it marks the next deck Ready; in cue-point's it locks in
   * this slice's cue point and moves on; in practice it scores the levels.
   */
  ready(): void {
    const pending = this.pendingSetUp;
    if (pending !== null) {
      // R takes a set-up step on at once, once the controller matches (it goes by itself at the
      // phrase's end once all is set); matching the controller alone is not a rep or a Ready yet.
      if (pending.step !== null && pending.shown.items.every((item) => item.state === "matched")) this.releaseSetUp();
      return;
    }
    const check = this.check;
    // No Check, or its audio part is over.
    if (check?.stopped !== null) {
      if (this.definition.practice.rep === "ready") this.observe({ kind: "ready", inZone: this.levelsInZone() });
      if (this.definition.practice.rep === "tempo-set" && check === null) this.tempoSet();
      if (check === null) this.drill?.ready();
      return;
    }
    const stops = check.plan.stops;
    if (stops !== undefined && check.stop < stops.length) {
      this.nextStop(check, stops);
      return;
    }
    const end = check.plan.endWhen;
    if (end.kind === "readies") {
      this.engine.command({ control: "ready", deck: end.deck }, DEVICE);
      check.readyCount += 1;
      if (check.readyCount >= end.count) this.endAudio();
      return;
    }
    if (end.kind === "ready-windows") {
      // Each deck is Ready once; a stray press after that must not restart a hold window.
      const deck = end.decks.find((candidate) => !check.readies.has(candidate));
      const heard = this.engine.heardTime();
      if (deck === undefined || !heard.ok) return;
      this.engine.command({ control: "ready", deck }, DEVICE);
      check.readies.set(deck, heard.ctx);
      check.readyCount += 1;
      return;
    }
    if (end.kind === "slices-done") {
      if (!check.sliceCued) return;
      this.engine.command({ control: "ready", deck: "A" }, DEVICE);
      check.readyCount += 1;
      const next = check.slice + 1;
      if (next >= (check.plan.slices?.length ?? 0)) {
        this.endAudio();
        return;
      }
      check.slice = next;
      check.sliceCued = false;
      void this.loadSlice(check.plan, next).then((loaded) => {
        if (!loaded && this.check === check) this.endAudio();
      });
    }
  }

  /**
   * hot-cues: Ready once a pad is set at this stop moves deck A to the next stop, paused; after the last,
   * A is cued to the Check's start and plays.
   */
  private nextStop(check: RunningCheck, stops: readonly number[]): void {
    if (!check.stopSet) return;
    this.engine.command({ control: "ready", deck: "A" }, DEVICE);
    check.readyCount += 1;
    check.stop += 1;
    check.stopSet = false;
    const next = stops[check.stop];
    if (next === undefined) check.playingFromMs = performance.now();
    this.settingUpWith(() => {
      this.send({ control: "pause", deck: "A" });
      this.send({ control: "seek", deck: "A", value: next ?? check.plan.startPos });
      if (next === undefined && check.plan.autoPlay) this.send({ control: "play", deck: "A" });
    });
  }

  /** tempo-fader practice: is B on the target BPM? Then B's tempo goes back to centre for the next rep. */
  private tempoSet(): void {
    const target = this.definition.practiceTargetBpm?.(this.track);
    const track = this.onDeck.B;
    if (target === undefined || track === null) return;
    const bpm = track.grid.bpm * this.engine.deckState("B").tempoRate;
    this.observe({ kind: "tempo-set", onTarget: Math.abs(bpm - target) <= BPM_TOLERANCE + 1e-9 });
    if (this.engine.deckState("B").syncOn) return;
    const centre: SetUpTarget = { control: "B.tempo", value: 0, kind: "deliberate", to: "centre" };
    const playing = DECKS.filter((deck) => this.engine.deckState(deck).playing);
    let waited = false;
    this.whenMatched([centre], () => {
      this.settingUpWith(() => {
        this.setContinuous(centre);
        for (const deck of playing) if (waited && !this.engine.deckState(deck).playing) this.send({ control: "play", deck });
      });
    });
    waited = this.pendingSetUp !== null;
  }

  private levelsInZone(): boolean {
    const decks = DECKS.filter((deck) => this.onDeck[deck] !== null);
    const levels = decks.map((deck) => this.lastLevel[deck]);
    if (levels.some((level) => level === null)) return false;
    const known = levels.filter((level) => level !== null);
    const [low, high] = GAIN_ZONE_DB;
    const inZone = known.every((level) => level >= low && level < high);
    return inZone && Math.max(...known) - Math.min(...known) <= LEVEL_MATCH_DB;
  }

  private endAudio(): void {
    const check = this.check;
    if (check?.stopped !== null) return;
    this.stopWatching();
    this.settingUpWith(() => {
      for (const deck of DECKS) if (this.onDeck[deck] !== null) this.send({ control: "pause", deck });
    });
    const timedOut = this.timedOut(check);
    // The attempt ends with its audio: answering questions afterwards is not part of it.
    check.stopped = this.recorder.stop({
      attemptId: crypto.randomUUID(),
      learnerId: this.learnerId,
      endReason: timedOut ? "timeout" : "done",
      abandoned: false,
      phraseMarkers: Object.fromEntries(DECKS.flatMap((deck) => {
        const track = this.onDeck[deck];
        return track === null ? [] : [[track.trackId, track.phraseStarts] as const];
      })),
      answers: {},
    });
    this.listener.audioEnded();
  }

  /**
   * Plays a question's listening clip on a loop (tempo-fader's Master Tempo clips), after the audio
   * part of the Check ended: the lead bars at the track's tempo, then the faster bars, then again. A
   * question without a clip stops any clip playing.
   */
  playClip(questionId: string): void {
    this.playListeningClip(this.clipFor(questionId));
  }

  /**
   * Plays `clip` on a loop, as a question's clip plays (null stops any clip). Practice uses it too
   * (tempo-fader's ear round, `LessonDefinition.practiceClip`): practice's own playing stops, and the
   * decks stay paused after `stopListening` until practice or the Check starts again. Nothing is graded.
   */
  playListeningClip(clip: ListeningClip | null): void {
    this.stopClip();
    if (clip === null || this.onDeck[clip.deck] === null) return;
    this.stopPreview();
    this.stopWatching();
    this.clip = clip;
    const track = trackOnDeck(this.track, clip.deck);
    const fastFrom = clip.pos + clip.leadBars * 4 * beatSecOf(track);
    const end = fastFrom + clip.bars * 4 * beatSecOf(track);
    let fast = false;
    this.settingUpWith(() => {
      for (const deck of DECKS) if (this.onDeck[deck] !== null) this.send({ control: "pause", deck });
      this.setDeckControls(clip.deck, { sync: false, tempoRange: clip.rangePercent, tempoPercent: 0, masterTempo: clip.masterTempo });
      this.send({ control: "seek", deck: clip.deck, value: clip.pos });
      this.send({ control: "channel-fader", deck: clip.deck, value: 1 });
      this.send({ control: "play", deck: clip.deck });
    });
    this.watch = setInterval(() => {
      if (this.clip !== clip) return;
      const reading = this.engine.playhead(clip.deck);
      if (!reading.ok) return;
      this.settingUpWith(() => {
        if (reading.positionSec >= end) {
          fast = false;
          this.send({ control: "tempo", deck: clip.deck, value: 0 });
          this.send({ control: "seek", deck: clip.deck, value: clip.pos });
        } else if (!fast && reading.positionSec >= fastFrom) {
          fast = true;
          this.send({ control: "tempo", deck: clip.deck, value: clip.tempo });
        }
      });
    }, WATCH_MS);
  }

  /**
   * Plays the Check's phrase `phrase` (1-based) again on deck A at the Check's own fader, once the audio
   * part is over: from 2 bars before it (phrase 1: the count-in), across the change, on through later
   * phrases until stopped or the window's end plus a bar. One at a time: it stops any other. The
   * recorder has stopped, so nothing here is graded or counted as a tap. Also while the result shows (its
   * ▶ replays the right phrase), until the next Check or practice. False when there is nothing to play.
   */
  previewPhrase(phrase: number): boolean {
    const check = this.check;
    const plan = check === null ? this.gradedPlan : check.stopped === null ? null : check.plan;
    const previews = plan?.phrasePreviews;
    const span = previews === undefined ? null : phrasePreviewSpan(previews, phrase);
    if (plan == null || previews === undefined || span === null || this.onDeck.A === null) return false;
    this.stopClip();
    this.stopPreview();
    const fader = checkDecksFor(plan).A.fader;
    let seekCtx = this.engine.context.currentTime;
    const stopListening = this.engine.on("command", (event) => {
      if (event.command.control === "seek" && event.command.deck === "A" && event.rejected === null) seekCtx = event.appliedCtx;
    });
    try {
      this.settingUpWith(() => {
        for (const deck of DECKS) if (this.onDeck[deck] !== null) this.send({ control: "pause", deck });
        this.send({ control: "seek", deck: "A", value: span.fromPos });
        this.send({ control: "channel-fader", deck: "A", value: fader });
        this.send({ control: "play", deck: "A" });
      });
    } finally {
      stopListening();
    }
    const preview = { phrase, previews, untilPos: span.untilPos, seekCtx };
    this.preview = preview;
    this.watch = setInterval(() => {
      const heard = this.engine.heardTime();
      const reading = this.engine.playhead("A");
      if (this.preview !== preview || !heard.ok || heard.ctx < preview.seekCtx + CUE_SETTLE_SEC) return;
      if (!this.engine.deckState("A").playing || (reading.ok && reading.positionSec >= preview.untilPos)) this.stopPreview();
    }, WATCH_MS);
    return true;
  }

  /**
   * What a phrase preview plays now, as heard (through the output's latency): the phrase and its bar
   * (null in the lead-in before phrase 1, or until the cue is heard). Null when no preview plays.
   */
  previewHeard(): { readonly phrase: number; readonly bar: number } | { readonly phrase: null } | null {
    const preview = this.preview;
    if (preview === null) return null;
    const heard = this.engine.heardTime();
    if (!heard.ok || heard.ctx < preview.seekCtx) return { phrase: null };
    const reading = this.engine.playhead("A");
    return (reading.ok ? previewPhraseAt(preview.previews, reading.positionSec) : null) ?? { phrase: null };
  }

  /** The phrase previewing now, if any (end-to-end tests read it). */
  previewingPhrase(): number | null {
    return this.preview?.phrase ?? null;
  }

  /** Stops a phrase preview (an answer chosen, another preview, grading). */
  stopPreview(): void {
    if (this.preview === null) return;
    this.preview = null;
    this.stopWatching();
    this.settingUpWith(() => {
      if (this.onDeck.A !== null) this.send({ control: "pause", deck: "A" });
      // The preview set fader A on screen: back to where the hardware has it.
      this.adoptHardware();
    });
  }

  /** The listening clip a question plays, once the Check's audio part is over; null without one. */
  clipFor(questionId: string): ListeningClip | null {
    const check = this.check;
    return check?.stopped == null ? null : (check.plan.clips?.[questionId] ?? null);
  }

  /** The clip playing now, if any (end-to-end tests read which Master Tempo it has). */
  playingClip(): ListeningClip | null {
    return this.clip;
  }

  /** Stops the clip playing (the ear round's ■ Stop, or its panel closing); the decks stay paused. */
  stopListening(): void {
    this.stopClip();
  }

  private stopClip(): void {
    const clip = this.clip;
    if (clip === null) return;
    this.clip = null;
    this.stopWatching();
    this.settingUpWith(() => {
      if (this.onDeck[clip.deck] !== null) this.send({ control: "pause", deck: clip.deck });
      // The clip moved its fader and tempo on screen: back to where the hardware has them.
      this.adoptHardware();
    });
  }

  /** The plan of the Check running now (it varies by attempt), or null. */
  runningPlan(): CheckPlan | null {
    const step = this.pendingSetUp?.step;
    return this.check?.plan ?? (step?.kind === "check" ? step.plan : null);
  }

  /** The live caption for the stretch of the Check the deck is in now. */
  checkCue(): PositionCue | null {
    const pending = this.pendingSetUp;
    if (pending?.step?.kind === "check" && pending.shown.caption !== null) return { fromPos: 0, caption: pending.shown.caption };
    const check = this.check;
    if (check === null) return null;
    const step = check.steps > 0 ? check.plan.stepCues?.[check.steps - 1] : undefined;
    if (step !== undefined) return { fromPos: 0, caption: step.caption };
    const readyCues = check.plan.readyCues;
    if (readyCues !== undefined && (check.readyCount < readyCues.length || check.plan.cues.length === 0)) {
      const caption = readyCues[Math.min(check.readyCount, readyCues.length - 1)];
      return caption === undefined ? null : { fromPos: 0, caption };
    }
    // Until the Check's own cue is heard, the deck still plays wherever practice left it.
    const reading = this.engine.playhead("A");
    if (!reading.ok || !this.cueHeard(check)) return null;
    const farTap = check.plan.farTapCue;
    if (farTap !== undefined && check.farTapUntilPos !== null && reading.positionSec < check.farTapUntilPos) return { fromPos: 0, caption: farTap.caption };
    return check.plan.cues.findLast((cue) => cue.fromPos <= reading.positionSec) ?? null;
  }

  /** Where the next beat falls on the tap deck, for the beat pulse on screen. Null while it is stopped. */
  beatClock(): BeatClock | null {
    const deck = this.definition.tapDeck ?? "A";
    const track = this.onDeck[deck];
    const reading = this.engine.playhead(deck);
    const state = this.engine.deckState(deck);
    if (track === null || !reading.ok || reading.beat === null || !state.playing) return null;
    const rate = state.tempoRate * (1 + state.jogBend);
    const beatMs = 60_000 / (track.grid.bpm * rate);
    const nextBeat = Math.ceil(reading.beat);
    const fromDownbeat = nextBeat - track.grid.downbeatIndex;
    return {
      nextBeatAtMs: performance.now() + (nextBeat - reading.beat) * beatMs,
      nextBeat,
      beatMs,
      beatInBar: (((fromDownbeat % 4) + 4) % 4) + 1,
    };
  }

  /** Grades the attempt whose audio part ended, with the Learner's answers. */
  async grade(answers: Readonly<Record<string, number>>, passedLessons: readonly LessonId[]): Promise<GradeOutcome> {
    const check = this.check;
    if (check === null) return { ok: false, message: "No Check was running to grade. Start it again with Enter." };
    if (check.stopped === null) this.endAudio();
    this.stopClip();
    this.stopPreview();
    this.check = null;
    this.gradedPlan = check.plan;
    this.stopWatching();
    // endAudio has always set it by now.
    const stopped = await (check.stopped ?? Promise.resolve(null));
    if (stopped === null) return { ok: false, message: "The attempt was not stopped. Try again with Enter." };
    if (!stopped.ok) {
      return { ok: false, message: `The attempt could not be recorded (${stopped.error.kind}). Try again with Enter.` };
    }
    // Slices the Check never reached still have their grid: a cue point missing there fails, not voids.
    const attempt: RecordedAttempt = withPlannedGrids({ ...stopped.attempt, answers }, this.track, check.plan);
    return { ok: true, outcome: this.gradeAttempt(check.plan, attempt, passedLessons) };
  }

  private gradeAttempt(plan: CheckPlan, attempt: RecordedAttempt, passedLessons: readonly LessonId[]): CheckResult | VoidAttempt {
    if (attempt.degraded) console.warn("[lesson] the recorder dropped some continuous moves; grading what it kept");
    const spec = checkSpecFor(this.definition, this.track, plan, attempt, {
      window: { from: attempt.startedCtx, to: attempt.endedCtx },
      passedLessons,
      grading: this.grading,
    });
    const outcome = runCheck(spec, attempt);
    if ("criteria" in outcome || outcome.outcome.reason !== "sectionNotHeard") return outcome;
    // What the Check saw of its own cue and the clock, so an owner's report of a void can be diagnosed.
    const { context } = this.engine;
    const heard = this.engine.heardTime();
    const lastA = attempt.decks.A?.playhead.segments.slice(-4) ?? [];
    const diagnostics = {
      ...outcome.diagnostics,
      recorderStartedCtx: attempt.startedCtx,
      recorderStoppedCtx: attempt.endedCtx,
      checkStartPos: plan.startPos,
      heardNowCtx: heard.ok ? heard.ctx : null,
      currentTime: context.currentTime,
      outputLatencySec: context instanceof AudioContext ? context.outputLatency : null,
      baseLatencySec: context instanceof AudioContext ? context.baseLatency : null,
      lastSegmentsA: lastA.map((segment) => `${segment.fromCtx.toFixed(3)}@${segment.pos.toFixed(3)}×${String(segment.rate)}`).join(" "),
    };
    console.warn("[lesson] the Check is void: a graded section was not heard", diagnostics);
    return { ...outcome, diagnostics };
  }

  /** Leaves a running Check without grading it (restart, leaving the page). */
  abandonCheck(): void {
    this.stopWatching();
    this.cancelSetUp();
    this.gradedPlan = null;
    const check = this.check;
    if (check === null) return;
    this.check = null;
    if (check.stopped !== null) return;
    void this.recorder.stop({
      attemptId: crypto.randomUUID(),
      learnerId: this.learnerId,
      endReason: "done",
      abandoned: true,
      phraseMarkers: {},
      answers: {},
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHardware();
    this.cancelSetUp();
    this.stopDrill();
    this.stopClip();
    this.stopPreview();
    this.abandonCheck();
    clearInterval(this.levelTimer);
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }
}

function beatSecOf(track: LessonTrack): number {
  return 60 / track.grid.bpm;
}

/** A copy of `lengthSec` of the audio from `fromSec`, at the audio's own (the engine's) sample rate. */
function sliceAudio(audio: AudioBuffer, fromSec: number, lengthSec: number): AudioBuffer {
  const from = Math.max(0, Math.round(fromSec * audio.sampleRate));
  const length = Math.max(1, Math.min(audio.length - from, Math.round(lengthSec * audio.sampleRate)));
  const slice = new AudioBuffer({ length, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate });
  for (let channel = 0; channel < audio.numberOfChannels; channel++) slice.copyToChannel(audio.getChannelData(channel).subarray(from, from + length), channel);
  return slice;
}

/** What an item shows: it changed when this did. */
function matchKey(item: MatchItem): string {
  return `${item.key}:${item.state}:${item.hint ?? ""}`;
}
