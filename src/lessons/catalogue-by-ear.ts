// Lessons 14–16 as data (docs/lesson-catalogue.md §1, check-design §4): nudging B into phase with the
// jog wheel, matching tempo by ear, and a long blend by ear. SYNC is locked off in all three; from 15
// the BPM display and phase meter are covered. These are the hardest skills in the course, so practice
// is a drill of short rounds (`PracticeDrill`, run live by the app): one rep every few seconds, with
// feedback, and the covered displays shown, only between rounds.
import type { Attempt, CtxSpan, DeckId, LessonTask } from "@shared/attempt.ts";
import type { CriterionResult } from "@shared/check-result.ts";
import { pairProblems } from "./catalogue-sync.ts";
import { tempoPercentApart } from "./drill.ts";
import { barsSec, sectionOf, steadyPhrase } from "./plan.ts";
import { beatSec, cuedAt, heardTimeOf, phraseStart, trackOnDeck } from "./track.ts";
import type { CheckPlan, ControlId, DeckSetups, LessonDefinition, LessonTrack, PracticeDrill } from "./types.ts";

const tooShort = (track: LessonTrack) => (track.phraseStarts.length < 6 ? ["The track is too short for this Lesson (6 phrases)."] : []);
const isQuiet = (track: LessonTrack, phrase: number) => {
  const name = sectionOf(track, phrase);
  return name === "breakdown" || name === "build";
};

/**
 * The earliest phrase (from 1) that starts `phrases` phrases in a row with the kick (no breakdown or
 * build): by ear, the Learner needs drums to hear drift. Falls back to the steady phrase.
 */
export function kickRun(track: LessonTrack, phrases: number): number {
  for (let phrase = 1; phrase + phrases - 1 <= track.phraseStarts.length; phrase += 1) {
    if (!Array.from({ length: phrases }, (_, index) => phrase + index).some((candidate) => isQuiet(track, candidate))) return phrase;
  }
  return steadyPhrase(track);
}

/**
 * The heard time at which `deck` played track position `pos`, after the Check's own cue to its start
 * position in `window`: before that cue the recorded playhead also holds the hook and the practice,
 * which play the same positions. +Infinity when the Check never got there (the attempt is void).
 */
function heardAfterOwnCue(plan: CheckPlan, attempt: Attempt, window: CtxSpan, pos: number, deck: DeckId = "A"): number {
  const playhead = attempt.decks[deck]?.playhead;
  const startPos = deck === "A" ? plan.startPos : plan.deckB?.pos;
  const cued = playhead === undefined || startPos === undefined ? null : cuedAt(playhead, startPos, window.from);
  const heard = playhead === undefined || cued === null ? null : heardTimeOf(playhead, pos, cued);
  return heard ?? Number.POSITIVE_INFINITY;
}

const SYNC_LOCKED: readonly ControlId[] = ["A.sync", "B.sync"];
/** The displays covered from tempo-by-ear on (shown only between practice rounds). */
export const COVERED_DISPLAYS: readonly ControlId[] = ["A.bpm", "B.bpm", "phase-meter"];
const BY_EAR_LOCKS: readonly ControlId[] = [...SYNC_LOCKED, ...COVERED_DISPLAYS];

/** One per attempt, so B's side and size of error cannot be learnt by heart. */
const at = <Value>(list: readonly Value[], attempt: number, fallback: Value): Value => list[(attempt - 1) % list.length] ?? fallback;

/** Both decks' tempo controls as each Lesson starts them: SYNC off, ±6%, the tempo fader where given. */
const tempoSetup = (tempoPercent: number) => ({ sync: false, tempoRange: 6 as const, tempoPercent });

// ---------------------------------------------------------------------------------------------
// Lesson 14: nudge-phase
// ---------------------------------------------------------------------------------------------

/** Bars of listening before phase grading starts, then converge (≤ 4) and hold (8). */
const NUDGE_LEAD_BARS = 2;
const NUDGE_CONVERGE_BARS = 4;
const NUDGE_HOLD_BARS = 8;
/** B's head start in the Check, beats (up to ¼, catalogue §1), by attempt. */
const NUDGE_CHECK_OFFSETS = [0.22, -0.18, 0.25, -0.15] as const;
const NUDGE_DRILL: PracticeDrill = {
  kind: "hold",
  offsetsBeats: [0.2, -0.15, 0.12, -0.22, 0.18, -0.1],
  apartPercents: [0],
  holdMs: 15,
  holdBars: 1,
  giveUpBars: 8,
  revealMs: 1500,
};

