// The seven Transition recipes: each is only lanes of keyframes, the one definition the Render plays and
// the Execution plan is derived from, so what you hear and what you are graded on cannot disagree.
// Beats count from the Transition's start, which the editor snaps to a phrase start; a recipe's moves
// land on phrase and bar starts from there. Lane order is the order the strip lists them.

import type { Keyframe, Lane, RecipeId, Transition } from "./lanes.ts";

/** Both tracks' own BPMs: a tempo ride starts the incoming track matched to the outgoing one. */
export interface TrackTempos {
  readonly outgoing: number;
  readonly incoming: number;
}

export type RecipeLanes = Pick<Transition, "recipe" | "lengthBeats" | "lanes">;

export const RECIPE_IDS: readonly RecipeId[] = ["long-blend", "bass-swap", "filter-sweep", "echo-out", "cut-on-the-one", "loop-to-extend", "tempo-ride"];

/** Keyframes from [beat, value, curve] triples. */
const at = (...keyframes: readonly (readonly [number, number, Keyframe["curve"]?])[]): Keyframe[] =>
  keyframes.map(([beat, value, curve = "linear"]) => ({ beat, value, curve }));

const lane = (track: Lane["track"], param: Lane["param"], keyframes: Keyframe[], echoBeats?: number): Lane =>
  echoBeats === undefined ? { track, param, keyframes } : { track, param, keyframes, echoBeats };

/** A recipe's lanes, ready to place at a phrase start. */
export function recipeLanes(recipe: RecipeId, tempos: TrackTempos): RecipeLanes {
  switch (recipe) {
    // 16 bars: the incoming fader comes up over the first phrase, the outgoing one goes down over the second.
    case "long-blend":
      return {
        recipe,
        lengthBeats: 64,
        lanes: [lane("outgoing", "volume", at([0, 1], [32, 1], [64, 0])), lane("incoming", "volume", at([0, 0], [32, 1]))],
      };
    // 8 bars: the incoming track comes up with its lows killed, the lows swap on bar 5's 1, then the outgoing fades.
    case "bass-swap":
      return {
        recipe,
        lengthBeats: 32,
        lanes: [
          lane("incoming", "volume", at([0, 0], [16, 1])),
          lane("incoming", "eq-low", at([0, -1], [16, 0, "jump"])),
          lane("outgoing", "eq-low", at([0, 0], [16, -1, "jump"])),
          lane("outgoing", "volume", at([0, 1], [16, 1], [32, 0])),
        ],
      };
    // 8 bars: the outgoing track's filter opens toward high-pass while the incoming fader comes up; the outgoing is cut on the next phrase.
    case "filter-sweep":
      return {
        recipe,
        lengthBeats: 32,
        lanes: [
          lane("outgoing", "filter", at([0, 0], [32, 0.8])),
          lane("incoming", "volume", at([0, 0], [32, 1])),
          lane("outgoing", "volume", at([0, 1], [32, 0, "jump"])),
        ],
      };
    // 8 bars: a 1-beat echo is thrown on the last bar's 1; on the next phrase the incoming track drops in as the outgoing is cut.
    case "echo-out":
      return {
        recipe,
        lengthBeats: 32,
        lanes: [
          lane("outgoing", "echo-send", at([0, 0], [28, 0.5, "jump"]), 1),
          lane("outgoing", "volume", at([0, 1], [32, 0, "jump"])),
          lane("incoming", "volume", at([0, 0], [32, 1, "jump"])),
        ],
      };
    // 8 bars: the incoming track runs unheard for a phrase, then the two swap on the next phrase's 1.
    case "cut-on-the-one":
      return {
        recipe,
        lengthBeats: 32,
        lanes: [lane("outgoing", "volume", at([0, 1], [32, 0, "jump"])), lane("incoming", "volume", at([0, 0], [32, 1, "jump"]))],
      };
    // 8 bars: the outgoing track holds a 1-bar loop while the incoming comes up and it fades; the loop is let go once it's silent.
    case "loop-to-extend":
      return {
        recipe,
        lengthBeats: 32,
        lanes: [
          lane("outgoing", "loop", at([0, 4, "jump"], [32, 0, "jump"])),
          lane("outgoing", "volume", at([0, 1], [16, 1], [32, 0])),
          lane("incoming", "volume", at([0, 0], [16, 1])),
        ],
      };
    // 24 bars: a 16-bar blend at the outgoing track's tempo, then the incoming track rides back to its own over a phrase.
    case "tempo-ride":
      return {
        recipe,
        lengthBeats: 96,
        lanes: [
          lane("incoming", "tempo", at([0, tempos.outgoing], [64, tempos.outgoing], [96, tempos.incoming])),
          lane("outgoing", "volume", at([0, 1], [32, 1], [64, 0])),
          lane("incoming", "volume", at([0, 0], [32, 1])),
        ],
      };
  }
}
