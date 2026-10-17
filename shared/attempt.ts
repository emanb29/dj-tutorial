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
 * Controls whose events a Check reads. Values:
 * - `channelFader`: position 0 (closed) … 1 (open). Gain comes from `channelFaderGainDb`.
 * - `crossfader`: position 0 (full A) … 1 (full B); 0.5 is centre. Gain from `crossfaderGainDb`.
 * - `trim`, `eqHigh`, `eqMid`, `eqLow`: dB, 0 = centre.
 * - `cueMonitor`: the headphone CUE button state, 1 = on, 0 = off.
 * - `deckCue`: the deck CUE button, 1 = pressed, 0 = released.
 * - `tap`: the Lesson tap key, value 1 per press, no deck.
 * - `ready`: the Learner pressed "Ready" (e.g. trim set, `gain-staging`); `deck` says which deck.
 * - `done`: the Learner pressed "Done"; no deck.
 */
export type ControlId =
  | "channelFader"
  | "crossfader"
  | "trim"
  | "eqHigh"
  | "eqMid"
  | "eqLow"
  | "cueMonitor"
  | "deckCue"
  | "tap"
  | "ready"
  | "done";

export interface ControlEvent {
  /**
   * Heard time of the input: `ts.contextTime + (event.timeStamp − ts.performanceTime) / 1000`,
   * with `ts = audioContext.getOutputTimestamp()`.
   */
  readonly ctx: CtxTime;
  readonly control: ControlId;
  readonly deck?: DeckId;
  readonly value: number;
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

/** One deck during the attempt. v1 assumes one track per deck per attempt (see `cuePoints`). */
export interface DeckRecording {
  readonly trackId: string;
  readonly playhead: PlayheadModel;
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
  readonly cueMonitor: boolean;
}

/** The mixer at the start of the attempt. Later state is derived from the event timeline. */
export interface MixerSnapshot {
  readonly A: ChannelSnapshot;
  readonly B: ChannelSnapshot;
  readonly crossfader: number;
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
 * The crossfader's gain curve for one deck: full level from its own side to centre, then linear
 * amplitude down to silence at the far side.
 */
export function crossfaderGainDb(deck: DeckId, position: number): number {
  const amplitude = Math.min(1, deck === "A" ? 2 * (1 - position) : 2 * position);
  if (amplitude <= 0) return GAIN_FLOOR_DB;
  return Math.max(GAIN_FLOOR_DB, 20 * Math.log10(amplitude));
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
  | { readonly lessonId: "blend-by-ear" };

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
  /**
   * Decks with SYNC on when the attempt starts (the Lesson's setup). Later changes come from the
   * recorded SYNC commands. Absent = none.
   */
  readonly syncedAtStart?: readonly DeckId[];
}
