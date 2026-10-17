// The eight Placement tasks as data (docs/placement-design.md §4.1): each is its Lesson's Check in short
// form, graded by the same runCheck, with one caption line, no Lesson text, and a setup that makes the
// Learner use every skill the task credits. They are LessonDefinitions with no hook and no practice, so
// the Lesson session runs them; the attempt starts with the music (the first 8 bars are the hook).
import type { Aids, LessonId, LessonTask } from "@shared/attempt.ts";
import { lessonById } from "@shared/catalogue.ts";
import { LESSONS, type Grading } from "./catalogue.ts";
import { heardSpan, steadyPhrase } from "./plan.ts";
import { ancestorsOf, type PlacementTaskId } from "./placement.ts";
import { barStart, beatSec, heardTimeOf, cuedAt, phraseOf, phraseStart, trimKnobFor } from "./track.ts";
import type { CheckPlan, ControlId, DeckSetups, LessonDefinition, LessonTrack } from "./types.ts";

const BARS_PER_PHRASE = 8;
/** The hook: the first phrase start a task needs is at least this many bars into the attempt (§4.2). */
const HOOK_BARS = 8;
/** Bars recorded after A's fader closes: `loud-steady` reads up to `t_out + 4 bars`. */
const AFTER_OUT_BARS = 4;
/** B's tempo against A's (§4.1): 0.5–2% for blend-by-ear, 1–3% for bass-swap, ≤ 3% for sync-blend. */
const BY_EAR_TEMPO_PERCENT = 1.2;
const BASS_SWAP_TEMPO_PERCENT = 2;
const SYNC_BLEND_TEMPO_PERCENT = 1.5;
/** nudge-phase: B starts this far ahead of A (the Lesson: up to ¼ beat). */
const NUDGE_OFFSET_BEATS = 0.2;
/** nudge-phase: bars of listening before phase grading starts, then converge (≤ 4) and hold (4). */
const NUDGE_LEAD_BARS = 4;
const NUDGE_BARS = NUDGE_LEAD_BARS + 4 + 4 + 1;
/** cut-on-phrase: B waits this many beats before a downbeat with no cue point, and 6 dB low. */
const CUT_B_LEAD_BEATS = 1.37;
const CUT_B_TRIM_DB = -6;
const CUT_LEAD_BARS = 16;
const CUT_TAIL_BARS = 5;
/** beats-and-bars: a 4-bar count-in, then 4 bars of every beat and 4 of only the 1. */
const COUNT_IN_BARS = 4;
const CUE_SLICE_LEAD_BEATS = 1.37;
const CUE_SLICE_BARS = 6;
/** Slack on top of a task's planned length before it times out: a busy device can start the audio seconds late, and a tight timeout would end the attempt before its last section is heard (void). */
const TIMEOUT_SLACK_SEC = 15;

const barsSec = (track: LessonTrack, bars: number) => bars * 4 * beatSec(track.grid);
const steadyBar = (track: LessonTrack) => (steadyPhrase(track) - 1) * BARS_PER_PHRASE + 1;
/** The phrase a blend or a cut comes in on: the one after the steady phrase. */
const entryPhrase = (track: LessonTrack) => steadyPhrase(track) + 1;
const tooShort = (track: LessonTrack) => (track.phraseStarts.length < 6 ? ["The track is too short for a Placement task (6 phrases)."] : []);

const AIDS_OFF: Aids = { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: false };
const placementGrading = (aids: Partial<Aids>): Grading => ({ mode: "placement", variant: "short", aids: { ...AIDS_OFF, ...aids } });

/** Controls of the Lessons that are not built as Lessons yet (catalogue §1 "Controls unlocked"). */
const UNBUILT_CONTROLS: Readonly<Partial<Record<LessonId, readonly ControlId[]>>> = {
  "tempo-fader": ["A.tempo", "B.tempo", "A.tempo-range", "B.tempo-range", "A.master-tempo", "B.master-tempo", "A.shift", "B.shift", "A.bpm", "B.bpm"],
  "sync-blend": ["A.sync", "B.sync"],
  "eq-basics": ["A.eq-high", "A.eq-mid", "A.eq-low", "B.eq-high", "B.eq-mid", "B.eq-low"],
  "nudge-phase": ["A.jog-bend", "B.jog-bend", "phase-meter"],
};

