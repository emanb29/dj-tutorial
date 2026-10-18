// Lessons 17–19 as data (docs/lesson-catalogue.md §1, check-design §4): hot cues, the loop transition
// and the echo out. Captions, not prose: a few words, the key in brackets. All three play one track;
// loop-transition and echo-out bring the same track in on deck B from another phrase.
import type { LessonTask } from "@shared/attempt.ts";
import { barsSec, steadyPhrase } from "./plan.ts";
import { barStart, beatSec, cuedAt, phraseOf, phraseStart } from "./track.ts";
import type { CheckPlan, DeckSetups, LessonDefinition, LessonTrack, LoopPlan } from "./types.ts";

const EMPTY_PADS: readonly null[] = Array.from({ length: 8 }, () => null);
/** The track's groove (kick and bass): the named section, else the first steady phrase. */
const groovePhrase = (track: LessonTrack) => phraseOf(track.sections, "groove") ?? steadyPhrase(track);
const phrasesNeeded = (track: LessonTrack, last: number) =>
  track.phraseStarts.length < last + 1 ? [`The track is too short: this Lesson plays up to phrase ${String(last + 1)}.`] : [];

// ---------------------------------------------------------------------------------------------
// Lesson 17: hot-cues
// ---------------------------------------------------------------------------------------------

/** The phrases the three pads hold, in pad order (drop, groove, outro), and the run the triggers start from. */
function hotCuePhrases(track: LessonTrack): { readonly pads: readonly [number, number, number]; readonly lead: number } {
  const groove = groovePhrase(track);
  const last = track.phraseStarts.length;
  const drop = phraseOf(track.sections, "drop", groove + 1) ?? Math.min(groove + 4, last - 2);
  const outro = phraseOf(track.sections, "outro", drop + 1) ?? Math.max(drop + 1, last - 1);
  return { pads: [drop, groove, outro], lead: groove };
}

/** Bars of A before the first trigger: count in to the groove's phrase start. */
const HOT_CUE_LEAD_BARS = 4;
/** Each stop sits this many beats before its phrase start: jog to the 1 (cue-point's leads). */
const STOP_LEADS_BEATS = [1.37, 2.62, 0.71] as const;
const HOT_CUE_TAIL_BARS = 2;
/** Practice: pad 1 holds the drop; A plays from 4 bars before the groove and goes round 4 bars into the drop. */
const PRACTICE_DROP_BARS = 4;

function hotCueDecks(track: LessonTrack): DeckSetups {
  const { pads, lead } = hotCuePhrases(track);
  const hotCues = EMPTY_PADS.map((_, index) => (index === 0 ? phraseStart(track.grid, pads[0]) : null));
  return { A: { pos: phraseStart(track.grid, lead) - barsSec(track, HOT_CUE_LEAD_BARS), fader: 1, play: true, hotCues } };
}

const hotCueLoop = (track: LessonTrack): LoopPlan => ({
  atPos: phraseStart(track.grid, hotCuePhrases(track).pads[0]) + barsSec(track, PRACTICE_DROP_BARS),
  reset: "setup",
});

