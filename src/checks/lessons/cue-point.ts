// Lesson 6, `cue-point`: set a cue point on a downbeat by ear (check-design §4).
import type { CriterionResult } from "@shared/check-result.ts";
import type { CheckContext, LessonCheck, TaskOf } from "../context.ts";
import { judgeAll } from "../criterion.ts";
import { isDownbeat, trackBeat } from "../timeline.ts";
import { CUE_PLACEMENT_TOLERANCE_MS } from "../tolerance.ts";

/**
 * `cue-point.cue-on-downbeat`: for each track, the last cue set on it is within ±20 ms of its
 * nearest beat, and that beat is beat 1. Also used by `cut-on-phrase` in Placement.
 */
export function cueOnDownbeat(context: CheckContext, trackIds: readonly string[]): CriterionResult {
  const placements = trackIds.map((trackId) => {
    const cue = context.attempt.cuePoints.filter((candidate) => candidate.trackId === trackId).at(-1);
    const grid = context.attempt.grids[trackId];
    if (cue === undefined || grid === undefined) return null;
    const beat = trackBeat(grid, cue.pos);
    const nearest = Math.round(beat);
    return { offsetMs: (Math.abs(beat - nearest) * 60_000) / grid.bpm, downbeat: isDownbeat(grid, nearest) };
  });
  const found = placements.filter((placement) => placement !== null);
  const missing = placements.length - found.length;
  const wrongBeat = found.filter((placement) => !placement.downbeat).length;
  const worstMs = found.length === 0 ? null : Math.max(...found.map((placement) => placement.offsetMs));

  return judgeAll(
    {
      id: "cue-point.cue-on-downbeat",
      severity: "fail",
      unit: "ms",
      threshold: { op: "<=", value: CUE_PLACEMENT_TOLERANCE_MS, unit: "ms" },
      measured: worstMs,
      detail: { tracks: trackIds.length, wrongBeat, missing },
    },
    {
      id: "cue-point.cue-on-downbeat",
      severity: "fail",
      unit: "count",
      threshold: { op: "<=", value: 0, unit: "count" },
      measured: wrongBeat + missing,
      scale: 1,
    },
  );
}

export const cuePoint: LessonCheck<TaskOf<"cue-point">> = {
  situations: { transition: false },
  criteria: ["cue-point.cue-on-downbeat"],
  run(context) {
    return { criteria: [cueOnDownbeat(context, context.spec.tracks.map((track) => track.trackId))], metrics: {} };
  },
};
