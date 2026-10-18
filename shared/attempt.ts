/**
 * A recorded attempt: everything a Check reads (docs/check-design.md §1).
 *
 * The audio engine (`src/audio`) produces these; the Checks (`src/checks`) read them and nothing
 * else. Two clocks never mix:
 * - `CtxTime`: AudioContext seconds, on *heard* time, inside one attempt only.
 * - `IsoTime`: wall clock, for the Skill profile's scheduling only.
 */

/** AudioContext seconds, on heard time. Valid inside one attempt only. */
export type CtxTime = number;
/** Wall clock as an ISO 8601 string. Scheduling only; never compared with `CtxTime`. */
export type IsoTime = string;

export type DeckId = "A" | "B";

export const LESSON_IDS = [
  "deck-basics",
  "beats-and-bars",
  "phrases",
  "gain-staging",
  "headphone-cue",
  "cue-point",
  "cut-on-phrase",
  "tempo-fader",
  "sync-blend",
  "crossfader",
  "eq-basics",
  "bass-swap",
  "filter-transition",
  "nudge-phase",
  "tempo-by-ear",
  "blend-by-ear",
  "hot-cues",
  "loop-transition",
  "echo-out",
  "final-mix",
] as const;

/** A Lesson in the Lesson catalogue, in catalogue order (docs/lesson-catalogue.md §1). */
export type LessonId = (typeof LESSON_IDS)[number];

/** `cold` and `warmup` are cold re-passes; `bonus` never gates anything. */
export type CheckMode = "lesson" | "placement" | "cold" | "warmup" | "bonus";
export type CheckVariant = "full" | "short";

export type InputDevice = "keyboard" | "trackpad" | "mouse" | "touch" | "midi";

/** A closed-open span of heard time, `[from, to)`. */
export interface CtxSpan {
  readonly from: CtxTime;
  readonly to: CtxTime;
}

// ---------------------------------------------------------------------------------------------
// Control-event timeline
// ---------------------------------------------------------------------------------------------

/**
 * Controls whose events a Check reads, with their values.
 *
 * Mixer (per channel unless noted):
 * - `channelFader`: position 0 (closed) … 1 (open). Gain comes from `channelFaderGainDb`.
 * - `crossfader`: position 0 (full A) … 1 (full B); 0.5 is centre (both decks −3 dB); no deck. Gain from `crossfaderGainDb`.
 * - `trim`, `eqHigh`, `eqMid`, `eqLow`: dB, 0 = centre.
 * - `filter`: the CFX knob, −1 (full low-pass) … 0 (centre, off) … +1 (full high-pass).
 * - `cueMonitor`: the headphone CUE button state, 1 = on, 0 = off.
 *
 * Deck:
 * - `play`: the Play button, value 1 per accepted press. A point action: `ctx` is the press,
 *   `appliedCtx` is where the play run it started begins in the playhead model. (Pausing shows in
 *   the playhead model.)
 * - `deckCue`: the deck CUE button, 1 = pressed, 0 = released.
 * - `tempo`: the tempo fader as a playback-rate ratio: 1 = the track's own tempo, 1.06 = 6% faster.
 *   The fader's BPM is `grid.bpm × tempo` (the same ratio as `PlayheadSegment.rate`, before any jog
 *   bend). Recorded on tempo-fader moves and on tempo-range switches (which change the rate). The
 *   rate SYNC gives a follower is not a tempo event: it shows in the playhead model.
 * - `jogBend`: the jog wheel's temporary bend on a playing deck, as a fraction of the rate (0.05 =
 *   5% faster); 0 = released. The playhead rate is `tempo × (1 + jogBend)`.
 * - `sync`: SYNC, 1 = on (the deck follows the other deck's tempo), 0 = off. Includes SYNC dropped
 *   by the engine itself (`byEngine`).
 * - `masterTempo`: Master Tempo (key lock), 1 = on, 0 = off.
 *
 * Hot cues (deck; pads numbered 1–8, as printed). Point actions: graded at `ctx`, the press.
 * - `hotCueSet`: a pad stored a hot cue; value = the pad (1–8); `pos` = the track position stored
 *   (heard at the press while playing, or where the paused deck stands).
 * - `hotCue`: a set pad was triggered: the deck jumps to it and plays (quantize off); value = the pad;
 *   `pos` = the hot cue's position; `appliedCtx` = where the jump starts in the playhead model.
 *
 * Loops (deck). Each loop-button press is a point action at `ctx`; the loop it leaves on is in its
 * value and `pos`, so the loop on at any moment is the latest of these events:
 * - `loopIn`: LOOP IN, value 1; `pos` = the in point marked (heard at the press). No audible change.
 * - `loopOut` (LOOP OUT), `loopAuto` (4 BEAT), `loopDouble` (2X, SHIFT + OUT), `loopHalve` (½X,
 *   SHIFT + IN): value = the loop's length after the press, track seconds; `pos` = its start, track
 *   seconds. `appliedCtx` = when the loop took effect in the playhead model.
 * - `loopExit`: the loop ended, value 1: EXIT, or (`byEngine`) a seek, hot cue, CUE return or search
 *   that left it. The loop's audio is in the playhead model, where each wrap is a jump back to the start.
 *
 * Beat FX (ECHO, the only effect in v1; no deck unless noted). Its echoes are metered as `fxReturn`.
 * - `beatFx`: ON/OFF, 1 = on, 0 = off. Off stops new sound going in; the echoes ring out.
 * - `beatFxChannel`: CH SELECT, value 1; `deck` = the channel it takes in (after its fader and the
 *   crossfader); no deck = MASTER.
 * - `beatFxBeats`: BEAT ◀/▶, the echo's delay in beats of the selected deck (0.125 … 4).
 * - `beatFxDepth`: LEVEL/DEPTH, 0 … 1, the echoes' level.
 *
 * Lesson buttons (no audio effect):
 * - `tap`: the Lesson tap key, value 1 per press, no deck.
 * - `ready`: the Learner pressed "Ready" (e.g. trim set, `gain-staging`); `deck` says which deck.
 * - `done`: the Learner pressed "Done"; no deck.
 *
 * Not controls here, on purpose: seeking and jog search (the jog on a paused deck) move the
 * playhead, so the playhead model holds them; master level, cue mix and headphone level only shape
 * what the Learner monitors, and no criterion grades them.
 *
 * Not controls here either: clearing a hot cue (SHIFT + pad) changes no sound and no grade (a cleared
 * pad pressed again records a new `hotCueSet`); the Beat FX select is fixed on ECHO in v1.
 *
 * Extension point: a new graded control gets an id and a unit here, its starting state in `ChannelSnapshot` or `DeckStateSnapshot`, and its
 * engine-to-contract mapping in the recorder (src/audio/recorder.ts: `CONTRACT_CONTROLS`,
 * `contractValue` and the snapshot functions).
 */
