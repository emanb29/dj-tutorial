// What an edit in the Mix Editor does to a Mix Plan: one pure function from a plan and an action to the
// next plan. Untouched Transitions keep their identity, so the per-Transition derivations (Execution
// plan, Complexity rating) memoised on them are not recomputed: a 25-track set stays quick.
//
// The editor never blocks a design: it keeps values in their lane's range and keyframes between their
// neighbours (so their order, and the selection, never jump), and leaves everything else to validation,
// which says what is wrong and how to fix it.
import { RECIPES, transitionFromRecipe, type PickedTrack, type TrackTempos } from "@shared/mix-plan-recipes.ts";
import { MAX_TRANSITION_BEATS } from "@shared/mix-plan-validate.ts";
import {
  BEATS_PER_BAR,
  CONTROL_RANGES,
  gridHashOf,
  lastPhraseStartFitting,
  phraseStart,
  restingValue,
  type Keyframe,
  type Lane,
  type LaneParam,
  type MixPlan,
  type PlanGrid,
  type PlanTrack,
  type RecipeId,
  type Transition,
} from "@shared/mix-plan.ts";
import { laneTimeline, valueAt, type LaneTrack } from "./lanes.ts";

export type EditorAction =
  | { readonly kind: "rename"; readonly name: string }
  | { readonly kind: "recipe"; readonly transition: number; readonly recipe: RecipeId }
  /** Where the Transition starts on the outgoing track, by phrase (1-based). */
  | { readonly kind: "start-phrase"; readonly transition: number; readonly phrase: number }
  /** What of the incoming track is heard as the Transition starts, by phrase (1-based). */
  | { readonly kind: "incoming-phrase"; readonly transition: number; readonly phrase: number }
  | { readonly kind: "length"; readonly transition: number; readonly lengthBeats: number }
  | { readonly kind: "move-keyframe"; readonly transition: number; readonly lane: number; readonly keyframe: number; readonly beat: number; readonly value: number }
  /** A keyframe at `beat`, at the lane's value there. */
  | { readonly kind: "add-keyframe"; readonly transition: number; readonly lane: number; readonly beat: number }
  | { readonly kind: "remove-keyframe"; readonly transition: number; readonly lane: number; readonly keyframe: number }
  | { readonly kind: "curve"; readonly transition: number; readonly lane: number; readonly keyframe: number; readonly curve: Keyframe["curve"] }
  | { readonly kind: "add-lane"; readonly transition: number; readonly track: LaneTrack; readonly param: LaneParam }
  | { readonly kind: "remove-lane"; readonly transition: number; readonly lane: number }
  /** A track after track `after` (0-based), with a Transition out of it. */
  | { readonly kind: "insert-track"; readonly after: number; readonly picked: PickedTrack }
  | { readonly kind: "remove-track"; readonly track: number };

/** The current beat grids of the plan's tracks found on this device, by content hash. */
export type EditorGrids = ReadonlyMap<string, PlanGrid>;

/** The recipe a new Transition gets (the long blend), as newMixPlan's default. */
export const DEFAULT_RECIPE: RecipeId = "crossfade-16";
const DEFAULT_ECHO_BEATS = 1;
const DEFAULT_LOOP_BEATS = BEATS_PER_BAR;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Where a keyframe at `beat` goes in `lane` (after any already at that beat). */
export function insertionIndex(lane: Lane, beat: number): number {
  const index = lane.keyframes.findIndex((keyframe) => keyframe.beat > beat);
  return index === -1 ? lane.keyframes.length : index;
}

/** Both tracks' BPMs for Transition `index`, from their grids; undefined when either is not found here. */
export function tempos(plan: MixPlan, index: number, grids: EditorGrids): TrackTempos | undefined {
  const outgoing = grids.get(plan.tracks[index]?.contentHash ?? "");
  const incoming = grids.get(plan.tracks[index + 1]?.contentHash ?? "");
  return outgoing === undefined || incoming === undefined ? undefined : { outgoing: outgoing.bpm, incoming: incoming.bpm };
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  return items.map((each, at) => (at === index ? item : each));
}

function inRange(param: LaneParam, value: number): number {
  const range = CONTROL_RANGES[param];
  const kept = clamp(value, range.min, range.max);
  return param === "loop" ? Math.round(kept) : kept;
}

/** The lane's keyframes with one changed; the Transition becomes custom (it is no longer the recipe). */
function withLane(transition: Transition, laneIndex: number, change: (lane: Lane) => Lane): Transition {
  const lane = transition.lanes[laneIndex];
  if (lane === undefined) return transition;
  return { ...transition, recipe: "custom", lanes: replaceAt(transition.lanes, laneIndex, change(lane)) };
}

