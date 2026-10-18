// Lessons 1–7 as data (docs/lesson-catalogue.md §1, check-design §4): the hook, practice, the Check
// plan on the chosen track, and authored tips. Captions, not prose: a few words, the key in brackets.
import type { Aids, Attempt, CheckMode, CheckVariant, CtxSpan, LessonId, LessonTask, TaskSpec, TaskTrack } from "@shared/attempt.ts";
import { EQ_FILTER_LESSONS, type EqFilterLessonId } from "./catalogue-eq-filter.ts";
import { BY_EAR_LESSONS, type ByEarLessonId } from "./catalogue-by-ear.ts";
import { PERFORMANCE_LESSONS, type PerformanceLessonId } from "./catalogue-performance.ts";
import { SYNC_LESSONS, type SyncLessonId } from "./catalogue-sync.ts";
import { barsSec, fromOwnCue, heardSpan, steadyPhrase, switchCountdown } from "./plan.ts";
import { barStart, beatSec, phraseOf, phraseStart, sliceTrack, trackOnDeck, trimKnobFor, UNMEASURED_PEAK_DB } from "./track.ts";
import type { CheckPlan, ControlId, DeckSetups, LessonDefinition, LessonTrack, LoopPlan } from "./types.ts";

const BARS_PER_PHRASE = 8;
/** How long a checkpoint's tick and caption stay up. */
const CHECKPOINT_BARS = 4;

/** Lesson aids for Lessons 1–3: no sync or quantize to speak of, captions on. */
export const LESSON_AIDS: Aids = { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: true };

/** The first tap window (8 phrases from phrase ≥ 2) that holds a breakdown and a later drop. */
function phraseWindow(track: LessonTrack): { first: number; breakdown: number; drop: number } | null {
  for (let first = 2; first + BARS_PER_PHRASE <= track.phraseStarts.length; first += 1) {
    const breakdown = phraseOf(track.sections, "breakdown", first);
    const drop = breakdown === null ? null : phraseOf(track.sections, "drop", breakdown + 1);
    if (breakdown !== null && drop !== null && drop < first + BARS_PER_PHRASE) return { first, breakdown, drop };
  }
  return null;
}

const deckBasics: LessonDefinition = {
  id: "deck-basics",
  title: "Play a track out loud",
  unlocks: ["A.play", "A.channel-fader", "master-level", "master-meter"],
  practiceStart: (track) => (track.phraseStarts.length > 2 ? phraseStart(track.grid, 3) : 0),
  trackProblems: () => [],
  hook: [
    { caption: "Press X", control: "A.play", trigger: { kind: "play" }, named: "That's PLAY. The deck spins, but it's silent." },
    { caption: "Push the fader up (W)", control: "A.channel-fader", trigger: { kind: "fader-up" }, named: "That's the channel fader: deck to speakers." },
    { caption: "Now pull it down (S)", control: "A.channel-fader", trigger: { kind: "fader-down" }, named: "Fade out. That's a deck." },
  ],
  practice: { caption: "Again: fade in (W), fade out (S)", rep: "fade", window: 1, needed: 1 },
  checkCaption: "This one counts: X, fade in within 4 bars, fade out",
  questions: [],
  planCheck: (track) => ({
    startPos: deckBasics.practiceStart(track),
    autoPlay: false,
    faderAtStart: 0,
    endWhen: { kind: "faded-out" },
    timeoutSec: 30,
    cues: [],
  }),
  taskFor: (): LessonTask => ({ lessonId: "deck-basics" }),
  tips: {
    "deck-basics.fade-in": ["Fader up as soon as it plays: within 4 bars.", "Press X, then W right away."],
    "deck-basics.fade-out": ["Finish with the fader all the way down (S).", "Pull it to the bottom: half-way still plays."],
    "deck-basics.no-clip-local": ["Turn MASTER down a touch: the meter hit red."],
  },
};