export type ControlId =
  | "channelFader"
  | "crossfader"
  | "trim"
  | "eqHigh"
  | "eqMid"
  | "eqLow"
  | "filter"
  | "cueMonitor"
  | "play"
  | "deckCue"
  | "tempo"
  | "jogBend"
  | "sync"
  | "masterTempo"
  | "hotCueSet"
  | "hotCue"
  | "loopIn"
  | "loopOut"
  | "loopAuto"
  | "loopDouble"
  | "loopHalve"
  | "loopExit"
  | "beatFx"
  | "beatFxChannel"
  | "beatFxBeats"
  | "beatFxDepth"
  | "tap"
  | "ready"
  | "done";

export interface ControlEvent {
  /**
   * Heard time of the input: `ts.contextTime + (event.timeStamp − ts.performanceTime) / 1000`,
   * with `ts = audioContext.getOutputTimestamp()`. A change the engine made itself (`byEngine`) has
   * no input, so its `ctx` is its `appliedCtx`.
   */
  readonly ctx: CtxTime;
  readonly control: ControlId;
  readonly deck?: DeckId;
  readonly value: number;
  /**
   * When the change took effect in the audio and the playhead model: later than `ctx` by the output
   * latency and the engine's lookahead. Point actions are graded at `ctx` (the action). A Check that
   * lines a deck control up with the playhead model (tempo, jog bend, SYNC, Master Tempo, the run a
   * Play started) reads this. Absent = `ctx` (attempts built by hand).
   */
  readonly appliedCtx?: CtxTime;
  /** The engine made this change itself, with no input (e.g. SYNC dropped). Absent = false. */
  readonly byEngine?: boolean;
  /**
   * Track seconds the action placed or jumped to: the hot cue (`hotCueSet`, `hotCue`), the LOOP IN
   * point (`loopIn`), the loop's start (`loopOut`, `loopAuto`, `loopDouble`, `loopHalve`). Absent for
   * other controls.
   */
  readonly pos?: number;
}

