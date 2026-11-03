// Transition recipes: named, ready-made sets of lanes, the Mix Editor's front door. Picking one gives
// a good Transition with no lane editing; its lanes stay editable (an edited one is saved as "custom").
// Lanes scale with the Transition's length.
//
// A recipe is only lanes: the Render plays them and the Execution plan (src/app/mix-editor) is derived
// from them, so what is heard and what is graded come from one definition.
import {
  BEATS_PER_BAR,
  gridHashOf,
  lastPhraseStartFitting,
  MIX_PLAN_VERSION,
  type GridPos,
  type Keyframe,
  type Lane,
  type MixPlan,
  type PlanGrid,
  type PlanTrack,
  type RecipeId,
  type Transition,
} from "./mix-plan.ts";

/** Both tracks' own BPMs (their beat grids'). Only a tempo ride uses them. */
export interface TrackTempos {
  readonly outgoing: number;
  readonly incoming: number;
}

export interface Recipe {
  readonly name: string;
  /** The usual length, beats. */
  readonly lengthBeats: number;
  readonly lanes: (lengthBeats: number, tempos: TrackTempos | undefined) => Lane[];
}

const at = (beat: number, value: number, curve: Keyframe["curve"] = "jump"): Keyframe => ({ beat, value, curve });
const lane = (track: Lane["track"], param: Lane["param"], keyframes: Keyframe[], extra: Pick<Lane, "echoBeats" | "loopBeats"> = {}): Lane => ({
  track,
  param,
  keyframes,
  ...extra,
});

/** A fader blend: the incoming track comes up over the first half, the outgoing one goes down over the second, as the Lessons teach. */
function crossfade(bars: number): Recipe {
  return {
    name: `Crossfade, ${String(bars)} bars`,
    lengthBeats: bars * BEATS_PER_BAR,
    lanes: (length) => [
      lane("incoming", "volume", [at(0, 0), at(length / 2, 1, "linear")]),
      lane("outgoing", "volume", [at(length / 2, 1), at(length, 0, "linear")]),
    ],
  };
}

export const RECIPES: Readonly<Record<RecipeId, Recipe>> = {
  "crossfade-8": crossfade(8),
  "crossfade-16": crossfade(16),
  "crossfade-32": crossfade(32),
  // The incoming track comes in with its bass cut; halfway, the basses swap in one move.
  "bass-swap": {
    name: "Bass swap",
    lengthBeats: 16 * BEATS_PER_BAR,
    lanes: (length) => [
      lane("incoming", "volume", [at(0, 0), at(length / 2, 1, "linear")]),
      lane("incoming", "eq-low", [at(0, -1), at(length / 2, 0)]),
      lane("outgoing", "eq-low", [at(length / 2, -1)]),
      lane("outgoing", "volume", [at(length / 2, 1), at(length, 0, "linear")]),
    ],
  },
  // On the 1 of the phrase, the outgoing track stops being heard and the incoming one is in at full.
  "cut-on-the-1": {
    name: "Cut on the 1",
    lengthBeats: BEATS_PER_BAR,
    lanes: () => [lane("outgoing", "volume", [at(0, 0)]), lane("incoming", "volume", [at(0, 1)])],
  },
  // The outgoing track thins to its highs while the incoming one rises with its bass held back; at the end they swap.
  "filter-sweep": {
    name: "Filter sweep",
    lengthBeats: 8 * BEATS_PER_BAR,
    lanes: (length) => [
      lane("outgoing", "filter", [at(0, 0), at(length, 1, "linear")]),
      lane("outgoing", "volume", [at(length, 0)]),
      lane("incoming", "volume", [at(0, 0), at(length, 1, "linear")]),
      lane("incoming", "eq-low", [at(0, -1), at(length, 0)]),
    ],
  },
  // An echo on the outgoing track, its level cut at the next bar so the echo rings out, then the incoming track drops in.
  "echo-out": {
    name: "Echo out",
    lengthBeats: 2 * BEATS_PER_BAR,
    lanes: (length) => [
      lane("outgoing", "echo-send", [at(0, 1), at(length, 0)], { echoBeats: 1 }),
      lane("outgoing", "volume", [at(BEATS_PER_BAR, 0)]),
      lane("incoming", "volume", [at(length, 1)]),
    ],
  },
  // The outgoing track holds a 1-bar loop while the faders trade, as a crossfade does; the loop is let go once it is silent.
  "loop-to-extend": {
    name: "Loop to extend",
    lengthBeats: 8 * BEATS_PER_BAR,
    lanes: (length) => [
      lane("outgoing", "loop", [at(0, 1), at(length, 0)], { loopBeats: BEATS_PER_BAR }),
      lane("incoming", "volume", [at(0, 0), at(length / 2, 1, "linear")]),
      lane("outgoing", "volume", [at(length / 2, 1), at(length, 0, "linear")]),
    ],
  },
  // A crossfade over the first two thirds at the outgoing track's tempo, then the incoming track rides back to its own over the last third.
  "tempo-ride": {
    name: "Tempo ride",
    lengthBeats: 24 * BEATS_PER_BAR,
    lanes: (length, tempos) => {
      if (tempos === undefined) throw new Error("A tempo ride needs both tracks' BPMs: pass `tempos` to transitionFromRecipe.");
      return [
        lane("incoming", "tempo", [at(0, tempos.outgoing), at((length * 2) / 3, tempos.outgoing), at(length, tempos.incoming, "linear")]),
        lane("incoming", "volume", [at(0, 0), at(length / 3, 1, "linear")]),
        lane("outgoing", "volume", [at(length / 3, 1), at((length * 2) / 3, 0, "linear")]),
      ];
    },
  },
};

