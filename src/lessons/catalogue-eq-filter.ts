// Lessons 12–13 as data (docs/lesson-catalogue.md §1, check-design §4): the bass swap and the filter
// transition, two blends that hand the groove from A to B with SYNC on. Both mix two house tracks
// (`partner`). Captions, not prose: a few words, the key in brackets.
import type { LessonTask } from "@shared/attempt.ts";
import { PAIR_MAX_APART, PAIR_MIN_APART } from "./catalogue-sync.ts";
import { barsSec, fullGroovePhrase, steadyPhrase } from "./plan.ts";
import { beatSec, phraseStart, trackOnDeck } from "./track.ts";
import type { CheckPlan, DeckSetups, LessonDefinition, LessonTrack } from "./types.ts";

/** Bars of A before B comes in: time to CUE B (and cut its LOW) before the phrase. */
const LEAD_BARS = 6;
/** The handover is a phrase after B comes in: the bass swap, or A out at the end of the filter sweep. */
const HANDOVER_BARS = 8;
/** The Check ends this long after A's fader closes: CFX and EQ are read back within 1 bar of A going silent. */
const TAIL_BARS = 2;

const tooShort = (track: LessonTrack) => (track.phraseStarts.length < 6 ? ["The track is too short for this Lesson's 40 bars."] : []);
const noGroove = (track: LessonTrack) =>
  fullGroovePhrase(track, 2) === null ? ["The track needs two phrases in a row with the kick and the bass."] : [];

/**
 * Deck B fits when its tempo is 0.5–3% from A's (SYNC has something to do; catalogue §1 "≤3% apart")
 * and it has two phrases of full groove: B's bass is heard from the handover on.
 */
export function eqPairProblems(track: LessonTrack, partner: LessonTrack): string[] {
  const apart = Math.abs(partner.grid.bpm - track.grid.bpm) / track.grid.bpm;
  return [
    partner.trackId === track.trackId ? "The partner is the same track." : null,
    apart > PAIR_MAX_APART ? `The tempos are ${(apart * 100).toFixed(1)}% apart; the Lesson needs 3% or less.` : null,
    apart < PAIR_MIN_APART ? "The tempos are the same: SYNC would have nothing to do." : null,
    ...[...tooShort(partner), ...noGroove(partner)].map((problem) => `Deck B: ${problem}`),
  ].filter((problem) => problem !== null);
}

/**
 * Where the blend sits. B comes in on A's phrase `blendPos`, the first of two phrases of full groove
 * (the kick and the bass): A's bass is there to hand over, and to hear the high-pass take it away.
 * B is cued a phrase before its own full groove, so its bass arrives with the handover.
 */
export function blendPositions(track: LessonTrack): { leadPos: number; blendPos: number; handoverPos: number; cueB: number } {
  const partner = trackOnDeck(track, "B");
  const blendPos = phraseStart(track.grid, fullGroovePhrase(track, 2) ?? steadyPhrase(track));
  const grooveB = fullGroovePhrase(partner, 2) ?? steadyPhrase(partner);
  return {
    leadPos: blendPos - barsSec(track, LEAD_BARS),
    blendPos,
    handoverPos: blendPos + barsSec(track, HANDOVER_BARS),
    cueB: phraseStart(partner.grid, Math.max(1, grooveB - 1)),
  };
}

/**
 * A plays from the lead-in; B waits on its cue point, synced to A, fader down. Every EQ and CFX
 * centred, the crossfader in the middle (it may be on the controller, left anywhere).
 */
function blendDecks(track: LessonTrack): DeckSetups {
  const { leadPos, cueB } = blendPositions(track);
  const centred = { eqCentred: true, filterCentred: true } as const;
  return {
    A: { pos: leadPos, fader: 1, play: true, sync: false, tempoPercent: 0, ...centred },
    // SYNC is on already: these Lessons are about the EQ and the filter, not the tempo.
    B: { pos: cueB, fader: 0, play: false, cuePoint: true, sync: true, ...centred },
    crossfader: 0.5,
  };
}

