// sync-blend's stepped blend, for one pointer (a trackpad or mouse moves one fader at a time): B to ¾,
// A to ¾ right after, both play at ¾, then B up and A down. Two tracks at full level are about +3 dB
// louder than one (more where their kicks line up), which fails the Check's loud-steady; both at ¾
// (amplitude 0.56 each, position² curve) stays within it, for tracks whose kicks line up or not. Pure:
// the Lesson session feeds it both channel faders after each of the Learner's moves.

/** The four steps, in order: the fader to move and where it goes. */
export const BLEND_STEPS = [
  { deck: "B", to: "¾" },
  { deck: "A", to: "¾" },
  { deck: "B", to: "up" },
  { deck: "A", to: "down" },
] as const;

/** ¾ on the fader, with room for a hand: 0.65–0.85 keeps a blend within loud-steady's 3 dB. */
const THREE_QUARTER: readonly [number, number] = [0.65, 0.85];
const UP = 0.9;
const DOWN = 0.05;

/** Where the two faders are, as the stepped blend sees it. */
export type BlendPose =
  /** A up, B under ¾: where a blend starts. */
  | "start"
  /** Each step's end, in order. */
  | "b-three-quarter"
  | "both-three-quarter"
  | "b-up"
  | "done"
  /** A up and B up: both full, too loud. */
  | "both-full"
  /** A under ¾ while B is not up yet: the level drops. */
  | "dip"
  /** Mid-drag between two poses. */
  | "between";

const STEP_POSES: readonly BlendPose[] = ["b-three-quarter", "both-three-quarter", "b-up", "done"];

const MISTAKES: Partial<Record<BlendPose, string>> = {
  "both-full": "Both faders full: +3 dB louder. Stop B at ¾ first.",
  dip: "A went down before B was up: the level dips. B up first.",
};

export function blendPose(a: number, b: number): BlendPose {
  const at = (value: number) => (value >= UP ? "up" : value >= THREE_QUARTER[0] && value <= THREE_QUARTER[1] ? "three-quarter" : value < THREE_QUARTER[0] ? "low" : "high");
  const [fromA, fromB] = [at(a), at(b)];
  if (fromA === "up") return fromB === "low" ? "start" : fromB === "three-quarter" ? "b-three-quarter" : fromB === "up" ? "both-full" : "between";
  if (fromA === "three-quarter") return fromB === "three-quarter" ? "both-three-quarter" : fromB === "up" ? "b-up" : fromB === "low" ? "dip" : "between";
  if (fromB === "up") return a <= DOWN ? "done" : "between";
  return fromA === "low" ? "dip" : "between";
}

export interface BlendFollow {
  /** The next step to make (0–3); 4 when the blend is done. */
  readonly next: number;
  readonly pose: BlendPose;
}

export interface BlendStepResult {
  readonly step: number;
  readonly good: boolean;
  /** What went wrong, in a few words, for a step that was not good. */
  readonly mistake: string | null;
}

export const START_BLEND: BlendFollow = { next: 0, pose: "start" };

/** The next state after the faders moved to `pose`, and a step's result when one was made or missed. */
export function followBlend(state: BlendFollow, pose: BlendPose): { state: BlendFollow; result: BlendStepResult | null } {
  if (pose === state.pose) return { state, result: null };
  if (pose === "start") return { state: START_BLEND, result: null };
  const moved = { ...state, pose };
  const mistake = MISTAKES[pose];
  if (mistake !== undefined) return { state: moved, result: state.next < BLEND_STEPS.length ? { step: state.next, good: false, mistake } : null };
  if (STEP_POSES.indexOf(pose) !== state.next) return { state: moved, result: null };
  return { state: { next: state.next + 1, pose }, result: { step: state.next, good: true, mistake: null } };
}
