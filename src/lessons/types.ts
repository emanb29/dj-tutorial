// The shape of a Lesson as data: what the Learner touches first (the hook), how they practise, and
// how the Check is set up on the chosen track. Pure data plus pure builders; no audio, no React.
import type { Aids, Attempt, BeatGrid, CtxSpan, DeckId, LessonId, LessonTask, TaskTrack } from "@shared/attempt.ts";
import type { CriterionId } from "@shared/check-result.ts";
import type { ControlId } from "@app/controller/control-ids.ts";

/** A part of the virtual controller (src/app/controller): `A.play`, `B.channel-fader`, `tap`, … */
export type { ControlId } from "@app/controller/control-ids.ts";
export type { DeckId } from "@shared/attempt.ts";

/** A track a Lesson runs on, with what the Lesson needs to know about it (no audio). */
export interface LessonTrack {
  readonly trackId: string;
  readonly title: string;
  readonly attribution: { readonly text: string; readonly url: string | null };
  readonly source: "original" | "starter-pack" | "synthetic";
  readonly durationSec: number;
  readonly grid: BeatGrid;
  /** Track seconds of every 8-bar phrase start from bar 1, ascending. */
  readonly phraseStarts: readonly number[];
  /** Named sections (intro, breakdown, drop …) by the 1-based 8-bar phrase they start on; empty when unknown. */
  readonly sections: readonly TrackSection[];
  /** The track's sample peak, dBFS, measured from its audio when loaded; unknown until then. */
  readonly peakDbfs?: number;
  /**
   * The track deck B plays, when the Lesson mixes two different tracks (`LessonDefinition.partner`):
   * another house track whose tempo fits the Check. Absent: deck B plays this track too.
   */
  readonly partner?: LessonTrack;
}

export interface TrackSection {
  readonly name: string;
  /** 1-based number of the 8-bar phrase (from bar 1) the section starts on. */
  readonly phrase: number;
}

/** Something the Learner did, as the Lesson sees it. Built by the app from engine events. */
export type Observation =
  | { readonly kind: "play"; readonly deck: DeckId; readonly playing: boolean }
  | { readonly kind: "fader"; readonly deck: DeckId; readonly value: number }
  /** A tap, placed on the grid of the Lesson's tap deck (`LessonDefinition.tapDeck`). */
  | {
      readonly kind: "tap";
      /** Signed distance to the nearest beat, ms (negative = early). */
      readonly offsetMs: number;
      readonly onBeat: boolean;
      readonly onDownbeat: boolean;
      /** Within 1 beat of an 8-bar phrase start. */
      readonly onPhraseStart: boolean;
    }
  /** A control was moved or pressed (knobs, the jog wheel). */
  | { readonly kind: "touch"; readonly control: ControlId }
  | { readonly kind: "headphone-cue"; readonly deck: DeckId; readonly on: boolean }
  /** A channel's sample peak over the last second, dBFS (pre-fader). */
  | { readonly kind: "level"; readonly deck: DeckId; readonly peakDb: number }
  /** The Learner pressed Ready (R); `inZone` = every Ready deck's level sat in the target zone. */
  | { readonly kind: "ready"; readonly inZone: boolean }
  /** A cue point was set while paused, placed on the deck's grid. */
  | { readonly kind: "cue-set"; readonly deck: DeckId; readonly offsetMs: number; readonly onDownbeat: boolean }
  /** Deck CUE held at the cue point: the preview plays. */
  | { readonly kind: "cue-preview"; readonly deck: DeckId }
  /**
   * B started while A played: a cut, or the start of a blend. `offsetMs` is to A's nearest phrase
   * start; `onPhrase` is within the cut's ±120 ms, `withinBeat` within the blend start's ±1 beat.
   */
  | { readonly kind: "cut"; readonly offsetMs: number; readonly onPhrase: boolean; readonly withinBeat: boolean }
  /** A deck's SYNC turned on or off by the Learner. */
  | { readonly kind: "sync"; readonly deck: DeckId; readonly on: boolean }
  /** An EQ band moved: its level in dB (0 = centre, −Infinity = killed). */
  | { readonly kind: "eq"; readonly deck: DeckId; readonly band: EqBand; readonly db: number }
  /** The LOW came back to centre after a cut; `onPhrase` = within 1 beat of the deck's nearest phrase start. */
  | { readonly kind: "eq-return"; readonly deck: DeckId; readonly onPhrase: boolean }
  /** The crossfader moved: 0 = full A … 1 = full B. */
  | { readonly kind: "crossfader"; readonly value: number }
  /** tempo-fader practice: Ready (R) with deck B's BPM on the target or not. */
  | { readonly kind: "tempo-set"; readonly onTarget: boolean };

