// Where a library preview plays: in the headphones (the cue) when the Learner's output mode has a
// headphone path of its own, so a preview never lands on the master while a deck plays; else this
// computer's default output. Pure: the plan is the engine's (src/audio/output.ts), read, never changed.
//
// - two devices: the headphone device (an `<audio>` element's own sinkId).
// - the FLX4 four-channel modes (through the FLX4, its headphones with this computer's speakers, PC
//   MASTER OUT): the FLX4's headphone jack, its outputs 3/4, through a small AudioContext of the
//   preview's own (routeToControllerPhones, as the engine's cue).
// - split cue: the default output. Its left-ear cue is a Lesson's arrangement; the library pages play
//   in stereo, and a preview in one ear would sound broken.
import type { OutputPlan } from "@audio";

export type PreviewRoute =
  | { readonly kind: "default" }
  | { readonly kind: "device"; readonly sinkId: string }
  | { readonly kind: "controller-phones"; readonly sinkId: string };

export function previewRoute(plan: OutputPlan): PreviewRoute {
  switch (plan.kind) {
    case "split-cue":
      return { kind: "default" };
    case "two-devices":
      return { kind: "device", sinkId: plan.headphoneSinkId };
    case "controller":
      return { kind: "controller-phones", sinkId: plan.sinkId };
    case "computer-and-controller-phones":
    case "dual-master":
      return { kind: "controller-phones", sinkId: plan.controllerSinkId };
  }
}