const nudgePos = (track: LessonTrack) => phraseStart(track.grid, kickRun(track, 2));

function nudgeDecks(track: LessonTrack, offsetBeats: number): DeckSetups {
  const pos = nudgePos(track);
  return {
    A: { pos, fader: 1, play: true, headphoneCue: false, ...tempoSetup(0) },
    B: { pos: pos + offsetBeats * beatSec(track.grid), fader: 1, play: true, headphoneCue: false, ...tempoSetup(0) },
  };
}

const nudgePhase: LessonDefinition = {
  id: "nudge-phase",
  title: "Nudge it back in line",
  unlocks: ["A.jog-bend", "B.jog-bend", "phase-meter"],
  practiceStart: nudgePos,
  // In phase: each drill round knocks B out by its own offset.
  practiceDecks: (track) => nudgeDecks(track, 0),
  practiceLoop: () => null,
  drill: NUDGE_DRILL,
  locks: SYNC_LOCKED,
  aids: { bpmDisplay: true, phaseMeter: true },
  gradeFromOwnCue: true,
  trackProblems: tooShort,
  hook: [
    {
      caption: "Two kicks? Turn jog B (← →)",
      control: "B.jog",
      trigger: { kind: "touch", control: "B.jog-bend" },
      named: "A nudge: B runs a touch faster or slower while you turn.",
      reveals: ["A.jog-bend", "B.jog-bend"],
    },
    { caption: "Nudge B till the PHASE dot sits in the middle", control: "phase-meter", trigger: { kind: "phase-held" }, named: "In phase: one kick, not two." },
  ],
  practice: { caption: "Knocked out again: nudge B back in line", rep: "phase-hold", window: 3, needed: 2 },
  checkCaption: "This one counts: nudge B into line, then hold it",
  questions: [],
  planCheck: (track, attempt = 1): CheckPlan => {
    const decks = nudgeDecks(track, at(NUDGE_CHECK_OFFSETS, attempt, 0.2));
    const pos = decks.A.pos;
    const phaseFromPos = pos + barsSec(track, NUDGE_LEAD_BARS);
    const beat = beatSec(track.grid);
    const lengthBars = NUDGE_LEAD_BARS + NUDGE_CONVERGE_BARS + NUDGE_HOLD_BARS + 1;
    return {
      startPos: pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false, ...tempoSetup(0) },
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      endWhen: {
        kind: "held",
        phaseMs: 12,
        tempoBpm: null,
        bars: NUDGE_HOLD_BARS + 0.25,
        notBeforePos: phaseFromPos + barsSec(track, NUDGE_HOLD_BARS) + beat,
        orPos: pos + barsSec(track, lengthBars),
      },
      timeoutSec: barsSec(track, lengthBars) + 15,
      cues: [
        { fromPos: pos, caption: "Two kicks: B's out. Nudge it with jog B (← →)" },
        { fromPos: phaseFromPos, caption: "Dot to the middle, then hold it there" },
        { fromPos: phaseFromPos + barsSec(track, NUDGE_CONVERGE_BARS), caption: "Hold it: small nudges only" },
      ],
    };
  },
  taskFor: (track, plan, attempt, window): LessonTask => ({
    lessonId: "nudge-phase",
    // Graded once A has played the lead bars of the Check's own play-through: listening first is not slow.
    phaseFrom: heardAfterOwnCue(plan, attempt, window, plan.startPos + barsSec(track, NUDGE_LEAD_BARS)),
  }),
  tips: {
    "nudge-phase.converge": ["Two kicks? Turn jog B the way that makes them one.", "B ahead: slow it. B behind: speed it up. Watch the dot."],
    "nudge-phase.hold": ["Once in line, let go: small, short nudges only.", "Drifting again? One quick nudge, then listen."],
    "nudge-phase.cue-presses": ["Leave CUE B alone: the jog brings it back, no restart."],
  },
};

// ---------------------------------------------------------------------------------------------
// Two tracks by ear: tempo-by-ear (15) and blend-by-ear (16)
// ---------------------------------------------------------------------------------------------

/** Where A and B play from: each at the start of a run of kick phrases on its own track. */
function byEarPositions(track: LessonTrack, phrases: number): { posA: number; posB: number } {
  const partner = trackOnDeck(track, "B");
  return { posA: phraseStart(track.grid, kickRun(track, phrases)), posB: phraseStart(partner.grid, kickRun(partner, phrases)) };
}

/** B's tempo fader that puts B `apartPercent` off A (A on its own tempo). */
const apartFader = (track: LessonTrack, apartPercent: number) => tempoPercentApart(track.grid.bpm, trackOnDeck(track, "B").grid.bpm, apartPercent);

