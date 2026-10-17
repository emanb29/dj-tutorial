// The one-time headphones check before the first headphone-cue Lesson. Split cue puts the cue in the
// left ear and the master in the right; it only works in stereo headphones, worn the right way round,
// with the OS not folding stereo to mono (macOS: Accessibility › Audio › "Play stereo audio as mono").
// A click in one ear at a time, and "which ear was it in?", finds all three. Pure; the component plays
// the clicks.
import type { LessonDefinition } from "@lessons";
import type { LearnerRecord } from "@shared/learner.ts";

export type Ear = "left" | "right";

export type HeadphonesStep =
  | { readonly kind: "plug-in" }
  /** A click is playing in `ear`; which ear did the Learner hear it in? */
  | { readonly kind: "ear"; readonly ear: Ear }
  /** Heard in both ears: the OS plays stereo as mono. */
  | { readonly kind: "mono" }
  /** Heard in the other ear: the headphones are on the wrong way round. */
  | { readonly kind: "swapped" }
  | { readonly kind: "passed" };

export type HeadphonesEvent =
  | { readonly type: "plugged-in" }
  | { readonly type: "heard"; readonly ear: Ear | "both" }
  | { readonly type: "retry" };

export const HEADPHONES_START: HeadphonesStep = { kind: "plug-in" };

export function headphonesCheck(step: HeadphonesStep, event: HeadphonesEvent): HeadphonesStep {
  switch (event.type) {
    case "plugged-in":
      return step.kind === "plug-in" ? { kind: "ear", ear: "left" } : step;
    case "retry":
      return step.kind === "mono" || step.kind === "swapped" ? { kind: "ear", ear: "left" } : step;
    case "heard":
      if (step.kind !== "ear") return step;
      if (event.ear === "both") return { kind: "mono" };
      if (event.ear !== step.ear) return { kind: "swapped" };
      return step.ear === "left" ? { kind: "ear", ear: "right" } : { kind: "passed" };
  }
}

/** The check runs once per Learner, before the first Lesson that uses the headphone cue. */
export function needsHeadphonesCheck(definition: Pick<LessonDefinition, "headphones">, learner: LearnerRecord): boolean {
  return definition.headphones === true && learner.headphones == null;
}