function moveKeyframe(transition: Transition, laneIndex: number, keyframeIndex: number, beat: number, value: number): Transition {
  return withLane(transition, laneIndex, (lane) => {
    const keyframe = lane.keyframes[keyframeIndex];
    if (keyframe === undefined) return lane;
    const earliest = lane.keyframes[keyframeIndex - 1]?.beat ?? 0;
    const latest = lane.keyframes[keyframeIndex + 1]?.beat ?? transition.lengthBeats;
    const moved: Keyframe = { ...keyframe, beat: clamp(beat, earliest, latest), value: inRange(lane.param, value) };
    return { ...lane, keyframes: replaceAt(lane.keyframes, keyframeIndex, moved) };
  });
}

function addKeyframe(transition: Transition, laneIndex: number, beat: number): Transition {
  return withLane(transition, laneIndex, (lane) => {
    const at = clamp(beat, 0, transition.lengthBeats);
    const timeline = laneTimeline(lane);
    const value = timeline === null ? (lane.keyframes[0]?.value ?? 0) : (valueAt(timeline.keyframes, at) ?? 0);
    const index = insertionIndex(lane, at);
    const keyframe: Keyframe = { beat: at, value: inRange(lane.param, value), curve: lane.param === "loop" || lane.param === "echo-send" ? "jump" : "linear" };
    return { ...lane, keyframes: [...lane.keyframes.slice(0, index), keyframe, ...lane.keyframes.slice(index)] };
  });
}

/** A new lane, resting at both ends so there is something to drag. A tempo lane holds the tempo the tracks are matched at. */
function newLane(transition: Transition, track: LaneTrack, param: LaneParam, matchedBpm: number | undefined): Lane {
  const rest = param === "tempo" ? (matchedBpm ?? 120) : restingValue(track, param);
  const ends: Keyframe[] = [
    { beat: 0, value: rest, curve: "jump" },
    { beat: transition.lengthBeats, value: rest, curve: param === "loop" || param === "echo-send" ? "jump" : "linear" },
  ];
  const extra = param === "echo-send" ? { echoBeats: DEFAULT_ECHO_BEATS } : param === "loop" ? { loopBeats: DEFAULT_LOOP_BEATS } : {};
  return { track, param, keyframes: ends, ...extra };
}

function setLength(transition: Transition, wanted: number, trackTempos: TrackTempos | undefined): Transition {
  const lengthBeats = clamp(Math.round(wanted), BEATS_PER_BAR, MAX_TRANSITION_BEATS);
  if (transition.recipe !== "custom") {
    return transitionFromRecipe(transition.recipe, { outgoingAt: transition.outgoingAt, incomingAt: transition.incomingAt, lengthBeats, ...(trackTempos === undefined ? {} : { tempos: trackTempos }) });
  }
  const scale = lengthBeats / transition.lengthBeats;
  const lanes = transition.lanes.map((lane) => ({ ...lane, keyframes: lane.keyframes.map((keyframe) => ({ ...keyframe, beat: keyframe.beat * scale })) }));
  return { ...transition, lengthBeats, lanes };
}

function editTransition(plan: MixPlan, index: number, change: (transition: Transition) => Transition): MixPlan {
  const transition = plan.transitions[index];
  if (transition === undefined) return plan;
  return { ...plan, transitions: replaceAt(plan.transitions, index, change(transition)) };
}

function planTrack(picked: PickedTrack): PlanTrack {
  return { ...picked.track, source: "local", gridHash: gridHashOf(picked.grid), startAt: { bar: 1, beat: 1 }, gainDb: 0 };
}

/** A default Transition out of a newly placed track: on its last phrase the recipe fits in. */
function transitionOutOf(picked: PickedTrack, incomingAt: Transition["incomingAt"], incomingBpm: number | undefined): Transition {
  const { lengthBeats } = RECIPES[DEFAULT_RECIPE];
  return transitionFromRecipe(DEFAULT_RECIPE, {
    outgoingAt: lastPhraseStartFitting(picked.grid, lengthBeats) ?? { bar: 1, beat: 1 },
    incomingAt,
    tempos: { outgoing: picked.grid.bpm, incoming: incomingBpm ?? picked.grid.bpm },
  });
}