const beatsAndBars: LessonDefinition = {
  id: "beats-and-bars",
  title: "Find the beat and the one",
  unlocks: ["tap"],
  practiceStart: (track) => barStart(track.grid, (steadyPhrase(track) - 1) * BARS_PER_PHRASE),
  trackProblems: (track) => (track.phraseStarts.length < 4 ? ["The track is too short for 17 bars of tapping."] : []),
  hook: [
    { caption: "Tap Space on every kick", control: "tap", trigger: { kind: "beat-taps", count: 4 }, named: "Those are beats. Four make a bar." },
    { caption: "Now tap only the big one", control: "tap", trigger: { kind: "downbeat-taps", count: 2 }, named: "That's the 1: the downbeat." },
  ],
  practice: { caption: "Keep tapping every beat (Space)", rep: "beat-tap", window: 8, needed: 7 },
  checkCaption: "This one counts: every beat, then only the 1",
  questions: [],
  planCheck: (track) => {
    const beatsBar = (steadyPhrase(track) - 1) * BARS_PER_PHRASE + 1;
    const countIn = barStart(track.grid, beatsBar - 1);
    const half = beatSec(track.grid) / 2;
    return {
      startPos: countIn,
      autoPlay: true,
      faderAtStart: 1,
      endWhen: { kind: "position", pos: barStart(track.grid, beatsBar + 16) + beatSec(track.grid) },
      timeoutSec: 60,
      cues: [
        { fromPos: countIn, caption: "Count in: 1, 2, 3, 4" },
        { fromPos: barStart(track.grid, beatsBar) - half, caption: "Tap every beat (Space)" },
        ...switchCountdown(track, barStart(track.grid, beatsBar + 8), { doing: "Every beat", now: "Only the 1 now" }),
      ],
    };
  },
  taskFor: (track, plan, attempt, attemptWindow): LessonTask => {
    const beatsBar = (steadyPhrase(track) - 1) * BARS_PER_PHRASE + 1;
    const at = (bar: number) => barStart(track.grid, bar);
    return {
      lessonId: "beats-and-bars",
      beatSection: heardSpan(track, plan, attempt, attemptWindow, at(beatsBar), at(beatsBar + 8)),
      downbeatSection: heardSpan(track, plan, attempt, attemptWindow, at(beatsBar + 8), at(beatsBar + 16)),
    };
  },
  tips: {
    "beats-and-bars.beat-taps": ["Tap with the kick, not after it: listen, then move.", "Nod your head to the kick, tap on the nod."],
    "beats-and-bars.downbeat-taps": ["Count 1-2-3-4 in your head; tap only on 1.", "The 1 feels heavier: something new often lands there."],
  },
};

const phrases: LessonDefinition = {
  id: "phrases",
  title: "Count phrases",
  unlocks: [],
  practiceStart: (track) => barStart(track.grid, ((phraseWindow(track)?.first ?? 2) - 1) * BARS_PER_PHRASE - 1),
  trackProblems: (track) =>
    phraseWindow(track) === null ? ["The track needs a named breakdown and a later drop within 8 phrases."] : [],
  hook: [
    { caption: "Tap Space when something changes", control: "tap", trigger: { kind: "phrase-taps", count: 1 }, named: "That change every 8 bars is a phrase." },
  ],
  practice: { caption: "Tap each new phrase: count 8 bars", rep: "phrase-tap", window: 2, needed: 2 },
  checkCaption: "This one counts: tap every phrase, then name the breakdown and drop",
  questions: [
    { id: "breakdown", caption: "Which phrase was the breakdown?", options: BARS_PER_PHRASE },
    { id: "drop", caption: "Which phrase was the drop?", options: BARS_PER_PHRASE },
  ],
  planCheck: (track): CheckPlan => {
    const first = phraseWindow(track)?.first ?? 2;
    const firstBar = (first - 1) * BARS_PER_PHRASE + 1;
    // Two 32-bar halves, one Check: the tick lands a beat after the second half's first phrase start.
    const halfway = phraseStart(track.grid, first + BARS_PER_PHRASE / 2);
    const tapCaption = "Tap each new phrase (Space)";
    return {
      startPos: barStart(track.grid, firstBar - 2),
      autoPlay: true,
      faderAtStart: 1,
      endWhen: { kind: "position", pos: phraseStart(track.grid, first + BARS_PER_PHRASE) + beatSec(track.grid) },
      timeoutSec: 150,
      cues: [
        { fromPos: barStart(track.grid, firstBar - 2), caption: "Get ready: phrase 1 is coming" },
        { fromPos: barStart(track.grid, firstBar) - beatSec(track.grid), caption: tapCaption },
        { fromPos: halfway + beatSec(track.grid), caption: "Halfway: keep tapping each phrase", checkpoint: true },
        { fromPos: halfway + CHECKPOINT_BARS * 4 * beatSec(track.grid), caption: tapCaption },
      ],
    };
  },
  taskFor: (track, plan, attempt, attemptWindow): LessonTask => {
    const window = phraseWindow(track) ?? { first: 2, breakdown: 0, drop: 0 };
    return {
      lessonId: "phrases",
      tapSection: heardSpan(track, plan, attempt, attemptWindow, phraseStart(track.grid, window.first), phraseStart(track.grid, window.first + BARS_PER_PHRASE)),
      sections: { breakdown: window.breakdown - window.first + 1, drop: window.drop - window.first + 1 },
    };
  },
  tips: {
    "phrases.phrase-taps": ["Count bars on the 1s: 1…8, tap on the next 1.", "Phrases start where a sound comes in or drops out."],
    "phrases.name-sections": ["Breakdown: the kick leaves. Drop: it comes back hard.", "Number your phrase taps as you go: 1, 2, 3…"],
  },
};