/** The Check's plan: the decks as practice starts them, CUE off, ending 2 bars after A's fader closes. */
function blendPlan(track: LessonTrack, maxBars: number, cues: CheckPlan["cues"]): CheckPlan {
  const decks = blendDecks(track);
  const { A } = decks;
  return {
    startPos: A.pos,
    autoPlay: true,
    faderAtStart: A.fader,
    deckA: { headphoneCue: false, sync: false, tempoPercent: 0, eqCentred: true, filterCentred: true },
    ...(decks.B === undefined ? {} : { deckB: { ...decks.B, headphoneCue: false } }),
    crossfader: 0.5,
    endWhen: { kind: "faded-out-then", deck: "A", bars: TAIL_BARS },
    timeoutSec: barsSec(track, LEAD_BARS + maxBars + TAIL_BARS) + 5,
    cues,
  };
}

const lessonProblems = (track: LessonTrack) => [...tooShort(track), ...noGroove(track)];

// ---------------------------------------------------------------------------------------------
// Lesson 12: bass-swap
// ---------------------------------------------------------------------------------------------

/** Practice goes round again a phrase after the swap: B in, the swap, A out and its LOW back. */
const SWAP_LOOP_BARS = 16;
/** A blend may run 16 bars past the swap before the Check times out. */
const SWAP_MAX_BARS = HANDOVER_BARS + 16;

const bassSwap: LessonDefinition = {
  id: "bass-swap",
  title: "Swap the bass",
  // Nothing new on the controller: the LOW knobs came with eq-basics.
  unlocks: [],
  practiceStart: (track) => blendDecks(track).A.pos,
  practiceDecks: blendDecks,
  practiceLoop: (track) => ({ atPos: blendPositions(track).blendPos + barsSec(track, SWAP_LOOP_BARS), reset: "setup" }),
  partner: { problems: eqPairProblems },
  headphones: true,
  aids: { sync: true, bpmDisplay: true },
  gradeFromOwnCue: true,
  trackProblems: lessonProblems,
  hook: [
    { caption: "Turn LOW B all the way down", control: "B.eq-low", trigger: { kind: "eq-cut", deck: "B", band: "low" }, named: "B's bass is out: B can come in, no clash." },
    { caption: "On the phrase's 1: Press , and push fader B up", control: "B.play", trigger: { kind: "play", deck: "B" }, named: "B's in: its drums, A's bass." },
    { caption: "Swap: LOW A down, LOW B up", control: "A.eq-low", trigger: { kind: "swap" }, named: "That's a bass swap: one bassline hands over to the other." },
  ],
  practice: { caption: "B in with LOW cut; swap the LOWs on the next phrase's 1", rep: "swap", window: 2, needed: 1 },
  checkCaption: "This one counts: B in with LOW cut, swap the LOWs on the 1",
  questions: [],
  planCheck: (track) => {
    const { leadPos, blendPos, handoverPos } = blendPositions(track);
    const beat = beatSec(track.grid);
    return blendPlan(track, SWAP_MAX_BARS, [
      { fromPos: leadPos, caption: "CUE 🎧 B on. LOW B all the way down" },
      { fromPos: blendPos - barsSec(track, 2), caption: "Next phrase: Press , and slide B up" },
      { fromPos: blendPos + beat, caption: "Fader B up. Swap on the next phrase's 1" },
      { fromPos: handoverPos - barsSec(track, 1), caption: "Next 1: LOW A down, LOW B up" },
      { fromPos: handoverPos + beat, caption: "Bass swapped. Now fader A down" },
      { fromPos: handoverPos + barsSec(track, 4), caption: "A out, then LOW A back to the middle" },
    ]);
  },
  // The Check finds B's entry and the swap inside the window, which starts at its own cue.
  taskFor: (): LessonTask => ({ lessonId: "bass-swap" }),
  tips: {
    "bass-swap.enter-low-cut": ["LOW B all the way down before B comes in.", "Cut LOW B while A plays the lead-in, then Press ,."],
    "bass-swap.swap-time": ["Count A's 8 bars on the 1s; swap on the next 1.", "LOW A down just before the 1, LOW B up right on it."],
    "bass-swap.clash-short": ["LOW A down first, then LOW B up: never both at once.", "Swap in one quick move: two basslines clash."],
  },
};

// ---------------------------------------------------------------------------------------------
// Lesson 13: filter-transition
// ---------------------------------------------------------------------------------------------

