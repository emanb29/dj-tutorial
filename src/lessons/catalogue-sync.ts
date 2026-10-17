// Lessons 8–11 as data (docs/lesson-catalogue.md §1, check-design §4): the tempo fader and Master
// Tempo, the first blend with SYNC, the crossfader, and EQ. Captions, not prose: a few words, the key
// in brackets. sync-blend and crossfader mix two tracks (`partner`); the others use one.
import type { CheckQuestion, CheckPlan, DeckSetups, LessonDefinition, LessonTrack, ListeningClip, LoopPlan } from "./types.ts";
import type { LessonTask } from "@shared/attempt.ts";
import { barsSec, fromOwnCue, fullGroovePhrase, heardSpan, steadyPhrase, steadyRun } from "./plan.ts";
import { beatSec, phraseStart, trackOnDeck } from "./track.ts";

const tooShort = (track: LessonTrack) => (track.phraseStarts.length < 6 ? ["The track is too short for this Lesson's 40 bars."] : []);

// ---------------------------------------------------------------------------------------------
// Lesson 8: tempo-fader
// ---------------------------------------------------------------------------------------------

/** The Check's three target BPMs, as offsets from the track's own BPM (inside the ±6% range). */
const TARGET_OFFSETS_BPM = [3, -2.5, 1.5] as const;
const PRACTICE_OFFSET_BPM = 2;
/** Master Tempo clips: 2 bars at the track's tempo, then 2 bars 8% faster (half of the ±16% range). */
const CLIP_LEAD_BARS = 2;
const CLIP_FAST_BARS = 2;
const CLIP_TEMPO = 0.5;
const CLIP_RANGE = 16;
/** Which clip has Master Tempo on, by attempt, so the answers cannot be learnt by position. */
const CLIP_PATTERNS: readonly (readonly [boolean, boolean])[] = [
  [true, false],
  [false, false],
  [false, true],
  [true, true],
];
const ON_OFF: CheckQuestion["choices"] = [
  { label: "On", value: 1 },
  { label: "Off", value: 0 },
];
const CLIP_IDS = ["clip-1", "clip-2"] as const;

/** A BPM as the display shows it: one decimal. */
const bpmText = (bpm: number) => bpm.toFixed(1);
const roundBpm = (bpm: number) => Math.round(bpm * 10) / 10;

export function tempoTargets(track: LessonTrack): number[] {
  return TARGET_OFFSETS_BPM.map((offset) => roundBpm(track.grid.bpm + offset));
}

function tempoDecks(track: LessonTrack): DeckSetups {
  const pos = phraseStart(track.grid, steadyPhrase(track));
  return {
    A: { pos, fader: 0, play: false },
    B: { pos, fader: 1, play: true, sync: false, tempoRange: 6, tempoPercent: 0, masterTempo: false },
  };
}

/** B loops one steady 16 bars, whatever its tempo: the loop follows B's own position. */
const tempoLoop = (track: LessonTrack): LoopPlan => ({ deck: "B", atPos: phraseStart(track.grid, steadyPhrase(track) + 2), reset: "positions" });