const hotCues: LessonDefinition = {
  id: "hot-cues",
  title: "Hot cues",
  unlocks: ["A.hot-cue", "B.hot-cue"],
  practiceStart: (track) => hotCueDecks(track).A.pos,
  practiceDecks: hotCueDecks,
  practiceLoop: hotCueLoop,
  // From the Check's own cue to the first stop: before it, the practice is still heard (and metered).
  gradeFromOwnCue: true,
  trackProblems: (track) => phrasesNeeded(track, Math.max(...hotCuePhrases(track).pads)),
  hook: [
    { caption: "Press 2: pad 2 keeps this spot", control: "A.hot-cue", trigger: { kind: "hot-cue-set" }, named: "Pad 2 lit: it holds that spot. A hot cue." },
    { caption: "Press 2 again", control: "A.hot-cue", trigger: { kind: "hot-cue-trigger" }, named: "Back to the spot, at once, playing. Shift + pad clears it." },
  ],
  practice: { caption: "Pad 1 is the drop: Press 1 on a phrase's 1", rep: "hot-cue-trigger", window: 3, needed: 2 },
  checkCaption: "This one counts: set 3 pads on phrase starts, then jump on each phrase's 1",
  questions: [],
  planCheck: (track): CheckPlan => {
    const { pads, lead } = hotCuePhrases(track);
    const beat = beatSec(track.grid);
    const startPos = phraseStart(track.grid, lead) - barsSec(track, HOT_CUE_LEAD_BARS);
    return {
      startPos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { hotCues: EMPTY_PADS },
      stops: pads.map((phrase, index) => phraseStart(track.grid, phrase) - (STOP_LEADS_BEATS[index] ?? 1) * beat),
      endWhen: { kind: "did-then", what: { kind: "hot-cue-trigger" }, count: pads.length, bars: HOT_CUE_TAIL_BARS },
      // Up to a minute to set the pads, then the lead, two phrases and the tail.
      timeoutSec: 60 + barsSec(track, HOT_CUE_LEAD_BARS + 16 + HOT_CUE_TAIL_BARS) + 5,
      readyCues: [
        "Pad 1: jog to this phrase's 1 (hold Z to check), Press 1, then R",
        "Pad 2: jog to the 1, Press 2, then R",
        "Pad 3: jog to the 1, Press 3, then R",
      ],
      cues: [
        { fromPos: startPos, caption: "Count the bars. Next phrase's 1: Press 1" },
      ],
      stepCues: [
        { after: { kind: "hot-cue-trigger" }, caption: "Count 8 bars. Next phrase's 1: Press 2" },
        { after: { kind: "hot-cue-trigger" }, caption: "Count 8 bars. Next phrase's 1: Press 3" },
        { after: { kind: "hot-cue-trigger" }, caption: "Let it ride" },
      ],
    };
  },
  taskFor: (_track, plan, attempt, window): LessonTask => {
    // The pads are set while A waits paused, until the Check cues A to its start and plays. Earlier cues to
    // the same position (the hook and practice start there too) are before this attempt's window.
    const playhead = attempt.decks.A?.playhead;
    const cued = playhead === undefined ? null : cuedAt(playhead, plan.startPos, window.from);
    const split = cued === null ? window.to : Math.min(cued, window.to);
    return {
      lessonId: "hot-cues",
      placeSection: { from: window.from, to: split },
      triggerSection: { from: split, to: window.to },
      slots: (plan.stops ?? []).map((_, index) => index + 1),
    };
  },
  tips: {
    "hot-cues.hc-place": ["Jog to the kick on the 1, hold Z to check, then the pad.", "Set the pad while paused, right on the 1: no guessing."],
    "hot-cues.hc-trigger": ["Count 8 bars on the 1s, then the pad on the next 1.", "Press on the 1, not after it: the jump is instant."],
  },
};

// ---------------------------------------------------------------------------------------------
// Lesson 18: loop-transition
// ---------------------------------------------------------------------------------------------

const LOOP_LEAD_BARS = 4;
const LOOP_BARS = 4;
const LOOP_TAIL_BARS = 2;

/** A's last phrase (the outro) is looped from its start; B comes in from the groove. */
function loopPhrases(track: LessonTrack): { readonly loop: number; readonly cueB: number } {
  const groove = groovePhrase(track);
  return { loop: phraseOf(track.sections, "outro", groove + 1) ?? Math.max(groove + 1, track.phraseStarts.length - 2), cueB: groove };
}

function loopDecks(track: LessonTrack): DeckSetups {
  const { loop, cueB } = loopPhrases(track);
  return {
    A: { pos: phraseStart(track.grid, loop) - barsSec(track, LOOP_LEAD_BARS), fader: 1, play: true },
    B: { pos: phraseStart(track.grid, cueB), fader: 1, play: false, cuePoint: true },
  };
}

