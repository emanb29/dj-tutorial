// The shape of a Lesson as data: what the Learner touches first (the hook), how they practise, and
// how the Check is set up on the chosen track. Pure data plus pure builders; no audio, no React.
import type { Aids, Attempt, BeatFxSnapshot, BeatGrid, CtxSpan, DeckId, LessonId, LessonTask, TaskTrack } from "@shared/attempt.ts";
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
  | { readonly kind: "tempo-set"; readonly onTarget: boolean }
  /** The CFX knob moved: −1 (full low-pass) … 0 (off) … +1 (full high-pass). */
  | { readonly kind: "filter"; readonly deck: DeckId; readonly value: number }
  /**
   * The LOWs swapped: A's LOW went down through −6 dB and B's came up through it, within 2 bars of each
   * other. `onPhrase`: their mean heard time is within 1 beat of A's nearest phrase start, both playing.
   */
  | { readonly kind: "swap"; readonly onPhrase: boolean }
  /**
   * A's channel fader closed while A played: `depth` is the most high-pass the sweep on CFX A reached
   * (0 without one), `bars` how long the sweep was on when the fader closed (null without one).
   */
  | { readonly kind: "filter-out"; readonly depth: number; readonly bars: number | null }
  /** A by-ear practice round (`PracticeDrill`): B held in phase long enough (`held`), or the round ran out. */
  | { readonly kind: "phase-rep"; readonly held: boolean }
  /** tempo-by-ear practice: the first tempo move of a round went the way that brings the decks together. */
  | { readonly kind: "tempo-guess"; readonly right: boolean }
  /** tempo-by-ear practice: Ready (R) with the tempos `offBpm` apart; `good` within the Check's 0.1 BPM. */
  | { readonly kind: "tempo-match"; readonly offBpm: number; readonly good: boolean }
  /** sync-blend's stepped blend (blend-steps.ts): a step made in order, or missed with what went wrong. */
  | { readonly kind: "blend-step"; readonly step: number; readonly good: boolean; readonly mistake: string | null }
  /** An empty pad stored a hot cue (pads 1–8). */
  | { readonly kind: "hot-cue-set"; readonly deck: DeckId; readonly slot: number }
  /** A set pad was pressed: the deck jumped. `offsetMs` is to the deck's nearest phrase start at the press. */
  | { readonly kind: "hot-cue"; readonly deck: DeckId; readonly slot: number; readonly offsetMs: number | null; readonly onPhrase: boolean }
  | { readonly kind: "loop-in"; readonly deck: DeckId }
  /** A loop went on or changed (LOOP OUT, 4 BEAT, 2X, ½X): its length, and whether it starts within 1 beat of a downbeat. */
  | { readonly kind: "loop"; readonly deck: DeckId; readonly bars: number; readonly onDownbeat: boolean }
  /** EXIT pressed; `onDownbeat` = within 1 beat of a downbeat. */
  | { readonly kind: "loop-exit"; readonly deck: DeckId; readonly onDownbeat: boolean }
  | { readonly kind: "beat-fx"; readonly on: boolean }
  /** Deck A's fader closed: on a downbeat (within 1 beat)? with ECHO taking A in? */
  | { readonly kind: "echo-cut"; readonly onDownbeat: boolean; readonly echoOn: boolean };

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
  | { readonly kind: "crossfader-to"; readonly side: DeckId }
  /** The CFX knob at least halfway to high-pass or low-pass, or back within 5% of centre. */
  | { readonly kind: "filter-to"; readonly deck: DeckId; readonly side: "high-pass" | "low-pass" | "centre" }
  /** A bass swap (LOW A down, LOW B up), on the phrase or not. */
  | { readonly kind: "swap" }
  /** A practice drill round held B in phase (`phase-rep` held). */
  | { readonly kind: "phase-held" }
  /** A tempo-by-ear round's first tempo move (right or wrong). */
  | { readonly kind: "tempo-guess" }
  /** A tempo-by-ear round's Ready (matched or not). */
  | { readonly kind: "tempo-match" }
  /** The stepped blend made up to and including `step` (0-based), in order. */
  | { readonly kind: "blend-step"; readonly step: number }
  | { readonly kind: "hot-cue-set" }
  | { readonly kind: "hot-cue-trigger" }
  | { readonly kind: "loop-in" }
  /** A loop went on (or changed). */
  | { readonly kind: "loop-on" }
  | { readonly kind: "loop-exit" }
  | { readonly kind: "beat-fx-on" };

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
   * on a phrase start (within 1 beat), a bass swap (good within 1 beat of A's phrase start), A's fader
   * closed after a high-pass sweep on CFX A (good at 70% or more, on for 8–16 bars), a drill round
   * held in phase (`phase-hold`), a tempo-by-ear round's guess and its Ready (`tempo-ear`: each is a
   * rep), a step of the stepped blend (good when made in order), a hot cue triggered on a phrase start
   * (within 120 ms), a loop of 4 or 8 bars from a downbeat, or a cut of A on a downbeat with ECHO on.
   */
  readonly rep: "fade" | "beat-tap" | "phrase-tap" | "ready" | "cue-set" | "cut" | "blend-start" | "tempo-set" | "eq-return" | "swap" | "filter-out" | "phase-hold" | "tempo-ear" | "blend-step" | "hot-cue-trigger" | "loop" | "echo-cut";
  readonly window: number;
  readonly needed: number;
}