const tempoFader: LessonDefinition = {
  id: "tempo-fader",
  title: "Speed and pitch",
  unlocks: ["B.tempo", "B.bpm", "B.master-tempo", "B.tempo-range", "B.shift", "A.tempo", "A.bpm", "A.master-tempo", "A.tempo-range", "A.shift"],
  practiceStart: (track) => tempoDecks(track).A.pos,
  practiceDecks: tempoDecks,
  practiceLoop: tempoLoop,
  masterTempo: true,
  aids: { bpmDisplay: true },
  gradeFromOwnCue: true,
  trackProblems: tooShort,
  hook: [
    { caption: "Slide TEMPO B", control: "B.tempo", trigger: { kind: "touch", control: "B.tempo" }, named: "TEMPO: faster or slower. The BPM shows it.", reveals: ["B.bpm"] },
    { caption: "Press MASTER TEMPO B", control: "B.master-tempo", trigger: { kind: "touch", control: "B.master-tempo" }, named: "MASTER TEMPO on: new speed, same pitch." },
    { caption: "Tap ±6% on B: the range", control: "B.tempo-range", trigger: { kind: "touch", control: "B.tempo-range" }, named: "Range: ±6% is fine, ±16% is wide." },
  ],
  practice: { caption: "Set B to the BPM, then R", rep: "tempo-set", window: 3, needed: 2 },
  practiceTargetBpm: (track) => roundBpm(track.grid.bpm + PRACTICE_OFFSET_BPM),
  practiceCaptionFor: (track) => `Set B to ${bpmText(roundBpm(track.grid.bpm + PRACTICE_OFFSET_BPM))} BPM, then R`,
  checkCaption: "This one counts: three BPMs, then two clips",
  questions: CLIP_IDS.map((id, index) => ({ id, caption: `Clip ${String(index + 1)}: Master Tempo on or off?`, options: 2, choices: ON_OFF })),
  planCheck: (track, attempt = 1): CheckPlan => {
    const decks = tempoDecks(track);
    const [first, second, third] = tempoTargets(track).map(bpmText);
    const pattern = CLIP_PATTERNS[(attempt - 1) % CLIP_PATTERNS.length] ?? CLIP_PATTERNS[0] ?? [true, false];
    const clip = (masterTempo: boolean): ListeningClip => ({
      deck: "B",
      pos: decks.A.pos,
      leadBars: CLIP_LEAD_BARS,
      bars: CLIP_FAST_BARS,
      tempo: CLIP_TEMPO,
      rangePercent: CLIP_RANGE,
      masterTempo,
    });
    return {
      startPos: decks.A.pos,
      autoPlay: false,
      faderAtStart: 0,
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      loop: tempoLoop(track),
      endWhen: { kind: "readies", deck: "B", count: TARGET_OFFSETS_BPM.length },
      timeoutSec: 90,
      cues: [],
      readyCues: [`Set B to ${first ?? ""} BPM, then R`, `Now ${second ?? ""} BPM, then R`, `Last one: ${third ?? ""} BPM, then R`, "Now listen: two clips"],
      clips: { [CLIP_IDS[0]]: clip(pattern[0]), [CLIP_IDS[1]]: clip(pattern[1]) },
    };
  },
  taskFor: (track, plan): LessonTask => ({
    lessonId: "tempo-fader",
    targetsBpm: tempoTargets(track),
    masterTempoClips: CLIP_IDS.map((id) => ({ answerKey: id, masterTempoOn: plan.clips?.[id]?.masterTempo ?? false })),
  }),
  tips: {
    "tempo-fader.set-bpm": ["Watch B's BPM; stop when it reads the target.", "Close? Fine-tune: hold Shift as you drag, or slide your finger out to the side."],
    "tempo-fader.master-tempo-ear": ["Off: faster and higher. On: faster, same note.", "Listen to the bass note when the tempo jumps."],
  },
};

// ---------------------------------------------------------------------------------------------
// Two-track Lessons: sync-blend (9) and crossfader (10)
// ---------------------------------------------------------------------------------------------

/** "Tempos ≤3% apart" (catalogue §1), and at least 0.5% apart so SYNC has something to do. */
export const PAIR_MAX_APART = 0.03;
export const PAIR_MIN_APART = 0.005;

export function pairProblems(track: LessonTrack, partner: LessonTrack): string[] {
  const apart = Math.abs(partner.grid.bpm - track.grid.bpm) / track.grid.bpm;
  return [
    partner.trackId === track.trackId ? "The partner is the same track." : null,
    apart > PAIR_MAX_APART ? `The tempos are ${(apart * 100).toFixed(1)}% apart; the Lesson needs 3% or less.` : null,
    apart < PAIR_MIN_APART ? "The tempos are the same: SYNC would have nothing to do." : null,
    ...[...tooShort(partner), ...noSteadyRun(partner)].map((problem) => `Deck B: ${problem}`),
  ].filter((problem) => problem !== null);
}

/** Bars of A before the blend starts (the loudness reference needs 4 clear of the Check's start). */
const BLEND_LEAD_BARS = 6;
const BLEND_MAX_BARS = 16;
/** sync-blend ends this long after A's fader closes (the loudness span runs 4 bars past A's exit). */
const BLEND_TAIL_BARS = 2;
/**
 * The blend length the cues ask for. The Check measures 7¾–16¼ bars on what is heard, and a fader
 * or crossfader is inaudible for its last stretch of travel at each end, so a move over exactly 8 bars
 * measures short of 8; asking for 10 leaves room on both sides.
 */
const BLEND_ASKED_BARS = 10;

/** Phrases of groove the two-track Lessons need from the blend's start: the blend, and the cut after it. */
const STEADY_PHRASES = 3;

/**
 * A's phrase the blend starts on, and B's cue, each the start of 3 phrases of groove (no breakdown or
 * build), so the loudness stays comparable through the blend and the cut back.
 */