// ---------------------------------------------------------------------------------------------
// Lesson 15: tempo-by-ear
// ---------------------------------------------------------------------------------------------

const MATCH_LEAD_BARS = 2;
const MATCH_WITHIN_BARS = 32;
const MATCH_HOLD_BARS = 8;
/** B against A in the Check (catalogue: 0.5–2% apart), faster or slower, by attempt. */
const MATCH_CHECK_APART = [1.2, -0.9, 1.7, -1.4, 0.7, -1.9] as const;
/** The match the "held" end reads live: a little tighter than the Check's 0.1 BPM and 20 ms. */
const MATCH_LIVE_BPM = 0.08;
const MATCH_LIVE_MS = 17;
const TEMPO_DRILL: PracticeDrill = {
  kind: "tempo-ear",
  apartPercents: [1.5, -1.2, 0.8, -1.8, 1.0, -0.6, 2.0, -1.5],
  matchBpm: 0.1,
  giveUpBars: 24,
  revealMs: 2500,
};

function tempoDecks(track: LessonTrack, apartPercent: number): DeckSetups {
  const { posA, posB } = byEarPositions(track, 3);
  return {
    A: { pos: posA, fader: 1, play: true, headphoneCue: false, ...tempoSetup(0) },
    B: { pos: posB, fader: 1, play: true, headphoneCue: false, ...tempoSetup(apartFader(track, apartPercent)) },
  };
}