const loopTransition: LessonDefinition = {
  id: "loop-transition",
  title: "Loop to buy time",
  unlocks: ["A.loop-in", "A.loop-out", "A.loop-exit", "B.loop-in", "B.loop-out", "B.loop-exit"],
  practiceStart: (track) => loopDecks(track).A.pos,
  practiceDecks: loopDecks,
  practiceLoop: (track) => ({ atPos: phraseStart(track.grid, loopPhrases(track).loop) + barsSec(track, 2 * LOOP_BARS + 2), reset: "setup" }),
  headphones: true,
  trackProblems: (track) => phrasesNeeded(track, loopPhrases(track).loop),
  hook: [
    { caption: "Press G: a 4-beat loop", control: "A.loop-exit", trigger: { kind: "loop-on" }, named: "4 BEAT: one bar, round and round." },
    { caption: "Press G again: EXIT", control: "A.loop-exit", trigger: { kind: "loop-exit" }, named: "EXIT: the track plays on." },
    { caption: "LOOP IN on a 1 (D)", control: "A.loop-in", trigger: { kind: "loop-in" }, named: "IN marks where the loop starts." },
    { caption: "LOOP OUT on a 1, 4 bars on (F)", control: "A.loop-out", trigger: { kind: "loop-on" }, named: "OUT closes it: a 4-bar loop. Shift + OUT doubles it." },
  ],
  practice: { caption: "LOOP IN on the phrase's 1 (D), LOOP OUT 4 bars on (F), then EXIT (G)", rep: "loop", window: 2, needed: 1 },
  checkCaption: "This one counts: loop A's last phrase, Press , on the loop's 1, EXIT on a 1",
  questions: [],
  planCheck: (track): CheckPlan => {
    const decks = loopDecks(track);
    const loopPos = phraseStart(track.grid, loopPhrases(track).loop);
    const beat = beatSec(track.grid);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false },
      ...(decks.B === undefined ? {} : { deckB: { ...decks.B, headphoneCue: false } }),
      endWhen: { kind: "faded-out-then", deck: "A", bars: LOOP_TAIL_BARS },
      timeoutSec: barsSec(track, LOOP_LEAD_BARS + 4 * LOOP_BARS + LOOP_TAIL_BARS) + 10,
      cues: [
        { fromPos: decks.A.pos, caption: "CUE 🎧 B on. Next phrase's 1: LOOP IN (D)" },
        { fromPos: loopPos + beat, caption: "Count 4 bars: LOOP OUT on the 1 (F)" },
      ],
      stepCues: [
        { after: { kind: "loop-on" }, caption: "Looping. On the loop's 1: Press ," },
        { after: { kind: "play", deck: "B" }, caption: "Next loop's 1: EXIT (G)" },
        { after: { kind: "loop-exit" }, caption: "Fader A down (S)" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "loop-transition" }),
  gradeFromOwnCue: true,
  tips: {
    "loop-transition.loop-length": ["LOOP OUT exactly 4 bars after IN, on the 1.", "Or 4 BEAT on the 1, then Shift + OUT twice: 4 bars, exact."],
    "loop-transition.loop-in": ["LOOP IN right on the phrase's 1."],
    "loop-transition.loop-exit": ["EXIT on the loop's 1: count the bars round."],
    "loop-transition.loop-entry": ["Press , on the loop's 1, while A loops."],
    "loop-transition.no-double": ["One tap per button: a second one stutters."],
  },
};

// ---------------------------------------------------------------------------------------------
// Lesson 19: echo-out
// ---------------------------------------------------------------------------------------------

/** A plays 6 bars of its groove phrase; the cut is on the phrase's last bar; B comes in on the drop. */
const ECHO_FROM_BAR = 3;
const ECHO_TAIL_BARS = 6;
const ECHO_SETUP = { channel: "A", beats: 1, depth: 0.7, on: false } as const;

function echoPhrases(track: LessonTrack): { readonly phrase: number; readonly cueB: number } {
  const phrase = groovePhrase(track);
  return { phrase, cueB: phraseOf(track.sections, "drop", phrase + 1) ?? phrase + 1 };
}

function echoDecks(track: LessonTrack): DeckSetups {
  const { phrase, cueB } = echoPhrases(track);
  const first = (phrase - 1) * 8 + 1;
  return {
    A: { pos: barStart(track.grid, first + ECHO_FROM_BAR - 1), fader: 1, play: true },
    B: { pos: phraseStart(track.grid, cueB), fader: 1, play: false, cuePoint: true },
    beatFx: ECHO_SETUP,
  };
}

