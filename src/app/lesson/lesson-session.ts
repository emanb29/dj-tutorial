// One Lesson on one engine, outside React (ADR 0001): sets the decks up for the hook, practice and the
// Check, turns engine commands into `Observation`s for the runtime, records the Check attempt with the
// AttemptRecorder and grades it. The pure runtime (src/lessons/runtime.ts) decides what happens next.
//
// The audio part of a Check ends (and the recorder stops) before any questions are asked, so the
// grading window and the end reason never include the time spent answering.
import { AttemptRecorder, eqKnobToDecibels, type AudioEngine, type CommandEvent, type EngineCommand, type RecordedAttempt, type Result } from "@audio";
import { CLASH_LOW_DB, runCheck } from "@checks";
import {
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
  setUpTrim,
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
} from "@lessons";
import type { DeckId, LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
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
  ) {
    this.recorder = new AttemptRecorder(engine);
    this.onDeck = { A: track, B: hasDeckB ? trackOnDeck(track, "B") : null };
    this.requestedA = track.trackId;
    const stops = [
      engine.on("command", (event) => {
        this.onCommand(event);
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
    if (this.settingUp) return;
    this.progress(observation);
    this.listener.observed(observation);
  }

  /** What a running Check counts from the Learner's actions: its step cues, its `did-then` end, a pad set at a stop. */
  private progress(observation: Observation): void {
    const check = this.check;
    if (check?.stopped !== null) return;
    const done = (trigger: HookTrigger) => triggerStep(trigger, observation) === 1;
    const step = check.plan.stepCues?.[check.steps];
    if (step !== undefined && done(step.after)) check.steps += 1;
    const end = check.plan.endWhen;
    if (end.kind === "did-then" && done(end.what)) {
      check.did += 1;
      check.didAtMs = performance.now();
    }
    if (observation.kind === "hot-cue-set") check.stopSet = true;
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
        if (command.control === "tempo") this.drill?.tempoMoved(command.deck);
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
    if (this.definition.phraseCount !== true || this.check !== null || track === null || !this.engine.deckState("A").playing) return null;
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
    const tap = classifyTap(track.grid, [], pos);
    const beat = 60 / track.grid.bpm;
    const nearest = Math.round((pos - track.grid.firstBeat) / beat);
    const onDownbeat = (((nearest - track.grid.downbeatIndex) % 4) + 4) % 4 === 0;
    this.observe({ kind: "cue-set", deck, offsetMs: tap.offsetMs, onDownbeat });
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

  /** Cues a deck as `setup` says, paused; Play is the caller's (after the recorder starts, in a Check). */
  private cueDeck(deck: DeckId, setup: DeckSetup): void {
    this.send({ control: "pause", deck });
    this.send({ control: "seek", deck, value: setup.pos });
    this.send({ control: "channel-fader", deck, value: setup.fader });
    this.faderOpen[deck] = setup.fader > FADER_DOWN;
    this.send({ control: "trim", deck, value: setup.trim ?? setUpTrim(this.track) });
    if (setup.headphoneCue !== undefined) this.send({ control: "headphone-cue", deck, value: setup.headphoneCue });
    this.setDeckControls(deck, setup);
    if (setup.cuePoint === true && this.engine.deckState(deck).cuePointSec !== setup.pos) {
      this.send({ control: "deck-cue", deck, value: true });
      this.send({ control: "deck-cue", deck, value: false });
    }
  }

  /** SYNC, the tempo range and fader, Master Tempo and the EQs, where the set-up names them. */
  private setDeckControls(deck: DeckId, setup: Omit<DeckSetup, "pos" | "fader" | "play">): void {
    const state = () => this.engine.deckState(deck);
    // SYNC first: a synced deck's tempo fader is the leader's, and refuses to move.
    if (setup.sync !== undefined && setup.sync !== state().syncOn) this.send({ control: "sync", deck, value: setup.sync });
    if (setup.tempoRange !== undefined && setup.tempoRange !== state().tempoRangePercent) this.send({ control: "tempo-range", deck, value: setup.tempoRange });
    if (setup.tempoPercent !== undefined && !state().syncOn) this.send({ control: "tempo", deck, value: setup.tempoPercent / state().tempoRangePercent });
    if (setup.masterTempo !== undefined && setup.masterTempo !== state().masterTempo) this.send({ control: "master-tempo", deck, value: setup.masterTempo });
    if (setup.eqCentred === true) {
      for (const band of ["eq-low", "eq-mid", "eq-high"] as const) this.send({ control: band, deck, value: 0 });
      this.lowCut[deck] = false;
      this.lowDb[deck] = 0;
      this.swapHalf[deck] = null;
    }
    if (setup.filterCentred === true) {
      this.send({ control: "filter", deck, value: 0 });
      if (deck === "A") this.sweep = null;
    }
    if (setup.lowCut === true) {
      this.send({ control: "eq-low", deck, value: -1 });
      this.lowCut[deck] = true;
    }
    setup.hotCues?.forEach((pos, slot) => {
      if (this.engine.deckState(deck).hotCues[slot] !== null) this.send({ control: "hot-cue-clear", deck, slot });
      if (pos !== null) this.send({ control: "hot-cue-set", deck, slot, pos });
    });
  }

  /** Beat FX as a set-up names it. */
  private setBeatFx(fx: DeckSetups["beatFx"]): void {
    if (fx === undefined) return;
    if (fx.channel !== undefined) this.send({ control: "beat-fx-channel", value: fx.channel });
    if (fx.beats !== undefined) this.send({ control: "beat-fx-beats", value: fx.beats });
    if (fx.depth !== undefined) this.send({ control: "beat-fx-depth", value: fx.depth });
    if (fx.on !== undefined) this.send({ control: "beat-fx", value: fx.on });
  }

  private cueDecks(decks: DeckSetups): void {
    this.blend = START_BLEND;
    this.settingUpWith(() => {
      this.cueDeck("A", decks.A);
      if (decks.B !== undefined && this.onDeck.B !== null) this.cueDeck("B", decks.B);
      if (decks.crossfader !== undefined) this.send({ control: "crossfader", value: decks.crossfader });
      this.setBeatFx(decks.beatFx);
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
  private loopBack(decks: DeckSetups, loop: LoopPlan): void {
    if (loop.reset === "setup") {
      const again = loop.decks ?? decks;
      this.cueDecks(again);
      this.playDecks(again);
      return;
    }
    this.settingUpWith(() => {
      for (const deck of DECKS) {
        const setup = deck === "A" ? decks.A : decks.B;
        if (setup !== undefined && this.onDeck[deck] !== null) this.send({ control: "seek", deck, value: setup.pos });
      }
    });
  }

  private watchLoop(decks: DeckSetups, loop: LoopPlan | null, alsoEvery?: () => void, positionsValid: () => boolean = () => true): void {
    this.watch = setInterval(() => {
      const reading = this.engine.playhead(loop?.deck ?? "A");
      if (loop !== null && reading.ok && reading.positionSec >= loop.atPos && positionsValid()) this.loopBack(decks, loop);
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

  /** Hook and practice: the Lesson's practice set-up, looping where the Lesson loops. */
  preparePractice(): void {
    this.stopPreview();
    this.abandonCheck();
    this.stopClip();
    const generation = ++this.generation;
    void this.lessonTrackOnA().then((ready) => {
      if (!ready || generation !== this.generation || this.closed) return;
      const decks = practiceDecksFor(this.definition, this.track);
      this.cueDecks(decks);
      this.playDecks(decks);
      const drill = this.startDrill(decks);
      // Back in practice, the count shows again until the Learner taps by ear.
      this.phraseCountState = PHRASE_COUNT_START;
      this.judgedPhrase = null;
      const counting = this.definition.phraseCount === true;
      this.watchLoop(decks, practiceLoopFor(this.definition, this.track), drill === null && !counting ? undefined : () => {
        drill?.tick();
        if (counting) this.followPhraseCount();
      });
    });
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
    this.settingUpWith(() => {
      this.send({ control: "seek", deck: "A", value: decks.A.pos });
      this.send({ control: "seek", deck: "B", value: setupB.pos + offsetBeats * beatSecOf(trackB) });
      const stateB = this.engine.deckState("B");
      if (!stateB.syncOn) {
        const bpmA = this.track.grid.bpm * this.engine.deckState("A").tempoRate;
        const percent = tempoPercentApart(bpmA, trackB.grid.bpm, apartPercent);
        this.send({ control: "tempo", deck: "B", value: Math.max(-1, Math.min(1, percent / stateB.tempoRangePercent)) });
      }
    });
  }

  /** Starts (or restarts) the Check's audio part: auto-jump, record, and watch for its end. */
  startCheck(): void {
    this.stopPreview();
    this.abandonCheck();
    this.stopDrill();
    this.stopClip();
    const generation = ++this.generation;
    this.checksStarted += 1;
    const plan = this.definition.planCheck(this.track, this.checksStarted);
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
    const setup = checkDecksFor(plan).A;
    this.settingUpWith(() => {
      this.send({ control: "channel-fader", deck: "A", value: setup.fader });
      this.send({ control: "trim", deck: "A", value: setup.trim ?? setUpTrim(this.track) });
      if (setup.headphoneCue !== undefined) this.send({ control: "headphone-cue", deck: "A", value: setup.headphoneCue });
    });
    return true;
  }

  private beginCheck(plan: CheckPlan): void {
    const planned = checkDecksFor(plan);
    // hot-cues: A waits paused at its first stop; it plays from the start once the pads are set.
    const firstStop = plan.stops?.[0];
    const decks: DeckSetups = firstStop === undefined ? planned : { ...planned, A: { ...planned.A, pos: firstStop, play: false } };
    if (plan.slices === undefined) this.cueDecks(decks);
    const started = this.recorder.start({ expectedDurationSec: plan.timeoutSec + 30, allowTrackChanges: plan.slices !== undefined });
    if (!started.ok) {
      console.warn("[lesson] the recorder did not start", started.error);
      this.listener.checkFailed(`The attempt could not be recorded (${started.error.kind}). Try again with Enter.`);
      return;
    }
    const check: RunningCheck = { plan, startedMs: performance.now(), readies: new Map(), readyCount: 0, slice: 0, sliceCued: false, stopped: null, closedAtMs: new Map(), heldFromMs: null, heldSeenMs: null, cueCtx: this.engine.context.currentTime, stop: 0, stopSet: false, steps: 0, did: 0, didAtMs: null, farTapUntilPos: null };
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

  private ended(check: RunningCheck): boolean {
    const { plan } = check;
    const elapsedMs = performance.now() - check.startedMs;
    if (elapsedMs > plan.timeoutSec * 1000) return true;
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
    this.settingUpWith(() => {
      if (!this.engine.deckState("B").syncOn) this.send({ control: "tempo", deck: "B", value: 0 });
    });
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
    const timedOut = performance.now() - check.startedMs > check.plan.timeoutSec * 1000;
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
    const clip = this.clipFor(questionId);
    this.stopClip();
    if (clip === null || this.onDeck[clip.deck] === null) return;
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
   * recorder has stopped, so nothing here is graded or counted as a tap. False when there is nothing to play.
   */
  previewPhrase(phrase: number): boolean {
    const check = this.check;
    const previews = check?.stopped == null ? undefined : check.plan.phrasePreviews;
    const span = previews === undefined ? null : phrasePreviewSpan(previews, phrase);
    if (check == null || previews === undefined || span === null || this.onDeck.A === null) return false;
    this.stopClip();
    this.stopPreview();
    const fader = checkDecksFor(check.plan).A.fader;
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

  private stopClip(): void {
    const clip = this.clip;
    if (clip === null) return;
    this.clip = null;
    this.stopWatching();
    this.settingUpWith(() => {
      if (this.onDeck[clip.deck] !== null) this.send({ control: "pause", deck: clip.deck });
    });
  }

  /** The live caption for the stretch of the Check the deck is in now. */
  checkCue(): PositionCue | null {
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