// ---------------------------------------------------------------------------------------------
// Lessons 4–7 (two decks, the mixer and the headphone cue)
// ---------------------------------------------------------------------------------------------

/** The gain-staging zone for a channel's sample peak, dBFS: the gain-staging Check's own zone. */
export const GAIN_ZONE_DB: readonly [number, number] = [-6, -0.1];
/** Where the gain-staging Lesson starts each deck: A clipping, B too quiet. */
const HOT_PEAK_DB = 3;
const QUIET_PEAK_DB = -15;
/** gain-staging: time to set both trims, and the bars held after the second Ready (the timeout adds them). */
const GAIN_SETUP_SEC = 60;
const GAIN_HOLD_BARS = 8;
/** headphone-cue: B plays this far ahead of A, so A's beats (and its off-beat hats) never land on B's. */
const CUED_OFFSET_BEATS = 1 / 3;
/** cue-point: each slice starts this many beats before a downbeat, and lasts 6 bars. */
const SLICE_LEADS_BEATS = [1.37, 2.62, 0.71] as const;
const SLICE_BARS = 6;
/** cut-on-phrase: bars of A before the cut, and after it until the attempt ends. */
const CUT_LEAD_BARS = 6;
const CUT_TAIL_BARS = 5;

const steadyBar = (track: LessonTrack) => (steadyPhrase(track) - 1) * BARS_PER_PHRASE + 1;
const trimFor = (track: LessonTrack, targetPeakDb: number) => trimKnobFor(targetPeakDb - (track.peakDbfs ?? UNMEASURED_PEAK_DB));
const tooShort = (track: LessonTrack) => (track.phraseStarts.length < 4 ? ["The track is too short for a steady 16 bars."] : []);

/** Both decks off the zone; in the hook and practice B waits paused for the Learner's PLAY (`,`). */
function gainDecks(track: LessonTrack, playB: boolean): DeckSetups {
  const pos = phraseStart(track.grid, steadyPhrase(track));
  return {
    A: { pos, fader: 1, play: true, trim: trimFor(track, HOT_PEAK_DB) },
    B: { pos, fader: 0, play: playB, trim: trimFor(track, QUIET_PEAK_DB) },
  };
}

/** One steady phrase, looped: the levels stay the same however long the Learner takes. */
const steadyLoop = (track: LessonTrack): LoopPlan => ({ atPos: phraseStart(track.grid, steadyPhrase(track) + 1), reset: "positions" });

