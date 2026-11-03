// What is wrong with a Mix Plan, all of it at once, each problem with its fix. The shape is the
// schema's job (mix-plan.ts); this checks meaning: enough tracks, Transitions that fit their tracks
// and do not overlap, values in range, and beat grids that are still the ones the plan was made on.
// Complexity is advice (ISS-189) and never a problem here.
import {
  beatIndexOf,
  beatsInTrack,
  CONTROL_RANGES,
  ECHO_BEATS,
  GAIN_DB_RANGE,
  gridHashOf,
  LOOP_BEATS,
  type Lane,
  type MixPlan,
  type PlanGrid,
} from "./mix-plan.ts";

export type MixPlanProblemKind =
  | "no-name"
  | "too-few-tracks"
  | "transition-count"
  | "grid-changed"
  | "starts-before-track"
  | "overlap"
  | "past-track-end"
  | "bad-length"
  | "duplicate-lane"
  | "keyframe-outside"
  | "keyframes-out-of-order"
  | "value-out-of-range"
  | "lane-length";

export interface MixPlanProblem {
  readonly kind: MixPlanProblemKind;
  /** 0-based, where the problem is; the text counts from 1 as the screen does. */
  readonly track?: number;
  readonly transition?: number;
  readonly message: string;
  readonly fix: string;
}

/** The longest Transition, beats (64 bars): longer is almost surely a typo. */
export const MAX_TRANSITION_BEATS = 256;
/** Floating-point slack on "past the end". */
const EPSILON = 1e-6;

const beats = (count: number) => `${String(Math.round(count * 100) / 100)} beat${count === 1 ? "" : "s"}`;
const laneName = (lane: Lane) => `the ${lane.track} track's ${lane.param} lane`;

/**
 * Every problem with `plan`. `grids` holds the current beat grid of each track found on this device,
 * by content hash; a track without one (not found yet, or not analysed) skips the checks against its end.
 */
export function mixPlanProblems(plan: MixPlan, grids: ReadonlyMap<string, PlanGrid>): MixPlanProblem[] {
  const problems: MixPlanProblem[] = [];
  const add = (problem: MixPlanProblem) => {
    problems.push(problem);
  };
  const { tracks, transitions } = plan;

  if (plan.name.trim() === "") add({ kind: "no-name", message: "The plan has no name.", fix: "Give it a name." });
  if (tracks.length < 2) {
    add({
      kind: "too-few-tracks",
      message: `A plan needs at least 2 tracks; this one has ${String(tracks.length)}.`,
      fix: "Pick more tracks from the library.",
    });
  }
  if (tracks.length >= 1 && transitions.length !== tracks.length - 1) {
    add({
      kind: "transition-count",
      message: `${String(tracks.length)} tracks need ${String(tracks.length - 1)} Transitions; the plan has ${String(transitions.length)}.`,
      fix: "Add or remove Transitions so there is one between each pair of tracks.",
    });
  }

  tracks.forEach((track, index) => {
    const n = String(index + 1);
    if (track.gainDb < GAIN_DB_RANGE.min || track.gainDb > GAIN_DB_RANGE.max) {
      add({
        kind: "value-out-of-range",
        track: index,
        message: `Track ${n}'s level match is ${String(track.gainDb)} dB, outside ${String(GAIN_DB_RANGE.min)} to +${String(GAIN_DB_RANGE.max)} dB.`,
        fix: "Set it inside that range.",
      });
    }
    const grid = grids.get(track.contentHash);
    if (grid === undefined) return;
    if (gridHashOf(grid) !== track.gridHash) {
      const affected = [index - 1, index].filter((each) => each >= 0 && each < transitions.length).map((each) => String(each + 1));
      add({
        kind: "grid-changed",
        track: index,
        message: `Track ${n} was re-analysed: its beat grid is not the one the plan was made on.`,
        fix: affected.length === 0 ? "Check where it starts." : `Check Transition${affected.length > 1 ? "s" : ""} ${affected.join(" and ")}.`,
      });
    }
    if (beatIndexOf(track.startAt) > beatsInTrack(grid) + EPSILON) {
      add({ kind: "past-track-end", track: index, message: `Track ${n} starts after it ends.`, fix: "Pick an earlier start." });
    }
  });

  transitions.forEach((transition, index) => {
    const n = String(index + 1);
    const outgoing = tracks[index];
    const incoming = tracks[index + 1];
    const { lengthBeats } = transition;
    const lengthOk = lengthBeats > 0 && lengthBeats <= MAX_TRANSITION_BEATS;
    if (!lengthOk) {
      add({
        kind: "bad-length",
        transition: index,
        message: `Transition ${n} is ${beats(lengthBeats)} long; it must be more than 0 and at most ${String(MAX_TRANSITION_BEATS / 4)} bars.`,
        fix: "Set a length inside that range.",
      });
    }
    const outgoingStart = beatIndexOf(transition.outgoingAt);
    // Where the outgoing track took the lead: the set's start, or the end of the Transition that brought it in.
    const previous = transitions[index - 1];
    const leadFrom = previous === undefined ? (outgoing === undefined ? 0 : beatIndexOf(outgoing.startAt)) : beatIndexOf(previous.incomingAt) + previous.lengthBeats;
    if (outgoingStart < leadFrom - EPSILON) {
      add(
        previous === undefined
          ? {
              kind: "starts-before-track",
              transition: index,
              message: `Transition 1 starts ${beats(leadFrom - outgoingStart)} before track 1 does.`,
              fix: "Move it later, or start track 1 earlier.",
            }
          : {
              kind: "overlap",
              transition: index,
              message: `Transition ${n} starts ${beats(leadFrom - outgoingStart)} before Transition ${String(index)} has finished.`,
              fix: `Move Transition ${n} later, or shorten Transition ${String(index)}.`,
            },
      );
    }
    const ends: readonly [typeof outgoing, number, string, string][] = [
      [outgoing, outgoingStart, `track ${n}`, "Start it earlier, or shorten it."],
      [incoming, beatIndexOf(transition.incomingAt), `track ${String(index + 2)}`, "Pick an earlier cue in that track, or shorten the Transition."],
    ];
    for (const [track, from, which, fix] of ends) {
      const grid = track === undefined ? undefined : grids.get(track.contentHash);
      if (grid === undefined || !lengthOk) continue;
      const over = from + lengthBeats - beatsInTrack(grid);
      if (over > EPSILON) {
        add({
          kind: "past-track-end",
          transition: index,
          message: `Transition ${n} runs ${beats(over)} past the end of ${which}.`,
          fix,
        });
      }
    }
    for (const problem of laneProblems(transition.lanes, lengthOk ? lengthBeats : Infinity, n)) add({ ...problem, transition: index });
  });

  return problems;
}

