// The phrase-context rules (owner, 2026-10-18: "It's not possible to identify a phrase in synthesized
// music from only a bar or two"; "Lesson 7 does not give enough prep time"), over every Lesson plan on
// the synthetic tracks and on every committed Original's grid and sections:
// 1. A Check and its practice start on a phrase start of deck A (the deck the Learner counts).
// 2. A whole 8-bar phrase is heard before the first phrase-timed action, and the timeout covers it.
// 3. Practice shows the 8-bar count (phrase-count.ts), unless a by-ear drill runs it.
// 4. Set-up moves (CUE, SYNC, LOW B down, ECHO on, trims …) are never asked inside the lead-in on the
//    clock: they go in the unclocked set-up step (`CheckPlan.setUp`), then R.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OriginalMetaSchema } from "@shared/originals.ts";
import { knownGridFromMeta } from "@tracks";
import fixture from "../app/lesson/rotated-originals.json";
import { LESSONS, practiceDecksFor, type BuiltLesson, type BuiltLessonId } from "./catalogue.ts";
import { barsSec } from "./plan.ts";
import { SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack } from "./synthetic-track.ts";
import { lessonTrackFromKnownGrid } from "./track.ts";
import type { CheckPlan, LessonTrack } from "./types.ts";

/** The Lessons whose Check grades something timed to a phrase (a cut, B in on the 1, a phrase tap …). */
const PHRASE_TIMED: readonly BuiltLessonId[] = [
  "phrases",
  "cut-on-phrase",
  "sync-blend",
  "crossfader",
  "eq-basics",
  "bass-swap",
  "filter-transition",
  "blend-by-ear",
  "hot-cues",
  "loop-transition",
  "echo-out",
];

/** Words of a set-up move: the Learner prepares a deck, rather than doing the timed thing itself. */
const SET_UP_MOVE = /CUE 🎧|SYNC|TRIM|trims|LOW B all the way down|ECHO on|fader B up/i;
/** A caption counting down to a phrase action stays one short line. */
const SHORT_LINE = 48;

const originals = z
  .array(OriginalMetaSchema)
  .parse(fixture)
  .map((meta) => lessonTrackFromKnownGrid({ id: meta.id, title: meta.title, attribution: { text: meta.title, url: null } }, knownGridFromMeta(meta)));
const synthetic = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), peakDbfs: -6 };
const syntheticPartner = { ...syntheticLessonTrack(SYNTHETIC_PARTNER), peakDbfs: -6 };

/** Every track the Lesson can run on, with a partner that fits when it mixes two. */
function tracksFor(lesson: BuiltLesson): LessonTrack[] {
  const mains = [synthetic, ...originals].filter((track) => lesson.trackProblems(track).length === 0);
  const pairing = lesson.partner;
  if (pairing === undefined) return mains;
  return mains.flatMap((track) => {
    const partner = [syntheticPartner, synthetic, ...originals].find((other) => pairing.problems(track, other).length === 0);
    return partner === undefined ? [] : [{ ...track, partner }];
  });
}

const isPhraseStart = (track: LessonTrack, pos: number) => track.phraseStarts.some((start) => Math.abs(start - pos) < 1e-6);
const plansOf = (lesson: BuiltLesson, track: LessonTrack): CheckPlan[] => [1, 2, 3, 4].map((attempt) => lesson.planCheck(track, attempt, LESSONS.map((each) => each.id)));

describe.each(LESSONS.map((lesson) => ({ id: lesson.id, lesson })))("$id", ({ id, lesson }) => {
  const tracks = tracksFor(lesson);
  const timed = PHRASE_TIMED.includes(id);

  it("runs on some track here", () => {
    expect(tracks.length).toBeGreaterThan(0);
  });

  it(timed ? "names its first phrase-timed action" : "has no phrase-timed action", () => {
    for (const track of tracks) for (const plan of plansOf(lesson, track)) expect(plan.firstPhraseAction !== undefined, track.trackId).toBe(timed);
  });

  if (!timed) return;

  it("starts the Check and practice on a phrase start of deck A, a whole phrase before the first phrase-timed action", () => {
    for (const track of tracks) {
      const practicePos = practiceDecksFor(lesson, track).A.pos;
      for (const plan of plansOf(lesson, track)) {
        const action = plan.firstPhraseAction ?? Number.NaN;
        const where = `${track.trackId}: Check from ${plan.startPos.toFixed(2)} s, practice from ${practicePos.toFixed(2)} s, action at ${action.toFixed(2)} s`;
        expect(isPhraseStart(track, plan.startPos), where).toBe(true);
        expect(isPhraseStart(track, practicePos), where).toBe(true);
        expect(action - plan.startPos, where).toBeGreaterThanOrEqual(barsSec(track, 8) - 1e-6);
        expect(action - practicePos, where).toBeGreaterThanOrEqual(barsSec(track, 8) - 1e-6);
        // The clock runs past the lead-in (from R, or after the stops).
        expect(plan.timeoutSec, where).toBeGreaterThan(action - plan.startPos);
      }
    }
  });

  it("shows the 8-bar count in practice (a by-ear drill runs its own rounds)", () => {
    expect(lesson.phraseCount === true).toBe(lesson.drill === undefined);
  });

  it("asks for set-up moves only off the clock, before R, never inside the lead-in", () => {
    for (const track of tracks) {
      for (const plan of plansOf(lesson, track)) {
        const action = plan.firstPhraseAction ?? Number.NaN;
        // The last 2 bars count down to the action: those captions may name it.
        const leadIn = plan.cues.filter((cue) => cue.fromPos < action - barsSec(track, 2) - 1e-6);
        expect(leadIn.filter((cue) => SET_UP_MOVE.test(cue.caption)).map((cue) => cue.caption), track.trackId).toEqual([]);
        if (plan.setUp !== undefined) expect(plan.setUp.caption).toMatch(/^Set up: .+ — then R$/);
      }
    }
  });

  it("counts down to the action in one short line", () => {
    for (const track of tracks) {
      for (const plan of plansOf(lesson, track)) {
        const action = plan.firstPhraseAction ?? Number.NaN;
        const countdown = plan.cues.filter((cue) => cue.fromPos >= action - barsSec(track, 2) - 1e-6 && cue.fromPos < action);
        for (const cue of countdown) expect(cue.caption.length <= SHORT_LINE && !cue.caption.includes("\n"), cue.caption).toBe(true);
      }
    }
  });
});

describe("Lesson 7 (Your first transition: the cut)", () => {
  const lesson = LESSONS.find((each) => each.id === "cut-on-phrase");

  it("sets up off the clock, then R; practice waits for R too", () => {
    const plan = lesson?.planCheck(synthetic);
    expect(plan?.setUp?.caption).toBe("Set up: CUE 🎧 B on, fader B up, trims matched — then R");
    expect(lesson?.practiceSetUp).toBe(true);
    expect(plan?.cues.map((cue) => cue.caption)).toContain("Next phrase: Press , and S on the 1");
  });
});