const gainStaging: LessonDefinition = {
  id: "gain-staging",
  title: "Set the level",
  unlocks: ["A.trim", "B.trim", "A.level-meter", "B.level-meter", "B.play", "B.channel-fader"],
  practiceStart: (track) => gainDecks(track, false).A.pos,
  practiceDecks: (track) => gainDecks(track, false),
  practiceLoop: steadyLoop,
  trackProblems: tooShort,
  hook: [
    { caption: "Turn TRIM A: meter out of the red", control: "A.trim", trigger: { kind: "in-zone", deck: "A" }, named: "That's TRIM: the level into the channel." },
    { caption: "Press , to play B", control: "B.play", trigger: { kind: "play", deck: "B" }, named: "B plays, fader down: only its meter moves." },
    { caption: "Turn TRIM B to match A", control: "B.trim", trigger: { kind: "in-zone", deck: "B" }, named: "Both in the zone: loud, no red." },
  ],
  practice: { caption: "Both meters in the zone, then Ready (R)", rep: "ready", window: 2, needed: 2 },
  checkCaption: "This one counts: trim A, R; trim B, R",
  questions: [],
  planCheck: (track) => {
    const decks = gainDecks(track, true);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { trim: decks.A.trim ?? 0 },
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      loop: steadyLoop(track),
      endWhen: { kind: "ready-windows", decks: ["A", "B"], bars: GAIN_HOLD_BARS },
      timeoutSec: GAIN_SETUP_SEC + barsSec(track, GAIN_HOLD_BARS),
      cues: [],
      readyCues: ["Trim A into the zone, then R", "Hands off A. Trim B to match, then R", "Hold it: 8 bars"],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "gain-staging", decks: ["A", "B"] }),
  tips: {
    "gain-staging.trim-A": ["TRIM A until its meter peaks just under the red.", "Red means clipping: turn TRIM down, not the fader."],
    "gain-staging.trim-B": ["TRIM B up until its meter peaks next to A's.", "The fader can stay down: TRIM works before it."],
    "gain-staging.loud-match": ["Match the meters: B's peaks level with A's.", "Same peak on both meters ≈ same loudness."],
  },
};

function cuedDecks(track: LessonTrack): DeckSetups {
  const pos = barStart(track.grid, steadyBar(track) - 4);
  return { A: { pos, fader: 1, play: true }, B: { pos: pos + CUED_OFFSET_BEATS * beatSec(track.grid), fader: 0, play: true, headphoneCue: false } };
}

const headphoneCue: LessonDefinition = {
  id: "headphone-cue",
  title: "Listen before they hear it",
  unlocks: ["A.headphone-cue", "B.headphone-cue", "cue-mix", "headphone-level", "tap"],
  practiceStart: (track) => cuedDecks(track).A.pos,
  practiceDecks: (track) => {
    const decks = cuedDecks(track);
    // Practice leaves CUE as the Learner set it in the hook.
    return { A: decks.A, ...(decks.B === undefined ? {} : { B: { pos: decks.B.pos, fader: 0, play: true } }) };
  },
  practiceLoop: (track) => ({ atPos: cuedDecks(track).A.pos + barsSec(track, 16), reset: "positions" }),
  headphones: true,
  tapDeck: "B",
  trackProblems: tooShort,
  hook: [
    { caption: "Turn on CUE 🎧 on channel B", control: "B.headphone-cue", trigger: { kind: "cue-on", deck: "B" }, named: "That's CUE: B in your left ear only." },
    { caption: "Turn MIXING", control: "cue-mix", trigger: { kind: "touch", control: "cue-mix" }, named: "MIXING: cue ↔ master in the headphone ear." },
    { caption: "Tap Space on B's kick (left ear)", control: "tap", trigger: { kind: "beat-taps", count: 4 }, named: "That's cueing: you hear B, the room doesn't." },
  ],
  practice: { caption: "Tap B's kick (Space): left ear, not the speakers", rep: "beat-tap", window: 8, needed: 7 },
  checkCaption: "This one counts: CUE B on, tap B's kick",
  questions: [],
  planCheck: (track) => {
    const decks = cuedDecks(track);
    const tapFrom = barStart(track.grid, steadyBar(track));
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false },
      ...(decks.B === undefined ? {} : { deckB: decks.B }),
      endWhen: { kind: "position", pos: barStart(track.grid, steadyBar(track) + 8) + beatSec(track.grid) },
      timeoutSec: 40,
      cues: [
        { fromPos: decks.A.pos, caption: "CUE 🎧 B on, fader B stays down" },
        { fromPos: tapFrom - beatSec(track.grid), caption: "Tap B's kick (Space)" },
      ],
    };
  },
  taskFor: (track, plan, attempt, attemptWindow): LessonTask => {
    const offset = (plan.deckB?.pos ?? plan.startPos) - plan.startPos;
    const from = barStart(track.grid, steadyBar(track)) + offset;
    return { lessonId: "headphone-cue", tapSection: heardSpan(track, plan, attempt, attemptWindow, from, from + barsSec(track, 8), "B") };
  },
  tips: {
    "headphone-cue.cued-taps": ["Left ear is B: tap its kick, not the speakers'.", "Turn MIXING fully left: only B in that ear."],
    "headphone-cue.b-off-master": ["Fader B stays down: CUE alone puts B in your ear.", "Turn CUE B on before the taps start."],
  },
};