function controlsOf(lessonId: LessonId): readonly ControlId[] {
  return LESSONS.find((lesson) => lesson.id === lessonId)?.unlocks ?? UNBUILT_CONTROLS[lessonId] ?? [];
}

/** Aids drawn as controls: locked aids stay on the controller, greyed (§4.1). */
const AID_CONTROLS: Readonly<Partial<Record<keyof Aids, readonly ControlId[]>>> = {
  sync: ["A.sync", "B.sync"],
  bpmDisplay: ["A.bpm", "B.bpm"],
  phaseMeter: ["phase-meter"],
};

/**
 * Exactly the union of catalogue §1's "Controls unlocked" over the task's Lesson and its ancestors,
 * minus aids the task locks off.
 */
export function placementControls(lessonId: LessonId, aids: Aids): ControlId[] {
  const locked = new Set((Object.keys(AID_CONTROLS) as (keyof Aids)[]).filter((aid) => !aids[aid]).flatMap((aid) => AID_CONTROLS[aid] ?? []));
  const all = [...ancestorsOf(lessonId), lessonId].flatMap(controlsOf);
  return [...new Set(all)].filter((control) => !locked.has(control));
}

export interface PlacementTaskDefinition extends LessonDefinition {
  readonly id: PlacementTaskId;
  /** The one caption line (≤ 9 words), the only text the task shows. */
  readonly caption: string;
  /** The result card's line on a pass. */
  readonly passLine: string;
  readonly grading: Grading;
  /** Every control drawn live (§4.1). */
  readonly controls: readonly ControlId[];
}

type TaskContent = Omit<PlacementTaskDefinition, "title" | "unlocks" | "practiceStart" | "hook" | "practice" | "checkCaption" | "tips" | "controls" | "questions"> &
  Partial<Pick<PlacementTaskDefinition, "questions">>;

function task(content: TaskContent): PlacementTaskDefinition {
  const controls = placementControls(content.id, content.grading.aids);
  return {
    title: lessonById(content.id).title,
    unlocks: controls,
    controls,
    questions: [],
    practiceStart: (track) => content.planCheck(track).startPos,
    hook: [],
    // Placement has no practice; the session reads `rep` only for practice Ready presses.
    practice: { caption: content.caption, rep: "cut", window: 1, needed: 1 },
    checkCaption: content.caption,
    tips: {},
    ...content,
  };
}

/** A runs from 8 bars before the entry phrase; B waits cued at `bPos`, its tempo `tempoPercent` off. */
function blendDecks(track: LessonTrack, bPos: number, tempoPercent: number): DeckSetups {
  return {
    A: { pos: phraseStart(track.grid, entryPhrase(track)) - barsSec(track, HOOK_BARS), fader: 1, play: true, trim: 0, headphoneCue: false, tempoPercent: 0 },
    B: { pos: bPos, fader: 0, play: false, trim: 0, headphoneCue: false, cuePoint: true, tempoPercent },
  };
}

/** A blend task's plan: ends 4 bars after A's fader closes, or after `maxBars`. */
function blendPlan(track: LessonTrack, decks: DeckSetups, maxBars: number, caption: string): CheckPlan {
  return {
    startPos: decks.A.pos,
    autoPlay: true,
    faderAtStart: decks.A.fader,
    deckA: { trim: 0, headphoneCue: false },
    ...(decks.B === undefined ? {} : { deckB: decks.B }),
    endWhen: { kind: "faded-out-then", deck: "A", bars: AFTER_OUT_BARS },
    timeoutSec: barsSec(track, maxBars),
    cues: [{ fromPos: decks.A.pos, caption }],
  };
}