export type EqBand = "low" | "mid" | "high";

/** What a hook step waits for. Deck-less triggers default to deck A. */
export type HookTrigger =
  | { readonly kind: "play"; readonly deck?: DeckId }
  | { readonly kind: "fader-up"; readonly deck?: DeckId }
  | { readonly kind: "fader-down"; readonly deck?: DeckId }
  | { readonly kind: "beat-taps"; readonly count: number }
  | { readonly kind: "downbeat-taps"; readonly count: number }
  | { readonly kind: "phrase-taps"; readonly count: number }
  | { readonly kind: "touch"; readonly control: ControlId }
  | { readonly kind: "cue-on"; readonly deck: DeckId }
  /** The deck's level reading lands in the gain-staging zone. */
  | { readonly kind: "in-zone"; readonly deck: DeckId }
  | { readonly kind: "cue-set" }
  | { readonly kind: "cue-preview" }
  | { readonly kind: "cut" }
  | { readonly kind: "sync-on"; readonly deck: DeckId }
  /** An EQ band at or below the kill line (−20 dB, the eq-basics Check's). */
  | { readonly kind: "eq-cut"; readonly deck: DeckId; readonly band: EqBand }
  /** An EQ band back within 1 dB of centre. */
  | { readonly kind: "eq-centred"; readonly deck: DeckId; readonly band: EqBand }
  /** The crossfader all the way to one side (within 5% of the end). */
  | { readonly kind: "crossfader-to"; readonly side: DeckId };

export interface HookStep {
  /** What to do, a few words with the key: "Press X". */
  readonly caption: string;
  /** The control to touch. It unlocks (and pulses) when this step begins. */
  readonly control: ControlId;
  readonly trigger: HookTrigger;
  /** The concept, named after the Learner has done it: "That's the channel fader." */
  readonly named: string;
  /** Other parts that unlock with this step, unpulsed (the BPM display beside the tempo fader). */
  readonly reveals?: readonly ControlId[];
}

/** Practice reps feed a rolling window; the Learner is "consistent" once enough recent reps were good. */
export interface PracticeConfig {
  readonly caption: string;
  /**
   * What counts as one rep: a fade out, a tap, a Ready press (good when in the zone), a cue point set
   * (good on a downbeat within 20 ms), a cut (good on A's phrase start within 120 ms), a blend start
   * (B's Play within 1 beat of A's phrase start), a Ready with B on the target BPM, a LOW brought back
   * on a phrase start (within 1 beat).
   */
  readonly rep: "fade" | "beat-tap" | "phrase-tap" | "ready" | "cue-set" | "cut" | "blend-start" | "tempo-set" | "eq-return";
  readonly window: number;
  readonly needed: number;
}

/** How one deck is set up for practice or the Check. Absent fields are left as they are. */
export interface DeckSetup {
  /** Track seconds to cue to. */
  readonly pos: number;
  readonly fader: number;
  readonly play: boolean;
  /** Trim knob, −1…1 (0 is unity). */
  readonly trim?: number;
  readonly headphoneCue?: boolean;
  /** Set the deck's cue point at `pos` (the deck is left paused there). */
  readonly cuePoint?: true;
  /**
   * Tempo off the track's own, percent (Placement: B starts 1–3% apart). Set with the tempo fader,
   * after SYNC and the range, and only while SYNC is off (a synced deck's tempo is the leader's).
   */
  readonly tempoPercent?: number;
  /** SYNC on or off (set before the tempo fader: a synced deck's tempo is the leader's). */
  readonly sync?: boolean;
  /** The tempo range, ±%: set before the tempo fader, which moves across it. */
  readonly tempoRange?: 6 | 10 | 16;
  readonly masterTempo?: boolean;
  /** HI, MID and LOW back to centre. */
  readonly eqCentred?: true;
}