const cueSetup = (track: LessonTrack): DeckSetups => ({
  A: { pos: barStart(track.grid, steadyBar(track)) - SLICE_LEADS_BEATS[0] * beatSec(track.grid), fader: 1, play: false, headphoneCue: true },
});

const cuePoint: LessonDefinition = {
  id: "cue-point",
  title: "Set a cue point by ear",
  unlocks: ["A.cue", "A.jog", "B.cue", "B.jog"],
  practiceStart: (track) => cueSetup(track).A.pos,
  practiceDecks: cueSetup,
  practiceLoop: () => null,
  headphones: true,
  trackProblems: tooShort,
  hook: [
    { caption: "Turn the jog wheel", control: "A.jog", trigger: { kind: "touch", control: "A.jog" }, named: "Paused, the jog moves the playhead: search." },
    { caption: "Find a kick. Press Z", control: "A.cue", trigger: { kind: "cue-set" }, named: "That's a cue point: Z sets it while paused." },
    { caption: "Hold Z to hear it, let go", control: "A.cue", trigger: { kind: "cue-preview" }, named: "Held CUE plays from the point; let go, it snaps back." },
  ],
  practice: { caption: "Cue on a 1: X play, X stop, jog, Z. Hold Z to check", rep: "cue-set", window: 3, needed: 2 },
  checkCaption: "This one counts: three cue points, each on a 1",
  questions: [],
  planCheck: (track) => {
    const beat = beatSec(track.grid);
    const bars = [0, 4, 8].map((offset) => steadyBar(track) + offset);
    const slices = SLICE_LEADS_BEATS.map((lead, index) => ({ fromSec: barStart(track.grid, bars[index] ?? 1) - lead * beat, lengthSec: barsSec(track, SLICE_BARS) }));
    return {
      startPos: 0,
      autoPlay: false,
      faderAtStart: 1,
      deckA: { headphoneCue: true },
      slices,
      endWhen: { kind: "slices-done" },
      timeoutSec: 120,
      cues: [],
      readyCues: slices.map((_, index) => `Cue ${String(index + 1)} of ${String(slices.length)}: a 1, by ear. R when happy`),
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "cue-point" }),
  taskTracks: (track, plan, trackSetId) =>
    (plan.slices ?? []).map((_, index) => ({ trackId: `${track.trackId}#cue-${String(index + 1)}`, trackSetId, deck: "A" as const })),
  tips: {
    "cue-point.cue-on-downbeat": ["Hold Z: if the kick isn't instant, jog a hair and set again.", "Count 1-2-3-4 while it plays; stop on the 1, then jog."],
  },
};

function cutDecks(track: LessonTrack): DeckSetups {
  const cutPos = phraseStart(track.grid, steadyPhrase(track) + 1);
  return {
    A: { pos: cutPos - barsSec(track, CUT_LEAD_BARS), fader: 1, play: true },
    B: { pos: phraseStart(track.grid, steadyPhrase(track)), fader: 0, play: false, cuePoint: true },
  };
}

const cutOnPhrase: LessonDefinition = {
  id: "cut-on-phrase",
  title: "Your first transition: the cut",
  unlocks: [],
  practiceStart: (track) => cutDecks(track).A.pos,
  practiceDecks: cutDecks,
  practiceLoop: (track) => ({ atPos: cutDecks(track).A.pos + barsSec(track, CUT_LEAD_BARS + 4), reset: "setup" }),
  headphones: true,
  trackProblems: tooShort,
  hook: [
    { caption: "Turn on CUE 🎧 on channel B", control: "B.headphone-cue", trigger: { kind: "cue-on", deck: "B" }, named: "B in your headphone ear: ready to go." },
    { caption: "Fader B up (O): silent till it plays", control: "B.channel-fader", trigger: { kind: "fader-up", deck: "B" }, named: "Fader up, deck paused: nothing yet." },
    { caption: "On the next phrase's 1: Press , and S together", control: "B.play", trigger: { kind: "cut" }, named: "That's a cut: B in, A out, on the phrase." },
  ],
  practice: { caption: "Cut on the phrase: Press , and S on the 1", rep: "cut", window: 2, needed: 1 },
  checkCaption: "This one counts: CUE B, fader B up, cut on the phrase",
  questions: [],
  planCheck: (track) => {
    const decks = cutDecks(track);
    const cutPos = decks.A.pos + barsSec(track, CUT_LEAD_BARS);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false },
      ...(decks.B === undefined ? {} : { deckB: { ...decks.B, headphoneCue: false } }),
      endWhen: { kind: "after", sec: barsSec(track, CUT_LEAD_BARS + CUT_TAIL_BARS) },
      timeoutSec: barsSec(track, CUT_LEAD_BARS + CUT_TAIL_BARS) + 5,
      cues: [
        { fromPos: decks.A.pos, caption: "CUE 🎧 B on, fader B up (O)" },
        { fromPos: cutPos - barsSec(track, 2), caption: "Next phrase: Press , and S on the 1" },
        { fromPos: cutPos + beatSec(track.grid), caption: "Let it ride" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "cut-on-phrase" }),
  tips: {
    "cut-on-phrase.cut-start": ["Count 8 bars on the 1s. Press , on the next 1.", "Press , and S together, right on the 1."],
    "cut-on-phrase.cut-tight": ["A out as B comes in: Press , and S together."],
    "cut-on-phrase.cued-before": ["CUE B on early: listen before you cut."],
    "cut-on-phrase.loud-jump": ["Match the meters with TRIM before you cut."],
  },
};