const blendByEarDecks = (track: LessonTrack) => blendDecks(track, barStart(track.grid, 1), BY_EAR_TEMPO_PERCENT);
const BLEND_BY_EAR_CAPTION = "B's off. Match by ear, blend on a phrase.";

const blendByEar = task({
  id: "blend-by-ear",
  caption: BLEND_BY_EAR_CAPTION,
  passLine: "You've got blends by ear",
  grading: placementGrading({}),
  headphones: true,
  trackProblems: tooShort,
  practiceDecks: blendByEarDecks,
  planCheck: (track) => blendPlan(track, blendByEarDecks(track), HOOK_BARS + 8 + 16 + AFTER_OUT_BARS, BLEND_BY_EAR_CAPTION),
  taskFor: (): LessonTask => ({ lessonId: "blend-by-ear" }),
});

const bassSwapDecks = (track: LessonTrack) => blendDecks(track, phraseStart(track.grid, steadyPhrase(track)), BASS_SWAP_TEMPO_PERCENT);
const BASS_SWAP_CAPTION = "Sync B, blend in, swap bass on a phrase.";

const bassSwap = task({
  id: "bass-swap",
  caption: BASS_SWAP_CAPTION,
  passLine: "You've got bass swaps",
  grading: placementGrading({ sync: true, bpmDisplay: true }),
  headphones: true,
  trackProblems: tooShort,
  practiceDecks: bassSwapDecks,
  planCheck: (track) => blendPlan(track, bassSwapDecks(track), HOOK_BARS + 16 + AFTER_OUT_BARS + 2, BASS_SWAP_CAPTION),
  taskFor: (): LessonTask => ({ lessonId: "bass-swap" }),
});

const syncBlendDecks = (track: LessonTrack) => blendDecks(track, phraseStart(track.grid, steadyPhrase(track)), SYNC_BLEND_TEMPO_PERCENT);
const SYNC_BLEND_CAPTION = "Sync B, blend it in over 8 bars.";

const syncBlend = task({
  id: "sync-blend",
  caption: SYNC_BLEND_CAPTION,
  passLine: "You've got sync blends",
  grading: placementGrading({ sync: true, bpmDisplay: true }),
  headphones: true,
  trackProblems: tooShort,
  practiceDecks: syncBlendDecks,
  planCheck: (track) => blendPlan(track, syncBlendDecks(track), HOOK_BARS + 12 + AFTER_OUT_BARS, SYNC_BLEND_CAPTION),
  taskFor: (): LessonTask => ({ lessonId: "sync-blend" }),
});

/** A 16 bars before the entry phrase; B paused off the beat, with no cue point, and 6 dB low. */
function cutDecks(track: LessonTrack): DeckSetups {
  const cutPos = phraseStart(track.grid, entryPhrase(track));
  return {
    A: { pos: Math.max(0, cutPos - barsSec(track, CUT_LEAD_BARS)), fader: 1, play: true, trim: 0, headphoneCue: false },
    B: { pos: phraseStart(track.grid, steadyPhrase(track)) - CUT_B_LEAD_BEATS * beatSec(track.grid), fader: 0, play: false, trim: trimKnobFor(CUT_B_TRIM_DB), headphoneCue: false },
  };
}
const CUT_CAPTION = "Cue B by ear, then cut on the phrase.";