export interface DeckSetups {
  readonly A: DeckSetup;
  readonly B?: DeckSetup;
  /** The crossfader, 0 (full A) … 1 (full B); absent leaves it where it is. */
  readonly crossfader?: number;
}

/** Practice and Check decks loop back to their set-up after this; `positions` keeps knobs and faders. */
export interface LoopPlan {
  /** Track position on the deck (default A) that triggers the loop. */
  readonly atPos: number;
  readonly reset: "positions" | "setup";
  /** The deck whose position triggers the loop (tempo-fader practice plays only B). Default A. */
  readonly deck?: DeckId;
  /** What a "setup" reset goes back to, when not the first set-up (practice keeps SYNC as the hook left it). */
  readonly decks?: DeckSetups;
}

/** A short piece of the Lesson track the cue-point Check loads, in turn, as its own track. */
export interface TrackSlice {
  readonly fromSec: number;
  readonly lengthSec: number;
}

export type CheckEnd =
  | { readonly kind: "faded-out" }
  /** Deck A reached this track position. */
  | { readonly kind: "position"; readonly pos: number }
  /** Every deck pressed Ready, then `bars` more bars (gain-staging). */
  | { readonly kind: "ready-windows"; readonly decks: readonly DeckId[]; readonly bars: number }
  /** The Learner pressed Ready on every slice (cue-point). */
  | { readonly kind: "slices-done" }
  /** This long after the Check starts. */
  | { readonly kind: "after"; readonly sec: number }
  /** `bars` after the Learner closed this deck's channel fader: a blend's end, plus the bars loud-steady reads. */
  | { readonly kind: "faded-out-then"; readonly deck: DeckId; readonly bars: number }
  /** `count` Ready presses for `deck` (tempo-fader: one per target BPM). */
  | { readonly kind: "readies"; readonly deck: DeckId; readonly count: number };

/** How the app sets the deck up for the Check and when the audio part ends. */
export interface CheckPlan {
  /** Track seconds the deck is cued to before the Check starts (auto-jump: no dead waiting). */
  readonly startPos: number;
  /** The app presses Play itself when the Check starts (tap Lessons), or the Learner does (deck-basics). */
  readonly autoPlay: boolean;
  /** The channel fader at the start. */
  readonly faderAtStart: number;
  /** Deck A's trim and headphone CUE, and deck B, when the Lesson uses them. */
  readonly deckA?: Omit<DeckSetup, "pos" | "fader" | "play" | "cuePoint">;
  readonly deckB?: DeckSetup;
  readonly loop?: LoopPlan;
  /** cue-point: the slices, loaded on deck A one after another; each Ready moves to the next. */
  readonly slices?: readonly TrackSlice[];
  /** The crossfader at the start (crossfader: full A); absent leaves it where it is. */
  readonly crossfader?: number;
  /** Listening clips played while a question is asked, by question id (tempo-fader). */
  readonly clips?: Readonly<Record<string, ListeningClip>>;
  /** When the audio part ends by itself. */
  readonly endWhen: CheckEnd;
  /** Hard stop for the audio part, seconds after the Check starts. */
  readonly timeoutSec: number;
  /** Live caption per stretch of the attempt, by track position (e.g. "every beat" → "only the 1"). */
  readonly cues: readonly PositionCue[];
  /** Live caption by the number of Ready presses so far (overrides `cues` when present). */
  readonly readyCues?: readonly string[];
}

export interface CheckQuestion {
  readonly id: string;
  readonly caption: string;
  /** Answers are 1…options. */
  readonly options: number;
  /** Named answers instead of numbers: key 1 picks the first, and `value` is what the attempt records. */
  readonly choices?: readonly { readonly label: string; readonly value: number }[];
}