/** How one deck is set up for practice or the Check. Absent fields are left as they are. */
export interface DeckSetup {
  /** Track seconds to cue to. */
  readonly pos: number;
  readonly fader: number;
  readonly play: boolean;
  /**
   * Trim knob, −1…1 (0 is unity). Absent: the set-up level for the Lesson's tracks (`setUpTrim`), so
   * no set-up starts in the red; only a Lesson about trimming (gain-staging) sets it.
   */
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
  /** The CFX knob back to centre (no filter). */
  readonly filterCentred?: true;
  /** LOW all the way down, after `eqCentred` (blend-by-ear brings B in with no bass, for the swap). */
  readonly lowCut?: true;
  /** The 8 hot cue pads, track seconds or null for empty: every pad is cleared, then these are set. */
  readonly hotCues?: readonly (number | null)[];
}

export interface DeckSetups {
  readonly A: DeckSetup;
  readonly B?: DeckSetup;
  /** The crossfader, 0 (full A) … 1 (full B); absent leaves it where it is. */
  readonly crossfader?: number;
  /** Beat FX as given (the rest left as it is). */
  readonly beatFx?: Partial<BeatFxSnapshot>;
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
  | { readonly kind: "readies"; readonly deck: DeckId; readonly count: number }
  /**
   * B held with A for `bars` (phase under `phaseMs` and, when given, tempos within `tempoBpm`), read
   * live with limits a little tighter than the Check's, once deck A is past `notBeforePos` (so the
   * Check's own hold window is recorded); else deck A reaching `orPos`. The by-ear Lessons end as
   * soon as the Learner has done it, instead of making them hold on to a fixed length.
   */
  | {
      readonly kind: "held";
      readonly phaseMs: number;
      readonly tempoBpm: number | null;
      readonly bars: number;
      readonly notBeforePos: number;
      readonly orPos: number;
    }
  /** `bars` (of deck A's track) after the Learner did `count` of `what` in the Check (3 hot cue triggers; B's Play). */
  | { readonly kind: "did-then"; readonly what: HookTrigger; readonly count: number; readonly bars: number };

/**
 * A by-ear practice drill (Lessons 14–16): short rounds, one rep each, run live by the app. A round
 * starts both decks again from their practice set-up with B `offsetsBeats[i]` out of phase and
 * `apartPercents[i]` off A's tempo (rotating through the lists); between rounds, `revealMs` of feedback
 * (and the covered displays shown, `LessonDefinition.locks`).
 * - `hold`: the rep is B held under `holdMs` for `holdBars`; after `giveUpBars` the round is a miss.
 * - `tempo-ear`: the rep is the round's first tempo move (the right way?), then its Ready (R): tempos
 *   within `matchBpm`? After `giveUpBars` the round starts again.
 */
export type PracticeDrill =
  | {
      readonly kind: "hold";
      readonly offsetsBeats: readonly number[];
      readonly apartPercents: readonly number[];
      readonly holdMs: number;
      readonly holdBars: number;
      readonly giveUpBars: number;
      readonly revealMs: number;
    }
  | {
      readonly kind: "tempo-ear";
      readonly apartPercents: readonly number[];
      readonly matchBpm: number;
      readonly giveUpBars: number;
      readonly revealMs: number;
    };

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
  /** Beat FX at the start (echo-out: ECHO on CH 1, off). */
  readonly beatFx?: Partial<BeatFxSnapshot>;
  /**
   * hot-cues: deck A waits paused at each of these track positions in turn; once a hot cue is set there,
   * Ready moves on. After the last, deck A is cued to `startPos` and plays (`autoPlay`).
   */
  readonly stops?: readonly number[];
  /** Listening clips played while a question is asked, by question id (tempo-fader). */
  readonly clips?: Readonly<Record<string, ListeningClip>>;
  /** When the audio part ends by itself. */
  readonly endWhen: CheckEnd;
  /** Hard stop for the audio part, seconds after the Check starts. */
  readonly timeoutSec: number;
  /** Live caption per stretch of the attempt, by track position (e.g. "every beat" → "only the 1"). */
  readonly cues: readonly PositionCue[];
  /** Live caption by the number of Ready presses so far (overrides `cues` until every one is used, or always without `cues`). */
  readonly readyCues?: readonly string[];
  /**
   * Live captions for steps the Learner takes in order, once the first is done (position cues no
   * longer fit a deck that loops or jumps): each caption shows after its `after` happened.
   */
  readonly stepCues?: readonly { readonly after: HookTrigger; readonly caption: string }[];
  /**
   * A tap at or after `fromPos` this many beats or more from every phrase start shows `caption` for
   * `bars` bars (phrases: "count from the last change"). It says nothing about where the phrase is.
   */
  /**
   * Once the audio part is over, a question with `previews: "phrases"` lets the Learner play the first
   * `bars` bars of phrase N (`starts[N − 1]`, track positions) on deck A before answering. Not graded.
   */
  readonly phrasePreviews?: { readonly starts: readonly number[]; readonly bars: number };
  readonly farTapCue?: { readonly fromPos: number; readonly beats: number; readonly bars: number; readonly caption: string };
}

export interface CheckQuestion {
  readonly id: string;
  readonly caption: string;
  /** Answers are 1…options. */
  readonly options: number;
  /** Each answer is a "Phrase N" chip with ▶ to hear the plan's `phrasePreviews` first (phrases). */
  readonly previews?: "phrases";
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
  /** Counts down to a change of task: drawn large, so it is seen without reading. */
  readonly countdown?: true;
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
  /**
   * The hook and practice show a live 8-bar count on deck A ("bar 3 of 8"), fading out once the
   * Learner taps phrases right by ear (phrase-count.ts). Never in the Check.
   */
  readonly phraseCount?: true;
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
   * Controls drawn but locked in this Lesson whatever earlier Lessons unlocked: SYNC locked off, the BPM
   * display and phase meter covered (catalogue §1, Q5). A drill shows them between rounds.
   */
  readonly locks?: readonly ControlId[];
  /** By-ear practice (Lessons 14–16): rounds run live by the app; see `PracticeDrill`. */
  readonly drill?: PracticeDrill;
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