// ---------------------------------------------------------------------------------------------
// Playhead models, beat grids, phrase markers
// ---------------------------------------------------------------------------------------------

/**
 * From `fromCtx` on (until the next segment), the deck's track position is
 * `pos + rate · (t − fromCtx)` track seconds. `rate` is the playbackRate; `rate = 0` is paused.
 * Jog bends are short segments with a different rate.
 */
export interface PlayheadSegment {
  readonly fromCtx: CtxTime;
  readonly pos: number;
  readonly rate: number;
}

/**
 * A loop on a deck, in track seconds: the deck plays `[start, end)` and wraps from `end` back to
 * `start`. In the playhead model each wrap is a segment at `start` (a jump back).
 */
export interface LoopSpan {
  readonly start: number;
  readonly end: number;
}

/** Segments ordered by `fromCtx`. Before the first segment the deck is stopped. */
export interface PlayheadModel {
  readonly segments: readonly PlayheadSegment[];
}

/**
 * A constant-tempo beat grid in track seconds. Beat `k` (any integer) is at
 * `firstBeat + k · 60 / bpm`; beat `k` is a downbeat when `(k − downbeatIndex) mod 4 = 0`.
 */
export interface BeatGrid {
  readonly bpm: number;
  readonly firstBeat: number;
  readonly downbeatIndex: number;
  /** RMS residual of the grid fit, ms. Over 15 ms the grid is untrusted and the attempt void. */
  readonly rmsResidualMs: number;
}

/** One track's stay on a deck: its playhead model from its load on (stopped before `loadedCtx` and after the next load). */
export interface TrackOnDeck {
  readonly trackId: string;
  readonly playhead: PlayheadModel;
  /** When the track was loaded (it may be before the attempt started). */
  readonly loadedCtx: CtxTime;
}

/**
 * One deck during the attempt: the track it holds at the end. Lesson Checks have one track per deck;
 * an attempt recorded with track changes allowed (`cue-point`'s slices, a `final-mix` set) also lists
 * the tracks the deck held before it, in `earlier`.
 */
export interface DeckRecording {
  readonly trackId: string;
  readonly playhead: PlayheadModel;
  /** When this track was loaded. Absent in attempts built by hand. */
  readonly loadedCtx?: CtxTime;
  /** The tracks this deck held earlier in the attempt, oldest first. Absent = none. */
  readonly earlier?: readonly TrackOnDeck[];
}

/** The deck's cue point as set by the Learner (deck CUE while paused), in track seconds. */
export interface CuePointSet {
  readonly ctx: CtxTime;
  readonly deck: DeckId;
  readonly trackId: string;
  readonly pos: number;
}

// ---------------------------------------------------------------------------------------------
// Level meters
// ---------------------------------------------------------------------------------------------

/**
 * One meter frame, 50 Hz. Channel meters are post-trim/EQ, pre-fader. Loudness is K-weighted
 * (EBU R128): momentary = 400 ms, short-term = 3 s. Silence may be `-Infinity` or any floor
 * value well below −70.
 */
export interface MeterFrame {
  readonly ctx: CtxTime;
  readonly samplePeakDb: number;
  readonly momentaryLufs: number;
  readonly shortTermLufs: number;
}

export interface MeterRecording {
  readonly master: readonly MeterFrame[];
  readonly A?: readonly MeterFrame[];
  readonly B?: readonly MeterFrame[];
  readonly fxReturn?: readonly MeterFrame[];
}

// ---------------------------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------------------------

export interface ChannelSnapshot {
  readonly channelFader: number;
  readonly trimDb: number;
  readonly eqHighDb: number;
  readonly eqMidDb: number;
  readonly eqLowDb: number;
  /** The CFX knob, as the `filter` control. */
  readonly filter: number;
  readonly cueMonitor: boolean;
}

/** What Beat FX takes in: a channel (after its fader and the crossfader) or the whole master. */
export type BeatFxChannel = DeckId | "master";

/** Beat FX (ECHO, the only effect in v1), in the units of its control events. */
export interface BeatFxSnapshot {
  readonly on: boolean;
  readonly channel: BeatFxChannel;
  /** The echo's delay in beats of the selected deck (BEAT ◀/▶): 0.125 … 4. */
  readonly beats: number;
  /** LEVEL/DEPTH, 0 … 1: the echoes' level. */
  readonly depth: number;
}

/** Beat FX as the engine starts it, and for an attempt built by hand without `MixerSnapshot.beatFx`. */
export const BEAT_FX_DEFAULT: BeatFxSnapshot = { on: false, channel: "master", beats: 1, depth: 0.5 };

