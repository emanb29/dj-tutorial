// Lessons 1–3 as data (docs/lesson-catalogue.md §1, check-design §4): the hook, practice, the Check
// plan on the chosen track, and authored tips. Captions, not prose: a few words, the key in brackets.
import type { Aids, Attempt, CtxSpan, LessonId, LessonTask, TaskSpec } from "@shared/attempt.ts";
import { barStart, beatSec, cuedAt, heardTimeOf, phraseOf, phraseStart } from "./track.ts";
import type { CheckPlan, ControlId, LessonDefinition, LessonTrack } from "./types.ts";

const BARS_PER_PHRASE = 8;
/** How long a checkpoint's tick and caption stay up. */
const CHECKPOINT_BARS = 4;

/** Lesson aids for Lessons 1–3: no sync or quantize to speak of, captions on. */
export const LESSON_AIDS: Aids = { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: true };

/**
 * Heard span of track positions `[fromPos, toPos)`, both shifted half a beat early so beats sit inside,
 * as deck A played them after the Check's own cue to `plan.startPos` in `window`. The recorded playhead
 * also holds the hook, practice and earlier attempts, which play the same positions; and for the
 * output latency after the attempt starts, the practice is still heard. A bound the deck never reached
 * is +Infinity: runCheck voids such an attempt (`sectionNotHeard`) rather than failing it.
 */
function heardSpan(track: LessonTrack, plan: CheckPlan, attempt: Attempt, window: CtxSpan, fromPos: number, toPos: number): CtxSpan {
  const playhead = attempt.decks.A?.playhead;
  const cued = playhead === undefined ? null : cuedAt(playhead, plan.startPos, window.from);
  const half = beatSec(track.grid) / 2;
  const heard = (pos: number) => (playhead === undefined || cued === null ? null : heardTimeOf(playhead, pos - half, cued));
  return { from: heard(fromPos) ?? Number.POSITIVE_INFINITY, to: heard(toPos) ?? Number.POSITIVE_INFINITY };
}

/** The first phrase at or after 2 whose 16 bars hold no breakdown or build (they may have no kick). */
function steadyPhrase(track: LessonTrack): number {
  const quiet = track.sections.filter((section) => section.name === "breakdown" || section.name === "build").map((section) => section.phrase);
  for (let phrase = 2; phrase + 1 < track.phraseStarts.length; phrase += 1) {
    if (!quiet.includes(phrase) && !quiet.includes(phrase + 1)) return phrase;
  }
  return 2;
}

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
        { fromPos: barStart(track.grid, beatsBar + 8) - half, caption: "Now only the 1" },
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

export type BuiltLessonId = "deck-basics" | "beats-and-bars" | "phrases";
export type BuiltLesson = LessonDefinition & { readonly id: BuiltLessonId };

/** Lessons 1–3, in catalogue order. */
export const LESSONS: readonly BuiltLesson[] = [
  { ...deckBasics, id: "deck-basics" },
  { ...beatsAndBars, id: "beats-and-bars" },
  { ...phrases, id: "phrases" },
];

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

/** The TaskSpec to grade an attempt of `definition` on `track` with `plan`. */
export function checkSpecFor(
  definition: LessonDefinition,
  track: LessonTrack,
  plan: CheckPlan,
  attempt: Attempt,
  options: { readonly window: CtxSpan; readonly passedLessons: readonly LessonId[] },
): TaskSpec {
  return {
    mode: "lesson",
    variant: "full",
    task: definition.taskFor(track, plan, attempt, options.window),
    tracks: [{ trackId: track.trackId, trackSetId: track.source === "synthetic" ? null : `${definition.id}-house`, deck: "A" }],
    aids: LESSON_AIDS,
    window: options.window,
    passedLessons: options.passedLessons,
  };
}