const cutOnPhrase = task({
  id: "cut-on-phrase",
  caption: CUT_CAPTION,
  passLine: "You've got cuts on the phrase",
  grading: placementGrading({}),
  headphones: true,
  trackProblems: tooShort,
  practiceDecks: cutDecks,
  planCheck: (track) => {
    const decks = cutDecks(track);
    const cutPos = phraseStart(track.grid, entryPhrase(track));
    const lengthSec = cutPos - decks.A.pos + barsSec(track, CUT_TAIL_BARS);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { trim: 0, headphoneCue: false },
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      endWhen: { kind: "after", sec: lengthSec },
      timeoutSec: lengthSec + TIMEOUT_SLACK_SEC,
      cues: [
        { fromPos: decks.A.pos, caption: CUT_CAPTION },
        { fromPos: cutPos + beatSec(track.grid), caption: "Let it ride" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "cut-on-phrase" }),
});

/** The first phrase ≥ 2 whose next three phrases hold the drop: the 32 bars the phrases task plays. */
function phraseTaskWindow(track: LessonTrack): { first: number; breakdown: number; drop: number } | null {
  for (let first = 2; first + 4 <= track.phraseStarts.length; first += 1) {
    const drop = phraseOf(track.sections, "drop", first + 1);
    if (drop !== null && drop <= first + 3) return { first, breakdown: phraseOf(track.sections, "breakdown", first) ?? 0, drop };
  }
  return null;
}
const PHRASES_CAPTION = "Tap the first beat of every phrase.";

const phrases = task({
  id: "phrases",
  caption: PHRASES_CAPTION,
  passLine: "You've got phrases",
  grading: placementGrading({}),
  trackProblems: (track) => (phraseTaskWindow(track) === null ? ["The track needs a named drop within 4 phrases."] : []),
  questions: [{ id: "drop", caption: "Which one was the drop?", options: 4 }],
  planCheck: (track): CheckPlan => {
    const first = phraseTaskWindow(track)?.first ?? 2;
    return {
      startPos: phraseStart(track.grid, first),
      autoPlay: true,
      faderAtStart: 1,
      endWhen: { kind: "position", pos: phraseStart(track.grid, first + 4) + beatSec(track.grid) },
      timeoutSec: barsSec(track, 4 * BARS_PER_PHRASE) + TIMEOUT_SLACK_SEC,
      cues: [{ fromPos: phraseStart(track.grid, first), caption: "Tap the first beat of every phrase (Space)" }],
    };
  },
  taskFor: (track, plan, attempt, window): LessonTask => {
    const found = phraseTaskWindow(track) ?? { first: 2, breakdown: 0, drop: 0 };
    return {
      lessonId: "phrases",
      // The phrase the music starts on cannot be tapped: the next three phrase starts are the targets.
      tapSection: heardSpan(track, plan, attempt, window, phraseStart(track.grid, found.first + 1), phraseStart(track.grid, found.first + 4)),
      sections: { breakdown: found.breakdown - found.first + 1, drop: found.drop - found.first + 1 },
    };
  },
});

const nudgeDecks = (track: LessonTrack): DeckSetups => {
  const pos = phraseStart(track.grid, steadyPhrase(track));
  return { A: { pos, fader: 1, play: true, tempoPercent: 0 }, B: { pos: pos + NUDGE_OFFSET_BEATS * beatSec(track.grid), fader: 1, play: true, tempoPercent: 0 } };
};
const NUDGE_CAPTION = "B's drifting. Nudge it back with the jog.";

const nudgePhase = task({
  id: "nudge-phase",
  caption: NUDGE_CAPTION,
  passLine: "You've got nudging",
  grading: placementGrading({ bpmDisplay: true, phaseMeter: true }),
  trackProblems: tooShort,
  practiceDecks: nudgeDecks,
  planCheck: (track) => {
    const decks = nudgeDecks(track);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      endWhen: { kind: "after", sec: barsSec(track, NUDGE_BARS) },
      timeoutSec: barsSec(track, NUDGE_BARS) + TIMEOUT_SLACK_SEC,
      cues: [{ fromPos: decks.A.pos, caption: NUDGE_CAPTION }],
    };
  },
  taskFor: (track, plan, attempt, window): LessonTask => {
    // Phase grading starts once B has played 4 bars: listening first is not a slow convergence.
    const playhead = attempt.decks.B?.playhead;
    const bPos = plan.deckB?.pos ?? plan.startPos;
    const cued = playhead === undefined ? null : cuedAt(playhead, bPos, window.from);
    const from = playhead === undefined || cued === null ? null : heardTimeOf(playhead, bPos + barsSec(track, NUDGE_LEAD_BARS), cued);
    return { lessonId: "nudge-phase", phaseFrom: from ?? window.from };
  },
});