/** The mixer at the start of the attempt. Later state is derived from the event timeline. */
export interface MixerSnapshot {
  readonly A: ChannelSnapshot;
  readonly B: ChannelSnapshot;
  readonly crossfader: number;
  /** Absent (an attempt built by hand) = `BEAT_FX_DEFAULT`, off. */
  readonly beatFx?: BeatFxSnapshot;
}

/**
 * One deck's controls at the start of the attempt, in the units of their control events. Later
 * state is derived from the event timeline.
 */
export interface DeckStateSnapshot {
  /** As the `tempo` control: a playback-rate ratio, 1 = the track's own tempo. */
  readonly tempo: number;
  /** As the `jogBend` control; 0 unless the jog is turning as the attempt starts. */
  readonly jogBend: number;
  readonly sync: boolean;
  readonly masterTempo: boolean;
  /** Hot cue positions by pad (index 0 = pad 1), null = empty. Absent (built by hand) = all empty. */
  readonly hotCues?: readonly (number | null)[];
  /** The loop on at the start, track seconds. Absent (built by hand) = none. */
  readonly loop?: LoopSpan | null;
}

/** Below this, a gain counts as silence (keeps margins finite). */
export const GAIN_FLOOR_DB = -120;

/**
 * The channel fader's gain curve, shared by the engine and the Checks so they cannot disagree:
 * amplitude = position², so 0.5 is about −12 dB and 0.25 about −24 dB (the `audible` line).
 */
export function channelFaderGainDb(position: number): number {
  if (position <= 0) return GAIN_FLOOR_DB;
  return Math.max(GAIN_FLOOR_DB, 40 * Math.log10(Math.min(position, 1)));
}

/**
 * The crossfader's gain curve for one deck: constant power, as a DJ mixer's smooth (blend) curve.
 * Amplitude is cos/sin of the travel: A = cos(position · π/2), B = sin(position · π/2), so the two
 * decks' powers always sum to one and both sit at −3 dB at the centre (a slow blend holds its
 * loudness). The ends still cut hard: fully to one side, the other deck is silent.
 */
export function crossfaderGainDb(deck: DeckId, position: number): number {
  const towardDeck = Math.min(1, Math.max(0, deck === "A" ? 1 - position : position));
  if (towardDeck <= 0) return GAIN_FLOOR_DB;
  return Math.max(GAIN_FLOOR_DB, 20 * Math.log10(Math.sin((towardDeck * Math.PI) / 2)));
}

// ---------------------------------------------------------------------------------------------
// The attempt and the task spec
// ---------------------------------------------------------------------------------------------

export type InterruptionKind = "contextSuspended" | "tabHidden";

export interface Interruption {
  readonly ctx: CtxTime;
  readonly kind: InterruptionKind;
}

/** Everything the engine recorded during one attempt. */
export interface Attempt {
  readonly attemptId: string;
  readonly learnerId: string;
  readonly startedAt: IsoTime;
  readonly endedAt: IsoTime;
  /** "done" = the Learner pressed Done (or the task ended itself); "timeout" = task + 16 bars. */
  readonly endReason: "done" | "timeout";
  readonly inputDevice: InputDevice;
  /** The Learner left the attempt before it ended. Makes the attempt void. */
  readonly abandoned: boolean;
  /** AudioContext suspensions or hidden-tab moments. Inside the task window they void it. */
  readonly interruptions: readonly Interruption[];
  readonly events: readonly ControlEvent[];
  readonly decks: Readonly<Partial<Record<DeckId, DeckRecording>>>;
  /** Beat grid per track id. */
  readonly grids: Readonly<Record<string, BeatGrid>>;
  /** Phrase markers per track id, track seconds, ascending. */
  readonly phraseMarkers: Readonly<Record<string, readonly number[]>>;
  readonly cuePoints: readonly CuePointSet[];
  readonly meters: MeterRecording;
  readonly initialMixer: MixerSnapshot;
  /** Each deck's controls at the start: tempo, jog bend, SYNC (the Lesson's setup), Master Tempo. */
  readonly initialDecks: Readonly<Record<DeckId, DeckStateSnapshot>>;
  /** Answers the Learner picked, by question id (e.g. `{ breakdown: 2, drop: 3 }`). */
  readonly answers: Readonly<Record<string, number>>;
}

export interface Aids {
  readonly sync: boolean;
  readonly quantize: boolean;
  readonly bpmDisplay: boolean;
  readonly phaseMeter: boolean;
  readonly lessonText: boolean;
}