function blendPositions(track: LessonTrack): { blendPos: number; leadPos: number; cueB: number } {
  const partner = trackOnDeck(track, "B");
  const blendPos = phraseStart(track.grid, steadyRun(track, STEADY_PHRASES) ?? steadyPhrase(track));
  return { blendPos, leadPos: blendPos - barsSec(track, BLEND_LEAD_BARS), cueB: phraseStart(partner.grid, steadyRun(partner, STEADY_PHRASES) ?? steadyPhrase(partner)) };
}

const noSteadyRun = (track: LessonTrack) =>
  steadyRun(track, STEADY_PHRASES) === null ? ["The track needs 3 phrases in a row without a breakdown."] : [];

/** SYNC off and the tempo fader centred, unless practice is going round again (`again`): then they are left as the Learner set them. */
const tempoReset = (again: boolean) => (again ? {} : { sync: false, tempoPercent: 0 });

function syncDecks(track: LessonTrack, again = false): DeckSetups {
  const { leadPos, cueB } = blendPositions(track);
  return {
    A: { pos: leadPos, fader: 1, play: true, trim: 0, ...tempoReset(again) },
    B: { pos: cueB, fader: 0, play: false, trim: 0, cuePoint: true, ...tempoReset(again) },
  };
}

const syncBlend: LessonDefinition = {
  id: "sync-blend",
  title: "Blend with sync",
  unlocks: ["A.sync", "B.sync"],
  practiceStart: (track) => syncDecks(track).A.pos,
  practiceDecks: syncDecks,
  practiceLoop: (track) => ({
    atPos: blendPositions(track).blendPos + barsSec(track, BLEND_MAX_BARS),
    reset: "setup",
    decks: syncDecks(track, true),
  }),
  partner: { problems: pairProblems },
  headphones: true,
  aids: { sync: true, bpmDisplay: true },
  gradeFromOwnCue: true,
  trackProblems: (track) => [...tooShort(track), ...noSteadyRun(track)],
  hook: [
    { caption: "Press BEAT SYNC on B", control: "B.sync", trigger: { kind: "sync-on", deck: "B" }, named: "SYNC: B now runs at A's tempo." },
    { caption: "On the phrase's 1: Press ,", control: "B.play", trigger: { kind: "play", deck: "B" }, named: "B starts in time with A. Fader down: only you know." },
    { caption: "Slide fader B up, then A down", control: "B.channel-fader", trigger: { kind: "fader-up", deck: "B" }, named: "That's a blend: both play, then B takes over." },
  ],
  practice: { caption: "Press , on the phrase's 1, then fader B up, A down", rep: "blend-start", window: 2, needed: 1 },
  checkCaption: `This one counts: SYNC B, Press , on the 1, blend over ${String(BLEND_ASKED_BARS)} bars`,
  questions: [],
  planCheck: (track) => {
    const decks = syncDecks(track);
    const { blendPos, leadPos } = blendPositions(track);
    const beat = beatSec(track.grid);
    return {
      startPos: leadPos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { trim: 0, headphoneCue: false, sync: false, tempoPercent: 0 },
      ...(decks.B === undefined ? {} : { deckB: { ...decks.B, headphoneCue: false } }),
      endWhen: { kind: "faded-out-then", deck: "A", bars: BLEND_TAIL_BARS },
      timeoutSec: barsSec(track, BLEND_LEAD_BARS + BLEND_MAX_BARS + 4) + 5,
      cues: [
        { fromPos: leadPos, caption: "SYNC B on, CUE 🎧 B on" },
        { fromPos: blendPos - barsSec(track, 2), caption: "Next phrase: Press , and slide B up" },
        { fromPos: blendPos + beat, caption: `Fader B up, A down: take ${String(BLEND_ASKED_BARS)} bars` },
        { fromPos: blendPos + barsSec(track, BLEND_ASKED_BARS), caption: "A all the way down" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "sync-blend" }),
  tips: {
    "sync-blend.blend-start": ["Press , on the 1 of the new phrase, then start fader B.", "Count A's 8 bars on the 1s; go on the next 1."],
    "sync-blend.blend-length": [`Take ${String(BLEND_ASKED_BARS)} bars: count them on the 1s.`, "Done by 16 bars: A all the way down."],
    "sync-blend.loud-steady": ["B up as A goes down: never both full.", "Cross in the middle: half B, half A."],
    "sync-blend.trim-untouched": ["Hands off TRIM mid-blend: the faders do it."],
  },
};

/** crossfader: the blend on A's phrase, the cut back to A 16 bars later, on the third phrase of groove. */
const XF_CUT_BARS = 16;
/** Between the blend (10 bars asked) and the cut: the blend is graded before this, the cut after. */
const XF_SPLIT_BARS = 14;
const XF_TAIL_BARS = 4;

function crossfaderDecks(track: LessonTrack, again = false): DeckSetups {
  const { leadPos, cueB } = blendPositions(track);
  return {
    A: { pos: leadPos, fader: 1, play: true, trim: 0, ...tempoReset(again) },
    // SYNC is on already: this Lesson is about the crossfader, not the tempo.
    B: { pos: cueB, fader: 1, play: false, trim: 0, cuePoint: true, ...(again ? {} : { sync: true }) },
    crossfader: 0,
  };
}

const crossfaderLesson: LessonDefinition = {
  id: "crossfader",
  title: "The crossfader",
  unlocks: ["crossfader"],
  practiceStart: (track) => crossfaderDecks(track).A.pos,
  practiceDecks: crossfaderDecks,
  practiceLoop: (track) => ({
    atPos: blendPositions(track).blendPos + barsSec(track, XF_CUT_BARS + XF_TAIL_BARS),
    reset: "setup",
    decks: crossfaderDecks(track, true),
  }),
  partner: { problems: pairProblems },
  headphones: true,
  aids: { sync: true, bpmDisplay: true },
  gradeFromOwnCue: true,
  trackProblems: (track) => [...tooShort(track), ...noSteadyRun(track)],
  hook: [
    { caption: "Press , to play B", control: "B.play", trigger: { kind: "play", deck: "B" }, named: "Both faders up, yet B is silent: the crossfader is on A.", reveals: ["crossfader"] },
    { caption: "Slide the crossfader to B", control: "crossfader", trigger: { kind: "crossfader-to", side: "B" }, named: "The crossfader: A to B in one move." },
    { caption: "Snap it back to A (C)", control: "crossfader", trigger: { kind: "crossfader-to", side: "A" }, named: "One quick snap: a cut with the crossfader." },
  ],
  practice: { caption: "Press , on the phrase's 1, crossfader to B; later C on a 1", rep: "blend-start", window: 2, needed: 1 },
  checkCaption: "This one counts: crossfader only. Blend to B, then cut back to A",
  questions: [],
  planCheck: (track) => {
    const decks = crossfaderDecks(track);
    const { blendPos, leadPos } = blendPositions(track);
    const cutPos = blendPos + barsSec(track, XF_CUT_BARS);
    const beat = beatSec(track.grid);
    return {
      startPos: leadPos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { trim: 0, headphoneCue: false, sync: false, tempoPercent: 0 },
      ...(decks.B === undefined ? {} : { deckB: { ...decks.B, headphoneCue: false } }),
      crossfader: 0,
      endWhen: { kind: "position", pos: cutPos + barsSec(track, XF_TAIL_BARS) + beat },
      timeoutSec: barsSec(track, BLEND_LEAD_BARS + XF_CUT_BARS + XF_TAIL_BARS) + 5,
      cues: [
        { fromPos: leadPos, caption: "Faders stay up. Crossfader on A" },
        { fromPos: blendPos - barsSec(track, 2), caption: "Next phrase: Press , and slide to B" },
        { fromPos: blendPos + beat, caption: `Crossfader to B, slow and steady: ${String(BLEND_ASKED_BARS)} bars` },
        { fromPos: blendPos + barsSec(track, BLEND_ASKED_BARS), caption: "Blend done. CUE 🎧 A on", checkpoint: true },
        { fromPos: blendPos + barsSec(track, 12), caption: "CUE 🎧 A on. Cut back to A on the phrase's 1 (C)" },
        { fromPos: cutPos + beat, caption: "Let it ride" },
      ],
    };
  },
  taskFor: (track, plan, attempt, window): LessonTask => {
    const own = fromOwnCue(plan, attempt, window);
    const { blendPos } = blendPositions(track);
    const split = heardSpan(track, plan, attempt, window, blendPos + barsSec(track, XF_SPLIT_BARS), blendPos + barsSec(track, XF_CUT_BARS + XF_TAIL_BARS));
    return {
      lessonId: "crossfader",
      blendSection: { from: own.from, to: split.from },
      cutSection: { span: { from: split.from, to: window.to }, incoming: "A" },
    };
  },
  tips: {
    "crossfader.xf-blend": ["Press , on the phrase's 1, then ease the crossfader toward B.", `Slow and steady: take ${String(BLEND_ASKED_BARS)} bars to reach B.`],
    "crossfader.xf-cut": ["CUE 🎧 A on early, then snap to A right on the 1 (C).", "Snap the crossfader to A on the phrase's 1 (C)."],
    "crossfader.faders-up": ["Leave both channel faders up: the crossfader does it all."],
  },
};

// ---------------------------------------------------------------------------------------------
// Lesson 11: eq-basics
// ---------------------------------------------------------------------------------------------

const EQ_LEAD_BARS = 2;
const EQ_TAIL_BARS = 2;

/** The phrase the LOW is cut on; it and the next have the kick and the bass. */
const eqPhrase = (track: LessonTrack) => fullGroovePhrase(track, 2) ?? steadyPhrase(track);

function eqDecks(track: LessonTrack): DeckSetups {
  return { A: { pos: phraseStart(track.grid, eqPhrase(track)) - barsSec(track, EQ_LEAD_BARS), fader: 1, play: true, trim: 0, eqCentred: true } };
}

const eqBasics: LessonDefinition = {
  id: "eq-basics",
  title: "Shape the sound with EQ",
  unlocks: ["A.eq-low", "A.eq-mid", "A.eq-high", "B.eq-low", "B.eq-mid", "B.eq-high"],
  practiceStart: (track) => eqDecks(track).A.pos,
  practiceDecks: eqDecks,
  practiceLoop: (track) => ({ atPos: phraseStart(track.grid, eqPhrase(track) + 2), reset: "positions" }),
  gradeFromOwnCue: true,
  trackProblems: (track) => [
    ...tooShort(track),
    ...(fullGroovePhrase(track, 2) === null ? ["The track needs two phrases in a row with the kick and the bass."] : []),
  ],
  hook: [
    { caption: "Turn LOW A all the way down", control: "A.eq-low", trigger: { kind: "eq-cut", deck: "A", band: "low" }, named: "LOW cut: the kick and the bass drop out." },
    {
      caption: "Turn LOW A back to the middle",
      control: "A.eq-low",
      trigger: { kind: "eq-centred", deck: "A", band: "low" },
      named: "Middle is untouched. HI and MID work the same way.",
      reveals: ["A.eq-mid", "A.eq-high"],
    },
  ],
  practice: { caption: "Cut LOW on a phrase's 1, back on the next 1", rep: "eq-return", window: 2, needed: 1 },
  checkCaption: "This one counts: cut LOW for a phrase, back on the 1",
  questions: [],
  planCheck: (track) => {
    const decks = eqDecks(track);
    const cutPos = phraseStart(track.grid, eqPhrase(track));
    const backPos = phraseStart(track.grid, eqPhrase(track) + 1);
    const beat = beatSec(track.grid);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { trim: 0, eqCentred: true },
      endWhen: { kind: "position", pos: backPos + barsSec(track, EQ_TAIL_BARS) + beat },
      timeoutSec: barsSec(track, EQ_LEAD_BARS + 8 + EQ_TAIL_BARS) + 5,
      cues: [
        { fromPos: decks.A.pos, caption: "Get ready: LOW A down on the 1" },
        { fromPos: cutPos - beat, caption: "LOW A down now" },
        { fromPos: cutPos + barsSec(track, 2), caption: "Hold it. LOW back on the next phrase's 1" },
        { fromPos: backPos - barsSec(track, 1), caption: "Next 1: LOW back to the middle" },
        { fromPos: backPos + beat, caption: "Every EQ in the middle" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "eq-basics" }),
  tips: {
    "eq-basics.low-kill": ["LOW all the way down, and hold it for the whole phrase.", "Cut on the 1, count 8 bars, then bring it back."],
    "eq-basics.low-return": ["Count 8 bars on the 1s; LOW back right on the next 1.", "Turn it back in one quick move, on the 1."],
    "eq-basics.eq-centred": ["Finish with HI, MID and LOW in the middle."],
  },
};

export type SyncLessonId = "tempo-fader" | "sync-blend" | "crossfader" | "eq-basics";

/** Lessons 8–11, in catalogue order. */
export const SYNC_LESSONS: readonly (LessonDefinition & { readonly id: SyncLessonId })[] = [
  { ...tempoFader, id: "tempo-fader" },
  { ...syncBlend, id: "sync-blend" },
  { ...crossfaderLesson, id: "crossfader" },
  { ...eqBasics, id: "eq-basics" },
];