const echoOut: LessonDefinition = {
  id: "echo-out",
  title: "The echo out",
  unlocks: ["beat-fx-select", "beat-fx-channel", "beat-fx-beat", "beat-fx-depth", "beat-fx-on"],
  practiceStart: (track) => echoDecks(track).A.pos,
  practiceDecks: (track) => {
    const { A, beatFx } = echoDecks(track);
    return { A, ...(beatFx === undefined ? {} : { beatFx }) };
  },
  practiceLoop: (track) => ({ atPos: phraseStart(track.grid, echoPhrases(track).phrase + 1), reset: "setup" }),
  headphones: true,
  trackProblems: (track) => phrasesNeeded(track, echoPhrases(track).cueB),
  hook: [
    {
      caption: "Press V: BEAT FX on",
      control: "beat-fx-on",
      trigger: { kind: "beat-fx-on" },
      named: "ECHO: each beat repeats, fading. CH 1 = deck A.",
      reveals: ["beat-fx-select", "beat-fx-channel"],
    },
    { caption: "Turn DEPTH", control: "beat-fx-depth", trigger: { kind: "touch", control: "beat-fx-depth" }, named: "DEPTH: how loud the echoes are." },
    { caption: "Press ] for longer echoes", control: "beat-fx-beat", trigger: { kind: "touch", control: "beat-fx-beat" }, named: "BEAT: the gap between echoes, in beats." },
    { caption: "Pull the fader down (S)", control: "A.channel-fader", trigger: { kind: "fader-down" }, named: "The echoes ring on after the fader: an echo out." },
  ],
  practice: { caption: "ECHO on (V), cut A on a 1 (S), then FX off (V)", rep: "echo-cut", window: 2, needed: 1 },
  checkCaption: "This one counts: ECHO on, cut A on the last bar's 1, Press , on the phrase's 1",
  questions: [],
  planCheck: (track): CheckPlan => {
    const decks = echoDecks(track);
    const next = phraseStart(track.grid, echoPhrases(track).phrase + 1);
    const beat = beatSec(track.grid);
    return {
      startPos: decks.A.pos,
      autoPlay: true,
      faderAtStart: 1,
      deckA: { headphoneCue: false },
      ...(decks.B === undefined ? {} : { deckB: { ...decks.B, headphoneCue: false } }),
      beatFx: ECHO_SETUP,
      endWhen: { kind: "did-then", what: { kind: "play", deck: "B" }, count: 1, bars: ECHO_TAIL_BARS },
      timeoutSec: barsSec(track, 8 - ECHO_FROM_BAR + 1 + ECHO_TAIL_BARS) + 8,
      cues: [
        { fromPos: decks.A.pos, caption: "CUE 🎧 B on. ECHO on (V)" },
        { fromPos: next - barsSec(track, 2), caption: "Next bar is the last: cut A on its 1 (S)" },
        { fromPos: next - barsSec(track, 1) + beat, caption: "Phrase's 1: Press ," },
        { fromPos: next + beat, caption: "Echo gone? FX off (V)" },
      ],
    };
  },
  taskFor: (): LessonTask => ({ lessonId: "echo-out" }),
  gradeFromOwnCue: true,
  tips: {
    "echo-out.echo-cut": ["ECHO on first (V), then cut A right on the 1 (S).", "CH 1 lit: the echo takes deck A."],
    "echo-out.echo-entry": ["Count on through the echoes: Press , on the phrase's 1.", "The echoes keep the beat: B goes on the next 1 of the phrase."],
    "echo-out.fx-off": ["When the echoes stop, FX off (V).", "Leave FX on and the next track echoes too."],
  },
};

export type PerformanceLessonId = "hot-cues" | "loop-transition" | "echo-out";

/** Lessons 17–19, in catalogue order. */
export const PERFORMANCE_LESSONS: readonly (LessonDefinition & { readonly id: PerformanceLessonId })[] = [
  { ...hotCues, id: "hot-cues" },
  { ...loopTransition, id: "loop-transition" },
  { ...echoOut, id: "echo-out" },
];

/** Where the hot-cues Lesson puts its pads (1-based phrases, in pad order). */
export const hotCuePadPhrases = (track: LessonTrack): readonly number[] => hotCuePhrases(track).pads;