export interface TaskTrack {
  readonly trackId: string;
  readonly trackSetId: string | null;
  readonly deck: DeckId;
}

/** Per-Lesson parameters of a task. The Lesson content fills these in. */
export type LessonTask =
  | { readonly lessonId: "deck-basics" }
  | {
      readonly lessonId: "beats-and-bars";
      /** Tap every beat here (8 bars full, 4 bars short). */
      readonly beatSection: CtxSpan;
      /** Tap only downbeats here (8 bars full, 4 bars short). */
      readonly downbeatSection: CtxSpan;
    }
  | {
      readonly lessonId: "phrases";
      /** Tap each phrase start here (64 bars full, 32 bars short). */
      readonly tapSection: CtxSpan;
      /** The marked phrase index of each section; the Learner's picks are `Attempt.answers`. */
      readonly sections: { readonly breakdown: number; readonly drop: number };
    }
  | {
      readonly lessonId: "gain-staging";
      /** Both decks in the full form; one deck in the short form. */
      readonly decks: readonly DeckId[];
    }
  | {
      readonly lessonId: "headphone-cue";
      /** Tap B's beat here (8 bars full, 4 bars short). */
      readonly tapSection: CtxSpan;
    }
  | { readonly lessonId: "cue-point" }
  | { readonly lessonId: "cut-on-phrase" }
  | {
      readonly lessonId: "tempo-fader";
      /**
       * Set B to each BPM in turn (3 full, 1 short). The i-th confirm press (`ready` or `done`, in
       * time order) marks target i. B plays while the Learner sets it, so its tempo is in its playhead.
       */
      readonly targetsBpm: readonly number[];
      /** Listening clips: was Master Tempo on? The Learner's pick (1 = on, 0 = off) is `answers[answerKey]`. */
      readonly masterTempoClips: readonly { readonly answerKey: string; readonly masterTempoOn: boolean }[];
    }
  | { readonly lessonId: "sync-blend" }
  | {
      readonly lessonId: "crossfader";
      /** A blends into B here, crossfader only. */
      readonly blendSection: CtxSpan;
      /** A cut to `incoming` here, crossfader only; `null` in the short form (blend only). */
      readonly cutSection: { readonly span: CtxSpan; readonly incoming: DeckId } | null;
    }
  | { readonly lessonId: "eq-basics" }
  | { readonly lessonId: "bass-swap" }
  | { readonly lessonId: "filter-transition" }
  | {
      readonly lessonId: "nudge-phase";
      /** Phase grading starts here: both decks playing, B up to ¼ beat out of phase. */
      readonly phaseFrom: CtxTime;
    }
  | {
      readonly lessonId: "tempo-by-ear";
      /** Tempo matching starts here: both decks playing, 0.5–2% apart. */
      readonly matchFrom: CtxTime;
    }
  | { readonly lessonId: "blend-by-ear" }
  | {
      readonly lessonId: "hot-cues";
      /** The hot cues are set here, on deck A paused near each phrase start in turn. */
      readonly placeSection: CtxSpan;
      /** A plays from here; each pad is triggered on one of A's phrase starts. */
      readonly triggerSection: CtxSpan;
      /** The pads to set and trigger (1–8): 3 in the full form, 1 in the short. */
      readonly slots: readonly number[];
    }
  | { readonly lessonId: "loop-transition" }
  | { readonly lessonId: "echo-out" }
  | {
      readonly lessonId: "final-mix";
      /** The set the Learner built, in play order, with the genre and key set in track prep. */
      readonly set: readonly SetTrack[];
    };

/** A track of a `final-mix` set, as the Learner prepared it. */
export interface SetTrack {
  readonly trackId: string;
  /** The genre tag set in track prep (`one-genre`), lower case. */
  readonly genre: string;
  /** The Camelot key (e.g. "8A"), when the track's source knows it. */
  readonly camelot: string | null;
}

/** What the Learner was asked to do. */
export interface TaskSpec {
  readonly mode: CheckMode;
  readonly variant: CheckVariant;
  readonly task: LessonTask;
  readonly tracks: readonly TaskTrack[];
  readonly aids: Aids;
  /** Grading covers this span. */
  readonly window: CtxSpan;
  /**
   * Lessons passed before this attempt (in Placement: every credited ancestor). Decides which
   * standing criteria apply.
   */
  readonly passedLessons: readonly LessonId[];
}
