// Plans for tests: tracks with made-up hashes and grids, laid out by newMixPlan.
import type { MixPlan, PlanGrid, RecipeId } from "./mix-plan.ts";
import { newMixPlan, type PickedTrack } from "./mix-plan-recipes.ts";

/** A valid-looking content hash for track `n`. */
export const testHash = (n: number) => n.toString(16).padStart(64, "0");

/** A 120 BPM grid (bar 1 at 0.1 s), 5 minutes long unless told otherwise. */
export const testGrid = (overrides: Partial<PlanGrid> = {}): PlanGrid => ({ bpm: 120, firstBeatSec: 0.1, downbeatPhase: 0, durationSec: 300, ...overrides });

export function testPicked(count: number, grid: (index: number) => PlanGrid = () => testGrid()): PickedTrack[] {
  return Array.from({ length: count }, (_, index) => ({
    track: {
      contentHash: testHash(index + 1),
      fileName: `Artist ${String(index + 1)} - Track ${String(index + 1)}.mp3`,
      durationMs: Math.round(grid(index).durationSec * 1000),
      title: `Track ${String(index + 1)}`,
      artist: `Artist ${String(index + 1)}`,
    },
    grid: grid(index),
  }));
}

/** A plan of `count` tracks, and the grids it was made on (by content hash), as validation takes them. */
export function testPlan(count = 3, options: { readonly recipe?: RecipeId; readonly grid?: (index: number) => PlanGrid } = {}) {
  const picked = testPicked(count, options.grid);
  const plan: MixPlan = newMixPlan({
    id: `plan-${String(count)}`,
    name: "Test set",
    now: "2026-11-03T12:00:00.000Z",
    picked,
    ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
  });
  const grids = new Map(picked.map((each) => [each.track.contentHash, each.grid]));
  return { plan, grids };
}
