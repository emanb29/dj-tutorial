import { describe, expect, it } from "vitest";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import type { RecipeId } from "@shared/mix-plan.ts";
import { mixCommands } from "./commands.ts";
import { movesAround, planSegments, PREROLL_SEC } from "./segments.ts";
import { setTimeline } from "./timeline.ts";

const RATE = 44_100;

function setOf(recipe: RecipeId, count: number) {
  const { plan } = testPlan(count, { recipe });
  const outcome = setTimeline(plan, Array.from({ length: count }, () => testGrid()));
  if (!outcome.ok) throw new Error(outcome.problems[0]?.message);
  return { timeline: outcome.timeline, commands: mixCommands(plan, outcome.timeline) };
}

describe("planSegments", () => {
  for (const recipe of ["bass-swap", "echo-out", "tempo-ride", "loop-to-extend"] as const) {
    it(`cuts a 25-track set of ${recipe} Transitions into segments of about 2 minutes, each cut where nothing moves`, () => {
      const { timeline, commands } = setOf(recipe, 25);
      const segments = planSegments(timeline, commands, RATE);
      // Contiguous, from the first frame to the last.
      expect(segments[0]?.fromFrame).toBe(0);
      expect(segments.at(-1)?.toFrame).toBe(Math.ceil(timeline.durationSec * RATE));
      for (const [index, segment] of segments.entries()) {
        const next = segments[index + 1];
        if (next !== undefined) expect(next.fromFrame).toBe(segment.toFrame);
      }
      const lengths = segments.map((segment) => (segment.toFrame - segment.fromFrame) / RATE);
      expect(Math.max(...lengths)).toBeLessThan(160);
      expect(Math.min(...lengths)).toBeGreaterThanOrEqual(20);
      // No mixer move, and no track starting or stopping, around a cut or in its pre-roll.
      for (const segment of segments.slice(1)) {
        const cut = segment.fromFrame / RATE;
        expect(movesAround(commands, cut - PREROLL_SEC / 2, PREROLL_SEC / 2 + 0.09)).toEqual([]);
        for (const track of timeline.tracks) {
          expect(Math.abs(track.enterSec - cut)).toBeGreaterThan(0.09);
          expect(Math.abs(track.stopSec - cut)).toBeGreaterThan(0.09);
        }
      }
    });
  }

  it("keeps a short set in one segment", () => {
    const short = () => testGrid({ durationSec: 60 });
    const { plan } = testPlan(2, { recipe: "cut-on-the-1", grid: short });
    const outcome = setTimeline(plan, [short(), short()]);
    if (!outcome.ok) throw new Error(outcome.problems[0]?.message);
    expect(planSegments(outcome.timeline, mixCommands(plan, outcome.timeline), RATE)).toHaveLength(1);
  });
});