const CUE_CAPTION = "Cue on a 1 by ear, then R";

const cuePoint = task({
  id: "cue-point",
  caption: CUE_CAPTION,
  passLine: "You've got cue points",
  grading: placementGrading({}),
  headphones: true,
  trackProblems: tooShort,
  practiceDecks: (track) => ({ A: { pos: barStart(track.grid, steadyBar(track)) - CUE_SLICE_LEAD_BEATS * beatSec(track.grid), fader: 1, play: false, headphoneCue: true } }),
  planCheck: (track) => ({
    startPos: 0,
    autoPlay: false,
    faderAtStart: 1,
    deckA: { headphoneCue: true },
    slices: [{ fromSec: barStart(track.grid, steadyBar(track)) - CUE_SLICE_LEAD_BEATS * beatSec(track.grid), lengthSec: barsSec(track, CUE_SLICE_BARS) }],
    endWhen: { kind: "slices-done" },
    timeoutSec: 45,
    cues: [],
    readyCues: [CUE_CAPTION],
  }),
  taskFor: (): LessonTask => ({ lessonId: "cue-point" }),
  taskTracks: (track, plan, trackSetId) => (plan.slices ?? []).map((_, index) => ({ trackId: `${track.trackId}#cue-${String(index + 1)}`, trackSetId, deck: "A" as const })),
});

const BEATS_CAPTION = "Tap every beat. Now only the one.";
const beatsBar = (track: LessonTrack) => steadyBar(track) + COUNT_IN_BARS;

const beatsAndBars = task({
  id: "beats-and-bars",
  caption: BEATS_CAPTION,
  passLine: "You've got the beat",
  grading: placementGrading({}),
  trackProblems: tooShort,
  planCheck: (track) => {
    const bar = beatsBar(track);
    const half = beatSec(track.grid) / 2;
    return {
      startPos: barStart(track.grid, bar - COUNT_IN_BARS),
      autoPlay: true,
      faderAtStart: 1,
      endWhen: { kind: "position", pos: barStart(track.grid, bar + 8) + beatSec(track.grid) },
      timeoutSec: barsSec(track, COUNT_IN_BARS + 8) + TIMEOUT_SLACK_SEC,
      cues: [
        { fromPos: barStart(track.grid, bar - COUNT_IN_BARS), caption: "Tap every beat (Space)" },
        { fromPos: barStart(track.grid, bar + 4) - half, caption: "Now only the 1" },
      ],
    };
  },
  taskFor: (track, plan, attempt, window): LessonTask => {
    const bar = beatsBar(track);
    const at = (n: number) => barStart(track.grid, n);
    return {
      lessonId: "beats-and-bars",
      beatSection: heardSpan(track, plan, attempt, window, at(bar), at(bar + 4)),
      downbeatSection: heardSpan(track, plan, attempt, window, at(bar + 4), at(bar + 8)),
    };
  },
});

const TASKS: Readonly<Record<PlacementTaskId, PlacementTaskDefinition>> = {
  "blend-by-ear": blendByEar,
  "bass-swap": bassSwap,
  "cut-on-phrase": cutOnPhrase,
  phrases,
  "nudge-phase": nudgePhase,
  "sync-blend": syncBlend,
  "cue-point": cuePoint,
  "beats-and-bars": beatsAndBars,
};

export function placementTask(id: PlacementTaskId): PlacementTaskDefinition {
  return TASKS[id];
}

/** Every reason a track cannot carry all eight tasks (Placement loads one track for the whole run). */
export function placementTrackProblems(track: LessonTrack): string[] {
  return [...new Set(Object.values(TASKS).flatMap((definition) => definition.trackProblems(track)))];
}