/** Practice goes round again 2 phrases after B came in: room for a sweep of up to 16 bars. */
const FILTER_LOOP_BARS = 18;
/** The sweep may take 16 bars; the Check times out after that. */
const FILTER_MAX_BARS = 16 + 2;
/**
 * The sweep the cues ask for: from 2 bars before B comes in to A out a phrase later. The Check measures
 * 7¾–16¼ bars from the first CFX move to the first frame A is silent; a sweep begun with B and A out on
 * the next 1 would sit right on the lower edge (as sync-blend's 8-bar ask did), so 10 leaves room both sides.
 */
const SWEEP_ASKED_BARS = HANDOVER_BARS + 2;

const filterTransition: LessonDefinition = {
  id: "filter-transition",
  title: "The filter",
  unlocks: ["A.filter", "B.filter"],
  practiceStart: (track) => blendDecks(track).A.pos,
  practiceDecks: blendDecks,
  practiceLoop: (track) => ({ atPos: blendPositions(track).blendPos + barsSec(track, FILTER_LOOP_BARS), reset: "setup" }),
  partner: { problems: eqPairProblems },
  headphones: true,
  aids: { sync: true, bpmDisplay: true },
  gradeFromOwnCue: true,
  trackProblems: lessonProblems,
  hook: [
    { caption: "Turn CFX A right", control: "A.filter", trigger: { kind: "filter-to", deck: "A", side: "high-pass" }, named: "High-pass: the kick and the bass thin out." },
    { caption: "Now turn CFX A left", control: "A.filter", trigger: { kind: "filter-to", deck: "A", side: "low-pass" }, named: "Low-pass: the highs go, A sounds muffled." },
    {
      caption: "CFX A back to the middle",
      control: "A.filter",
      trigger: { kind: "filter-to", deck: "A", side: "centre" },
      named: "Middle: no filter. B has a CFX too.",
      reveals: ["B.filter"],
    },
  ],
  practice: { caption: "CFX A right from 2 bars before B; A out a phrase after B (S)", rep: "filter-out", window: 2, needed: 1 },
  checkCaption: `This one counts: filter A out over ${String(SWEEP_ASKED_BARS)} bars as B comes in`,
  questions: [],
  planCheck: (track) => {
    const { leadPos, blendPos, handoverPos } = blendPositions(track);
    const beat = beatSec(track.grid);
    return blendPlan(track, FILTER_MAX_BARS, [
      { fromPos: leadPos, caption: "CUE 🎧 B on. B comes in on the next phrase" },
      { fromPos: handoverPos - barsSec(track, SWEEP_ASKED_BARS), caption: "Start CFX A right, slowly. B in on the 1" },
      { fromPos: blendPos - barsSec(track, 1), caption: "Next 1: Press , and slide B up" },
      { fromPos: blendPos + beat, caption: "Keep turning CFX A right, slowly" },
      { fromPos: blendPos + barsSec(track, 5), caption: "Keep going: CFX A most of the way right" },
      { fromPos: handoverPos - barsSec(track, 1), caption: "Next 1: A out (S)" },
      { fromPos: handoverPos + beat, caption: "CFX A back to the middle" },
    ]);
  },
  // The Check finds the sweep and A's exit inside the window, which starts at its own cue.
  taskFor: (): LessonTask => ({ lessonId: "filter-transition" }),
  tips: {
    "filter-transition.hpf-depth": ["Turn CFX A most of the way right before A goes out.", "Past 70%: only the hats of A are left."],
    "filter-transition.filter-length": ["Start CFX A 2 bars before B; A out on the next phrase's 1 (S).", `Turn it slowly: ${String(SWEEP_ASKED_BARS)} bars, not 1.`],
    "filter-transition.cfx-back": ["A out, then CFX A straight back to the middle.", "CFX A in the middle within a bar of A going quiet."],
  },
};

export type EqFilterLessonId = "bass-swap" | "filter-transition";

/** Lessons 12–13, in catalogue order. */
export const EQ_FILTER_LESSONS: readonly (LessonDefinition & { readonly id: EqFilterLessonId })[] = [
  { ...bassSwap, id: "bass-swap" },
  { ...filterTransition, id: "filter-transition" },
];
