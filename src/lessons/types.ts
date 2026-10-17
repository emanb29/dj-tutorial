// The shape of a Lesson as data: what the Learner touches first (the hook), how they practise, and
// how the Check is set up on the chosen track. Pure data plus pure builders; no audio, no React.
import type { Attempt, BeatGrid, CtxSpan, LessonId, LessonTask } from "@shared/attempt.ts";
import type { CriterionId } from "@shared/check-result.ts";
import type { ControlId } from "@app/controller/control-ids.ts";

/** A part of the virtual controller (src/app/controller): `A.play`, `B.channel-fader`, `tap`, … */
export type { ControlId } from "@app/controller/control-ids.ts";

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
}

export interface TrackSection {
  readonly name: string;
  /** 1-based number of the 8-bar phrase (from bar 1) the section starts on. */
  readonly phrase: number;
}

/** Something the Learner did, as the Lesson sees it. Built by the app from engine events. */
export type Observation =
  | { readonly kind: "play"; readonly playing: boolean }
  | { readonly kind: "fader"; readonly value: number }
  /** A tap, placed on the playing track's grid. */
  | {
      readonly kind: "tap";
      /** Signed distance to the nearest beat, ms (negative = early). */
      readonly offsetMs: number;
      readonly onBeat: boolean;
      readonly onDownbeat: boolean;
      /** Within 1 beat of an 8-bar phrase start. */
      readonly onPhraseStart: boolean;
    };

/** What a hook step waits for. */
export type HookTrigger =
  | { readonly kind: "play" }
  | { readonly kind: "fader-up" }
  | { readonly kind: "fader-down" }
  | { readonly kind: "beat-taps"; readonly count: number }
  | { readonly kind: "downbeat-taps"; readonly count: number }
  | { readonly kind: "phrase-taps"; readonly count: number };

export interface HookStep {
  /** What to do, a few words with the key: "Press X". */
  readonly caption: string;
  /** The control to touch. It unlocks (and pulses) when this step begins. */
  readonly control: ControlId;
  readonly trigger: HookTrigger;
  /** The concept, named after the Learner has done it: "That's the channel fader." */
  readonly named: string;
}

/** Practice reps feed a rolling window; the Learner is "consistent" once enough recent reps were good. */
export interface PracticeConfig {
  readonly caption: string;
  /** What counts as one rep. */
  readonly rep: "fade" | "beat-tap" | "phrase-tap";
  readonly window: number;
  readonly needed: number;
}

/** How the app sets the deck up for the Check and when the audio part ends. */
export interface CheckPlan {
  /** Track seconds the deck is cued to before the Check starts (auto-jump: no dead waiting). */
  readonly startPos: number;
  /** The app presses Play itself when the Check starts (tap Lessons), or the Learner does (deck-basics). */
  readonly autoPlay: boolean;
  /** The channel fader at the start. */
  readonly faderAtStart: number;
  /** When the audio part ends by itself. */
  readonly endWhen: { readonly kind: "faded-out" } | { readonly kind: "position"; readonly pos: number };
  /** Hard stop for the audio part, seconds after the Check starts. */
  readonly timeoutSec: number;
  /** Live caption per stretch of the attempt, by track position (e.g. "every beat" → "only the 1"). */
  readonly cues: readonly PositionCue[];
}

export interface CheckQuestion {
  readonly id: string;
  readonly caption: string;
  /** Answers are 1…options. */
  readonly options: number;
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
  /** Can this Lesson run on this track (e.g. phrases needs a named breakdown and drop)? */
  readonly trackProblems: (track: LessonTrack) => readonly string[];
  readonly hook: readonly HookStep[];
  readonly practice: PracticeConfig;
  /** The one line before the Check. */
  readonly checkCaption: string;
  /** Questions asked after the audio part of the Check (phrases); answers go into the attempt. */
  readonly questions: readonly CheckQuestion[];
  readonly planCheck: (track: LessonTrack) => CheckPlan;
  /**
   * The task the Check grades, from the plan and what was recorded. Pure. A recorded playhead model
   * holds the track's whole history since it was loaded (hook, practice, earlier attempts): look for
   * this attempt's moments within `window` only.
   */
  readonly taskFor: (track: LessonTrack, plan: CheckPlan, attempt: Attempt, window: CtxSpan) => LessonTask;
  /** Authored tips per criterion (coach-design §1 c), rotated. */
  readonly tips: Readonly<Partial<Record<CriterionId, readonly string[]>>>;
}
