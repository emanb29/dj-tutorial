// The line on the result card when a Check didn't count: why, and what to do about it.
import type { LessonPhase } from "@lessons";

type VoidPhase = Extract<LessonPhase, { kind: "void" }>;

const NOT_GRADED_BECAUSE = {
  contextSuspended: "the sound stopped",
  tabHidden: "the tab was hidden",
  gridUntrusted: "this track's beat grid is too uneven to grade",
  abandoned: "it was left early",
  sectionNotHeard: "the deck never played all of the part being graded. Let the music run until the Check ends by itself, then go again",
  recordingFailed: "it could not be recorded",
} as const;

export function voidLine(reason: VoidPhase["reason"], message: string | null): string {
  if (reason === "profileRefused") {
    // The attempt was recorded and graded; storing it failed. The app's bug, not the Learner's mix.
    return `This one was graded, but your profile refused to store it, so it doesn't count yet. That's the app's fault, not your mix. Reload the page and go again; if it happens again, report this: ${message ?? "no details"}.`;
  }
  return `Not graded: ${NOT_GRADED_BECAUSE[reason]}.${message === null ? "" : ` ${message}`}`;
}