/**
 * A clip played on a loop while its question is up: the deck plays `leadBars` at its own tempo, then
 * `bars` with the tempo fader at `tempo` (on the ±`rangePercent` range) and Master Tempo as given.
 */
export interface ListeningClip {
  readonly deck: DeckId;
  readonly pos: number;
  readonly leadBars: number;
  readonly bars: number;
  readonly tempo: number;
  readonly rangePercent: 6 | 10 | 16;
  readonly masterTempo: boolean;
}

export interface PositionCue {
  readonly fromPos: number;
  readonly caption: string;
  /** A checkpoint in a long attempt ("halfway ✓"): a quick tick on screen; the music keeps playing. */
  readonly checkpoint?: true;
}

export interface LessonDefinition {
  readonly id: LessonId;
  readonly title: string;
  /** Controls this Lesson adds to the controller. */
  readonly unlocks: readonly ControlId[];
  /** Track seconds the deck jumps to for the hook and practice. */
  readonly practiceStart: (track: LessonTrack) => number;
  /** Both decks for hook and practice, when the Lesson needs more than deck A at `practiceStart`. */
  readonly practiceDecks?: (track: LessonTrack) => DeckSetups;
  /** Practice loops back here (default: tap Lessons loop 16 or 24 bars of deck A). */
  readonly practiceLoop?: (track: LessonTrack) => LoopPlan | null;
  /** Split cue: headphones on, the one-time headphones check first. */
  readonly headphones?: true;
  /** Which deck's grid taps are placed on (headphone-cue taps deck B). Default A. */
  readonly tapDeck?: DeckId;
  /**
   * Deck B plays a second track (sync-blend, crossfader): `problems` says why a candidate pair does not
   * fit the Check (e.g. tempos more than 3% apart); empty = it fits.
   */
  readonly partner?: { readonly problems: (track: LessonTrack, partner: LessonTrack) => readonly string[] };
  /** The engine needs Master Tempo (time-stretching) for this Lesson. */
  readonly masterTempo?: true;
  /** Aids this Lesson's Check offers, over `LESSON_AIDS` (sync, the BPM display). */
  readonly aids?: Partial<Aids>;
  /**
   * Grade from the Check's own cue on every deck it sets up, not from the recorder's start: for the
   * output latency after the attempt starts, the practice is still heard (and metered).
   */
  readonly gradeFromOwnCue?: true;
  /** The practice caption for this track, when it names a value of the track (tempo-fader's target BPM). */
  readonly practiceCaptionFor?: (track: LessonTrack) => string;
  /** tempo-fader practice: the BPM deck B is set to before each Ready. */
  readonly practiceTargetBpm?: (track: LessonTrack) => number;
  /** Can this Lesson run on this track (e.g. phrases needs a named breakdown and drop)? */
  readonly trackProblems: (track: LessonTrack) => readonly string[];
  readonly hook: readonly HookStep[];
  readonly practice: PracticeConfig;
  /** The one line before the Check. */
  readonly checkCaption: string;
  /** Questions asked after the audio part of the Check (phrases); answers go into the attempt. */
  readonly questions: readonly CheckQuestion[];
  /** `attempt` (1, 2, …) varies what must differ between attempts, such as which clip has Master Tempo on. */
  readonly planCheck: (track: LessonTrack, attempt?: number) => CheckPlan;
  /**
   * The task the Check grades, from the plan and what was recorded. Pure. A recorded playhead model
   * holds the track's whole history since it was loaded (hook, practice, earlier attempts): look for
   * this attempt's moments within `window` only.
   */
  readonly taskFor: (track: LessonTrack, plan: CheckPlan, attempt: Attempt, window: CtxSpan) => LessonTask;
  /** The tracks the Check grades (default: the Lesson track on deck A). */
  readonly taskTracks?: (track: LessonTrack, plan: CheckPlan, trackSetId: string | null) => readonly TaskTrack[];
  /** Authored tips per criterion (coach-design §1 c), rotated. */
  readonly tips: Readonly<Partial<Record<CriterionId, readonly string[]>>>;
}