export type BuiltLessonId = "deck-basics" | "beats-and-bars" | "phrases" | "gain-staging" | "headphone-cue" | "cue-point" | "cut-on-phrase" | SyncLessonId | EqFilterLessonId | ByEarLessonId | PerformanceLessonId;
export type BuiltLesson = LessonDefinition & { readonly id: BuiltLessonId };

/** The built Lessons, in catalogue order (8–11 in catalogue-sync.ts, 12–13 in catalogue-eq-filter.ts, 14–16 in catalogue-by-ear.ts, 17–19 in catalogue-performance.ts). */
export const LESSONS: readonly BuiltLesson[] = [
  { ...deckBasics, id: "deck-basics" },
  { ...beatsAndBars, id: "beats-and-bars" },
  { ...phrases, id: "phrases" },
  { ...gainStaging, id: "gain-staging" },
  { ...headphoneCue, id: "headphone-cue" },
  { ...cuePoint, id: "cue-point" },
  { ...cutOnPhrase, id: "cut-on-phrase" },
  ...SYNC_LESSONS,
  ...EQ_FILTER_LESSONS,
  ...BY_EAR_LESSONS,
  ...PERFORMANCE_LESSONS,
];

/** Practice loops for Lessons that do not set their own: tap Lessons loop deck A from the practice start. */
const PRACTICE_LOOP_BARS = { "beat-tap": 16, "phrase-tap": 24 } as const;

/** How the decks start for the hook and practice. */
export function practiceDecksFor(definition: LessonDefinition, track: LessonTrack): DeckSetups {
  if (definition.practiceDecks !== undefined) return definition.practiceDecks(track);
  const taps = definition.practice.rep !== "fade";
  return { A: { pos: definition.practiceStart(track), fader: taps ? 1 : 0, play: taps } };
}

/** Where practice loops back to its start, or null when it does not loop. */
export function practiceLoopFor(definition: LessonDefinition, track: LessonTrack): LoopPlan | null {
  if (definition.practiceLoop !== undefined) return definition.practiceLoop(track);
  const rep = definition.practice.rep;
  if (rep !== "beat-tap" && rep !== "phrase-tap") return null;
  return { atPos: definition.practiceStart(track) + barsSec(track, PRACTICE_LOOP_BARS[rep]), reset: "positions" };
}

/** Both decks as the Check starts them. */
export function checkDecksFor(plan: CheckPlan): DeckSetups {
  return {
    A: { pos: plan.startPos, fader: plan.faderAtStart, play: plan.autoPlay, ...plan.deckA },
    ...(plan.deckB === undefined ? {} : { B: plan.deckB }),
    ...(plan.crossfader === undefined ? {} : { crossfader: plan.crossfader }),
    ...(plan.beatFx === undefined ? {} : { beatFx: plan.beatFx }),
  };
}

/**
 * The attempt with the grid of every track the Check planned to load (cue-point's slices). A slice the
 * Check never reached (it timed out, or a load failed) has no recorded grid, which would void the attempt
 * as an untrusted grid; its grid is Lesson data, so it is added and the missing cue point fails instead.
 * Recorded grids win.
 */