/** A Transition from a recipe, at its usual length unless `lengthBeats` says otherwise. A tempo ride needs `tempos`. */
export function transitionFromRecipe(
  recipe: RecipeId,
  place: { readonly outgoingAt: GridPos; readonly incomingAt: GridPos; readonly lengthBeats?: number; readonly tempos?: TrackTempos },
): Transition {
  const lengthBeats = place.lengthBeats ?? RECIPES[recipe].lengthBeats;
  return { recipe, outgoingAt: place.outgoingAt, incomingAt: place.incomingAt, lengthBeats, lanes: RECIPES[recipe].lanes(lengthBeats, place.tempos) };
}

/** What a new plan needs of each picked track: who it is, and the beat grid the plan is laid on. */
export interface PickedTrack {
  readonly track: Omit<PlanTrack, "gridHash" | "startAt" | "gainDb" | "source">;
  readonly grid: PlanGrid;
}

/**
 * A new plan over `picked`, in that order: each track from bar 1, and one `recipe` Transition per pair,
 * on the last phrase of the outgoing track it fits in, bringing the incoming track in from bar 1.
 * Levels are left matched at 0 dB. The result may still have problems (a track too short for the
 * recipe): validate it.
 */
export function newMixPlan(input: {
  readonly id: string;
  readonly name: string;
  /** Wall-clock time, ISO 8601: metadata only. */
  readonly now: string;
  readonly picked: readonly PickedTrack[];
  readonly recipe?: RecipeId;
}): MixPlan {
  const recipe = input.recipe ?? "crossfade-16";
  const { lengthBeats } = RECIPES[recipe];
  const bar1: GridPos = { bar: 1, beat: 1 };
  const tracks: PlanTrack[] = input.picked.map(({ track, grid }) => ({ ...track, source: "local", gridHash: gridHashOf(grid), startAt: bar1, gainDb: 0 }));
  const transitions = input.picked.slice(0, -1).map(({ grid }, index) =>
    transitionFromRecipe(recipe, {
      outgoingAt: lastPhraseStartFitting(grid, lengthBeats) ?? bar1,
      incomingAt: bar1,
      tempos: { outgoing: grid.bpm, incoming: input.picked[index + 1]?.grid.bpm ?? grid.bpm },
    }),
  );
  return { id: input.id, name: input.name, createdAt: input.now, updatedAt: input.now, version: MIX_PLAN_VERSION, tracks, transitions };
}