const tempoByEar: LessonDefinition = {
  id: "tempo-by-ear",
  title: "Match tempo by ear",
  unlocks: [],
  practiceStart: (track) => byEarPositions(track, 3).posA,
  practiceDecks: (track) => tempoDecks(track, TEMPO_DRILL.apartPercents[0] ?? 1),
  practiceLoop: () => null,
  partner: { problems: pairProblems },
  drill: TEMPO_DRILL,
  locks: BY_EAR_LOCKS,
  gradeFromOwnCue: true,
  trackProblems: tooShort,
  hook: [
    { caption: "No BPM now. Faster or slower? Slide TEMPO B to fix it", control: "B.tempo", trigger: { kind: "tempo-guess" }, named: "Kicks galloping apart: the tempos differ. Your ears decide." },
    { caption: "Closer and closer: when the drift stops, Ready (R)", control: "B.tempo", trigger: { kind: "tempo-match" }, named: "After each try, the BPMs and meter show for a moment." },
  ],
  practice: { caption: "Faster or slower? Fix B with TEMPO B, then R", rep: "tempo-ear", window: 4, needed: 3 },
  checkCaption: "This one counts: match B by ear, nudge it in line, hold it",
  questions: [],
  planCheck: (track, attempt = 1): CheckPlan => {
    const decks = tempoDecks(track, at(MATCH_CHECK_APART, attempt, 1.2));
    const pos = decks.A.pos;
    const matchFromPos = pos + barsSec(track, MATCH_LEAD_BARS);
    const lengthBars = MATCH_LEAD_BARS + MATCH_WITHIN_BARS + MATCH_HOLD_BARS + 1;
    return {
      startPos: pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false, ...tempoSetup(0) },
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      endWhen: {
        kind: "held",
        phaseMs: MATCH_LIVE_MS,
        tempoBpm: MATCH_LIVE_BPM,
        bars: MATCH_HOLD_BARS + 0.25,
        notBeforePos: matchFromPos + barsSec(track, MATCH_HOLD_BARS) + beatSec(track.grid),
        orPos: pos + barsSec(track, lengthBars),
      },
      timeoutSec: barsSec(track, lengthBars) + 15,
      cues: [
        { fromPos: pos, caption: "Faster or slower? Match B with TEMPO B" },
        { fromPos: matchFromPos + barsSec(track, 8), caption: "No more drift? Nudge it in line: jog B (← →)" },
        { fromPos: matchFromPos + barsSec(track, 20), caption: "Keep it together: tiny moves" },
      ],
    };
  },
  taskFor: (track, plan, attempt, window): LessonTask => ({
    lessonId: "tempo-by-ear",
    matchFrom: heardAfterOwnCue(plan, attempt, window, plan.startPos + barsSec(track, MATCH_LEAD_BARS)),
  }),
  tips: {
    "tempo-by-ear.tempo-match": [
      "Kicks pulling apart: which one comes first? That one's faster.",
      "Big move first, then smaller and smaller: stop when the drift stops.",
      "Tempo first, then jog B to line them up.",
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// Lesson 16: blend-by-ear
// ---------------------------------------------------------------------------------------------

/** A phrase to match B in the headphones, 16 bars of blend, 4 after A's out (loud-steady reads them). */
const BLEND_MATCH_BARS = 8;
const BLEND_BARS = 16;
const BLEND_TAIL_BARS = 4;
/**
 * A fades out after the 16 bars, not across their second half: the Check measures the blend to the
 * first frame A is inaudible, and a channel fader is inaudible for its last ~30% of travel (−24 dB at
 * the crossfader's centre), so a slow fade from the swap to bar 16 measured under 14 bars.
 */
const BLEND_FADE_BARS = 2;
/** B against A in the Check (catalogue: ≤ 2% apart), by attempt. */
const BLEND_CHECK_APART = [-1.1, 0.8, -1.6, 1.4] as const;
const RIDE_DRILL: PracticeDrill = {
  kind: "hold",
  offsetsBeats: [0.12, -0.1, 0.15, -0.08, 0.1, -0.14],
  // Close already, but not quite: the drift comes back unless the tempo is trimmed too.
  apartPercents: [0.25, -0.2, 0.15, -0.3, 0.2, -0.15],
  holdMs: 25,
  holdBars: 4,
  giveUpBars: 12,
  revealMs: 2000,
};

function rideDecks(track: LessonTrack, apartPercent: number): DeckSetups {
  const { posA, posB } = byEarPositions(track, 4);
  return {
    A: { pos: posA, fader: 1, play: true, headphoneCue: false, eqCentred: true, ...tempoSetup(0) },
    B: { pos: posB, fader: 1, play: true, headphoneCue: false, eqCentred: true, ...tempoSetup(apartFader(track, apartPercent)) },
  };
}

function blendCheckDecks(track: LessonTrack, apartPercent: number): DeckSetups {
  const { posA, posB } = byEarPositions(track, 4);
  return {
    A: { pos: posA, fader: 1, play: true, headphoneCue: false, eqCentred: true, ...tempoSetup(0) },
    // B starts with A, in the headphones only: the Learner cuts LOW B, matches it there, then blends it
    // in. LOW B is theirs to cut, not the set-up's, so an FLX4's knob and the app agree (soft takeover).
    B: { pos: posB, fader: 0, play: true, headphoneCue: true, eqCentred: true, ...tempoSetup(apartFader(track, apartPercent)) },
  };
}

const blendByEar: LessonDefinition = {
  id: "blend-by-ear",
  title: "A full blend by ear",
  unlocks: [],
  practiceStart: (track) => byEarPositions(track, 4).posA,
  practiceDecks: (track) => rideDecks(track, RIDE_DRILL.apartPercents[0] ?? 0.2),
  practiceLoop: () => null,
  partner: { problems: (track, partner) => [...pairProblems(track, partner), ...(partner.phraseStarts.length < 4 ? ["Deck B: the track is too short."] : [])] },
  headphones: true,
  drill: RIDE_DRILL,
  locks: BY_EAR_LOCKS,
  gradeFromOwnCue: true,
  trackProblems: tooShort,
  hook: [
    { caption: "Hear them drift apart? Trim TEMPO B, a little", control: "B.tempo", trigger: { kind: "touch", control: "B.tempo" }, named: "Close is not enough: a long blend drifts." },
    { caption: "Then nudge B back in line: jog B (← →)", control: "B.jog", trigger: { kind: "touch", control: "B.jog-bend" }, named: "Riding the blend: trim the tempo, nudge the phase." },
  ],
  practice: { caption: "Keep B in line for 4 bars: TEMPO B and jog B", rep: "phase-hold", window: 3, needed: 2 },
  checkCaption: "This one counts: match B in your headphones, blend 16 bars, swap the bass",
  questions: [],
  planCheck: (track, attempt = 1): CheckPlan => {
    const decks = blendCheckDecks(track, at(BLEND_CHECK_APART, attempt, -1.1));
    const pos = decks.A.pos;
    const inPos = pos + barsSec(track, BLEND_MATCH_BARS);
    const swapPos = inPos + barsSec(track, BLEND_BARS / 2);
    const outPos = inPos + barsSec(track, BLEND_BARS);
    const beat = beatSec(track.grid);
    return {
      startPos: pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false, eqCentred: true, ...tempoSetup(0) },
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      // LOW B is cut off the clock, B waiting: the phrase of matching starts with both decks on R.
      setUp: { caption: "Set up: LOW B all the way down — then R" },
      firstPhraseAction: inPos,
      endWhen: { kind: "faded-out-then", deck: "A", bars: BLEND_TAIL_BARS },
      timeoutSec: barsSec(track, BLEND_MATCH_BARS + BLEND_BARS + BLEND_TAIL_BARS + 8) + 15,
      cues: [
        { fromPos: pos, caption: "B's in your headphones. Now match B: TEMPO B, then jog B" },
        { fromPos: inPos - barsSec(track, 1), caption: "Next 1: fader B up" },
        { fromPos: inPos + beat, caption: "Both play now. Keep B in line" },
        { fromPos: swapPos - barsSec(track, 1), caption: "Next 1: swap the bass. LOW A down, LOW B up" },
        { fromPos: swapPos + beat, caption: "Bass swapped. Both stay up: keep B in line" },
        { fromPos: outPos - barsSec(track, 1), caption: `Next 1: fader A down slowly, over ${String(BLEND_FADE_BARS)} bars` },
        // A counts as gone once its fader is under about 0.3, most of the way down the fade.
        { fromPos: outPos + barsSec(track, BLEND_FADE_BARS * 0.75), caption: "All the way down, then LOW A to the middle" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "blend-by-ear" }),
  tips: {
    "blend-by-ear.blend-length": [`Both up for the whole 16 bars, then fader A down over ${String(BLEND_FADE_BARS)} bars.`],
    "blend-by-ear.phase-hold": ["Match in the headphones first, before fader B comes up.", "Hear two kicks? A short nudge on jog B, then listen."],
    "blend-by-ear.swap-time": ["Swap on the 1 of the middle phrase: LOW A down, LOW B up, together."],
    "blend-by-ear.clash-short": ["Cut LOW B before fader B comes up.", "Both LOWs up means two basslines: swap them in one move."],
    "blend-by-ear.loud-steady": ["LOW B all the way down from the start, up only at the swap: two full basslines are too loud."],
  },
};

export type ByEarLessonId = "nudge-phase" | "tempo-by-ear" | "blend-by-ear";

/** Lessons 14–16, in catalogue order. */
export const BY_EAR_LESSONS: readonly (LessonDefinition & { readonly id: ByEarLessonId })[] = [
  { ...nudgePhase, id: "nudge-phase" },
  { ...tempoByEar, id: "tempo-by-ear" },
  { ...blendByEar, id: "blend-by-ear" },
];

const pct = (ratio: number) => `${String(Math.round(ratio * 100))}%`;

/** Result-card lines for Lessons 14–16; null for other criteria. */
export function describeByEar(criterion: CriterionResult): string | null {
  const { measured } = criterion;
  switch (criterion.id) {
    case "nudge-phase.converge":
      return measured === null ? "In line: B never got under 15 ms" : `In line after ${measured.toFixed(1)} bars (need 4 or less)`;
    case "nudge-phase.hold": {
      if (criterion.unit === "beats") return measured === null ? "Held: not measured" : `Longest drift over 30 ms: ${measured.toFixed(1)} beats (need 1 or less)`;
      return measured === null ? "Held: never in line" : `Held in line ${pct(measured)} of 8 bars (need 95%)`;
    }
    case "nudge-phase.cue-presses":
      return measured === 0 ? "CUE B left alone" : `CUE B pressed ${String(measured ?? 0)} times (1 at most)`;
    case "tempo-by-ear.tempo-match":
      return measured === null ? "Tempo matched and held: not within 32 bars" : `Matched and held after ${measured.toFixed(1)} bars (need 32 or less)`;
    case "blend-by-ear.blend-length":
      return measured === null ? "Blend length: A never went all the way out" : `Blend: ${measured.toFixed(1)} bars (need 16, less a beat at most)`;
    case "blend-by-ear.phase-hold": {
      if (criterion.unit === "bars") return measured === null ? "Drift: not measured" : `Longest drift over 60 ms: ${measured.toFixed(2)} bars (need 1 or less)`;
      return measured === null ? "In line: the decks never played together" : `In line (under 25 ms) ${pct(measured)} of the blend (need 85%)`;
    }
    case "blend-by-ear.swap-time":
      return measured === null ? "Bass swap: never happened" : `Bass swap ${measured.toFixed(2)} beats from the phrase start (need 1 or less)`;
    case "blend-by-ear.clash-short":
      return measured === null ? "Two basslines: not measured" : `Two basslines together: ${measured.toFixed(2)} beats (need 1 or less)`;
    case "blend-by-ear.loud-steady":
      return measured === null ? "Level through the blend: not measured" : `Level through the blend: moved ${measured.toFixed(1)} dB (need 3 or less)`;
    default:
      return null;
  }
}