function insertTrack(plan: MixPlan, after: number, picked: PickedTrack, grids: EditorGrids): MixPlan {
  const at = clamp(after, 0, plan.tracks.length - 1) + 1;
  const tracks = [...plan.tracks.slice(0, at), planTrack(picked), ...plan.tracks.slice(at)];
  const next = plan.tracks[at];
  // The Transition into the old next track now goes into the newcomer; the newcomer hands over to the old next track as it was cued.
  const into = plan.transitions[at - 1];
  const out = transitionOutOf(picked, into?.incomingAt ?? { bar: 1, beat: 1 }, next === undefined ? undefined : grids.get(next.contentHash)?.bpm);
  const transitions =
    next === undefined
      ? [...plan.transitions, out]
      : [...plan.transitions.slice(0, at - 1), ...(into === undefined ? [] : [{ ...into, incomingAt: { bar: 1, beat: 1 } as const }]), out, ...plan.transitions.slice(at)];
  return { ...plan, tracks, transitions };
}

function removeTrack(plan: MixPlan, index: number): MixPlan {
  if (plan.tracks[index] === undefined) return plan;
  const tracks = plan.tracks.filter((_, at) => at !== index);
  const before = plan.transitions[index - 1];
  const after = plan.transitions[index];
  let transitions: Transition[];
  if (before === undefined) transitions = plan.transitions.slice(1);
  else if (after === undefined) transitions = plan.transitions.slice(0, -1);
  // The Transition into the removed track now goes into the one after it, at the cue that one had.
  else transitions = [...plan.transitions.slice(0, index - 1), { ...before, incomingAt: after.incomingAt }, ...plan.transitions.slice(index + 1)];
  return { ...plan, tracks, transitions };
}

function apply(plan: MixPlan, action: EditorAction, grids: EditorGrids): MixPlan {
  switch (action.kind) {
    case "rename":
      return { ...plan, name: action.name.trim() };
    case "recipe": {
      const trackTempos = tempos(plan, action.transition, grids);
      if (action.recipe === "tempo-ride" && trackTempos === undefined) {
        throw new Error("A tempo ride needs both tracks' beat grids: find the tracks first (the editor offers tempo ride only then).");
      }
      return editTransition(plan, action.transition, (transition) =>
        transitionFromRecipe(action.recipe, { outgoingAt: transition.outgoingAt, incomingAt: transition.incomingAt, ...(trackTempos === undefined ? {} : { tempos: trackTempos }) }),
      );
    }
    case "start-phrase":
      return editTransition(plan, action.transition, (transition) => ({ ...transition, outgoingAt: phraseStart(Math.max(1, Math.round(action.phrase))) }));
    case "incoming-phrase":
      return editTransition(plan, action.transition, (transition) => ({ ...transition, incomingAt: phraseStart(Math.max(1, Math.round(action.phrase))) }));
    case "length":
      return editTransition(plan, action.transition, (transition) => setLength(transition, action.lengthBeats, tempos(plan, action.transition, grids)));
    case "move-keyframe":
      return editTransition(plan, action.transition, (transition) => moveKeyframe(transition, action.lane, action.keyframe, action.beat, action.value));
    case "add-keyframe":
      return editTransition(plan, action.transition, (transition) => addKeyframe(transition, action.lane, action.beat));
    case "remove-keyframe":
      return editTransition(plan, action.transition, (transition) =>
        withLane(transition, action.lane, (lane) => ({ ...lane, keyframes: lane.keyframes.filter((_, at) => at !== action.keyframe) })),
      );
    case "curve":
      return editTransition(plan, action.transition, (transition) =>
        withLane(transition, action.lane, (lane) => {
          const keyframe = lane.keyframes[action.keyframe];
          return keyframe === undefined ? lane : { ...lane, keyframes: replaceAt(lane.keyframes, action.keyframe, { ...keyframe, curve: action.curve }) };
        }),
      );
    case "add-lane":
      return editTransition(plan, action.transition, (transition) =>
        transition.lanes.some((lane) => lane.track === action.track && lane.param === action.param)
          ? transition
          : { ...transition, recipe: "custom", lanes: [...transition.lanes, newLane(transition, action.track, action.param, tempos(plan, action.transition, grids)?.outgoing)] },
      );
    case "remove-lane":
      return editTransition(plan, action.transition, (transition) => ({ ...transition, recipe: "custom", lanes: transition.lanes.filter((_, at) => at !== action.lane) }));
    case "insert-track":
      return insertTrack(plan, action.after, action.picked, grids);
    case "remove-track":
      return removeTrack(plan, action.track);
  }
}

/** The plan after `action`, stamped `now` (wall-clock metadata only). */
export function editPlan(plan: MixPlan, action: EditorAction, grids: EditorGrids, now: string): MixPlan {
  const next = apply(plan, action, grids);
  return next === plan ? plan : { ...next, updatedAt: now };
}