function laneProblems(lanes: readonly Lane[], lengthBeats: number, n: string): Omit<MixPlanProblem, "transition">[] {
  const problems: Omit<MixPlanProblem, "transition">[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    const key = `${lane.track}|${lane.param}`;
    if (seen.has(key)) {
      problems.push({
        kind: "duplicate-lane",
        message: `Transition ${n} has ${laneName(lane)} twice.`,
        fix: "Merge their keyframes into one lane.",
      });
    }
    seen.add(key);
    const setting = lane.param === "echo-send" ? { name: "echo", value: lane.echoBeats, allowed: ECHO_BEATS } : lane.param === "loop" ? { name: "loop", value: lane.loopBeats, allowed: LOOP_BEATS } : null;
    if (setting !== null && (setting.value === undefined || !setting.allowed.includes(setting.value))) {
      problems.push({
        kind: "lane-length",
        message: `Transition ${n}: ${laneName(lane)} needs a ${setting.name} length${setting.value === undefined ? "" : `, not ${beats(setting.value)}`}.`,
        fix: `Pick one of ${setting.allowed.join(", ")} beats.`,
      });
    }
    const range = CONTROL_RANGES[lane.param];
    lane.keyframes.forEach((keyframe, index) => {
      const where = `Transition ${n}, ${laneName(lane)}, keyframe ${String(index + 1)}`;
      if (keyframe.beat < -EPSILON || keyframe.beat > lengthBeats + EPSILON) {
        problems.push({
          kind: "keyframe-outside",
          message: `${where} is at beat ${String(keyframe.beat)}, outside the Transition (0 to ${String(lengthBeats)}).`,
          fix: "Move it inside, or lengthen the Transition.",
        });
      }
      const before = lane.keyframes[index - 1];
      if (before !== undefined && keyframe.beat < before.beat) {
        problems.push({
          kind: "keyframes-out-of-order",
          message: `${where} (beat ${String(keyframe.beat)}) comes before the keyframe ahead of it (beat ${String(before.beat)}).`,
          fix: "Put the keyframes in beat order.",
        });
      }
      const inRange = keyframe.value >= range.min && keyframe.value <= range.max && (lane.param !== "loop" || keyframe.value === 0 || keyframe.value === 1);
      if (!inRange) {
        problems.push({
          kind: "value-out-of-range",
          message: `${where} is ${String(keyframe.value)}, outside ${lane.param === "loop" ? "0 (off) or 1 (on)" : `${String(range.min)} to ${String(range.max)}`}.`,
          fix: "Set a value inside the range.",
        });
      }
    });
  }
  return problems;
}