export function withPlannedGrids<Recorded extends Attempt>(attempt: Recorded, track: LessonTrack, plan: CheckPlan): Recorded {
  const planned = (plan.slices ?? []).map((slice, index) => sliceTrack(track, slice, index));
  if (planned.length === 0) return attempt;
  return { ...attempt, grids: { ...Object.fromEntries(planned.map((slice) => [slice.trackId, slice.grid])), ...attempt.grids } };
}

/** Where the Lesson's Ready (R) does something: practice reps, the Check's end, or both. */
export function readyUsedIn(definition: LessonDefinition, track: LessonTrack): { readonly practice: boolean; readonly check: boolean } {
  const end = definition.planCheck(track).endWhen.kind;
  const rep = definition.practice.rep;
  const plan = definition.planCheck(track);
  return { practice: rep === "ready" || rep === "tempo-set" || rep === "tempo-ear", check: end === "ready-windows" || end === "slices-done" || end === "readies" || plan.stops !== undefined };
}

export function isBuiltLesson(id: string): id is BuiltLessonId {
  return LESSONS.some((lesson) => lesson.id === id);
}

export function lessonDefinition(id: BuiltLessonId): BuiltLesson {
  const found = LESSONS.find((lesson) => lesson.id === id);
  // Unreachable: BuiltLessonId lists exactly the ids in LESSONS.
  if (found === undefined) throw new Error(`Lesson ${id} is not built yet.`);
  return found;
}

/** The controller after these Lessons: every built Lesson's unlocks, in catalogue order. */
export function unlocksAfter(lessons: readonly LessonId[]): ReadonlySet<ControlId> {
  return new Set(LESSONS.filter((lesson) => lessons.includes(lesson.id)).flatMap((lesson) => lesson.unlocks));
}

/**
 * The controller during `definition`: `passed` Lessons' unlocks plus this Lesson's, as its hook reaches them
 * (`hookStep`), then all of them. After the hook that includes every control the hook handed over, so a
 * Lesson that unlocks nothing new (Count phrases) still has the TAP its hook used, even before the Lesson
 * that unlocks TAP is passed.
 */
export function lessonUnlocks(definition: LessonDefinition, passed: readonly LessonId[], hookStep: number | null): ReadonlySet<ControlId> {
  const steps = hookStep === null ? definition.hook : definition.hook.slice(0, hookStep + 1);
  const handed = steps.flatMap((step) => [step.control, ...(step.reveals ?? [])]);
  return new Set([...unlocksAfter(passed.filter((id) => id !== definition.id)), ...(hookStep === null ? definition.unlocks : []), ...handed]);
}

/** How an attempt is graded: a Lesson Check (the default), or another mode such as a Placement task. */
export interface Grading {
  readonly mode: CheckMode;
  readonly variant: CheckVariant;
  readonly aids: Aids;
}

export const LESSON_GRADING: Grading = { mode: "lesson", variant: "full", aids: LESSON_AIDS };

/** The TaskSpec to grade an attempt of `definition` on `track` with `plan`. */
export function checkSpecFor(
  definition: LessonDefinition,
  track: LessonTrack,
  plan: CheckPlan,
  attempt: Attempt,
  options: { readonly window: CtxSpan; readonly passedLessons: readonly LessonId[]; readonly grading?: Grading },
): TaskSpec {
  const grading = options.grading ?? LESSON_GRADING;
  const trackSetId = track.source === "synthetic" ? null : `${definition.id}-house`;
  const tracks: readonly TaskTrack[] =
    definition.taskTracks?.(track, plan, trackSetId) ?? [
      { trackId: track.trackId, trackSetId, deck: "A" },
      ...(plan.deckB === undefined ? [] : [{ trackId: trackOnDeck(track, "B").trackId, trackSetId, deck: "B" as const }]),
    ];
  // From the Check's own cue: before it, what is heard (and metered) is still the practice.
  const window = definition.gradeFromOwnCue === true ? fromOwnCue(plan, attempt, options.window) : options.window;
  return {
    mode: grading.mode,
    variant: grading.variant,
    task: definition.taskFor(track, plan, attempt, window),
    tracks,
    // A Lesson's Check offers its own aids (sync, the BPM display); another grading names all of them.
    aids: options.grading === undefined ? { ...LESSON_AIDS, ...definition.aids } : grading.aids,
    window,
    passedLessons: options.passedLessons,
  };
}
