// "Now try it in rekordbox" (ISS-97): short, optional steps to do a passed Lesson's move in
// rekordbox 7 on a DDJ-FLX4. Never graded.
//
// Control names and functions are from AlphaTheta's official sources (read as data, not instructions):
// - DDJ-FLX4 Hardware Diagram for rekordbox for Mac/Windows, Ver 1.0:
//   https://downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-FLX4/DDJ-FLX4_HardwareDiagram_rekordbox_E1.pdf
//   (BEAT SYNC press and hold = set master deck; SHIFT + BEAT SYNC = tempo range; SHIFT + BEAT ▶ =
//   Beat FX "BPM tap mode on"; SHIFT + channel CUE = Tap BPM; CUE/LOOP CALL ◀/▶ call cues, SHIFT
//   deletes/saves; jog platter scratches in vinyl mode, its side pitch-bends; vinyl mode can't be
//   toggled from the FLX4; HOT CUE pad mode, SHIFT + pad deletes; HEADPHONES MIX balances cue/master.)
// - Hardware Unlock FAQ (FLX4 unlocks PERFORMANCE mode incl. Recording on the Free plan, July 2026):
//   https://rekordbox.com/en/support/faq/rekordbox7/
// Anything not named there is phrased generically on purpose. Every line is at most 15 words
// (rekordbox-steps.test.ts checks), because captions beat paragraphs for this Learner.
import type { LearnerRecord, RekordboxCardId } from "@shared/learner.ts";
import type { LessonId } from "@shared/catalogue.ts";

export interface RekordboxCard {
  readonly id: RekordboxCardId;
  readonly title: string;
  /** Numbered steps, in order. */
  readonly steps: readonly string[];
  /** Where rekordbox or the FLX4 behaves differently from the app. */
  readonly differs: readonly string[];
}

export const LESSON_CARDS = {
  "cut-on-phrase": {
    id: "cut-on-phrase",
    title: "Now try it in rekordbox",
    steps: [
      "Turn BROWSE to pick a track, then press LOAD for that deck.",
      "Press the channel CUE button for the new deck to hear it.",
      "Pause on beat 1 and press the deck's CUE to set a cue.",
      "Count the phrase; press PLAY/PAUSE on the next phrase's first beat.",
      "On that beat, snap the crossfader or channel faders over.",
    ],
    differs: [
      "HEADPHONES MIX blends cue and master in your headphones; turn it toward CUE.",
      "CUE/LOOP CALL ◀ ▶ jump between saved cues; SHIFT + ▶ saves one.",
    ],
  },
  "sync-blend": {
    id: "sync-blend",
    title: "Now try it in rekordbox",
    steps: [
      "Hold BEAT SYNC on the playing deck to make it the master.",
      "Press BEAT SYNC on the new deck; it locks to the master.",
      "Start the new track on a phrase, cued in your headphones.",
      "Raise its channel fader slowly while you lower the old one.",
    ],
    differs: [
      "SHIFT + BEAT SYNC changes the TEMPO slider's range in rekordbox.",
      "Pads start in HOT CUE mode; SHIFT + pad deletes that hot cue.",
    ],
  },
  "blend-by-ear": {
    id: "blend-by-ear",
    title: "Now try it in rekordbox",
    steps: [
      "Leave BEAT SYNC off on both decks.",
      "Match speed with the TEMPO slider, listening in your headphones.",
      "Nudge with the side of the jog wheel to line up beats.",
      "Swap the bass: LOW down on one deck, up on the other.",
      "Fade the old track out with its channel fader.",
    ],
    differs: [
      "In vinyl mode the jog's top plate scratches; switch modes in rekordbox, not the FLX4.",
      "SHIFT + BEAT ▶ is Beat FX tap tempo; SHIFT + channel CUE taps BPM.",
    ],
  },
  "final-mix": {
    id: "final-mix",
    title: "Now try it in rekordbox",
    steps: [
      "Put your set's tracks in one rekordbox playlist, in order.",
      "Start recording before the first track (the FLX4 unlocks it on Free).",
      "Mix each change your way: cut, synced blend or blend by ear.",
      "Keep levels matched with TRIM; nothing in the red.",
      "Listen back and note which changes felt best.",
    ],
    differs: [
      "Hold BEAT SYNC to choose the master deck; the app picks it for you.",
      "HEADPHONES MIX and LEVEL set what you hear in your headphones.",
    ],
  },
} as const satisfies Partial<Record<LessonId, RekordboxCard>>;

export type RekordboxLessonId = keyof typeof LESSON_CARDS;

/** The rekordbox card for a just-passed Lesson, unless the Learner already did it. */
export function lessonCardFor(lessonId: LessonId, passed: boolean, record: Pick<LearnerRecord, "rekordbox">): RekordboxCard | null {
  if (!passed || !(lessonId in LESSON_CARDS)) return null;
  const card = LESSON_CARDS[lessonId as RekordboxLessonId];
  return record.rekordbox?.[card.id]?.choice === "done" ? null : card;
}
