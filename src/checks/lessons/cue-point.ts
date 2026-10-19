// Lesson 6, `cue-point`: set a cue point on a downbeat by ear (check-design §4).
import type { BeatGrid } from "@shared/attempt.ts";
import type { CriterionResult } from "@shared/check-result.ts";
import type { CheckContext, LessonCheck, TaskOf } from "../context.ts";
import { judgeAll } from "../criterion.ts";
import { trackBeat } from "../timeline.ts";
import { CUE_PLACEMENT_TOLERANCE_MS } from "../tolerance.ts";

/** Where a cue point sits on its track's grid: the one measurement the Check and practice share. */
export interface CuePlacement {
  /** Signed ms to the nearest beat: positive is late, after the beat. */
  readonly signedMs: number;
  /** The beat of the bar (1 to 4) the cue is nearest. */
  readonly beatOfBar: number;
  readonly downbeat: boolean;
}

/**
 * A cue point at track position `pos` against its grid. The cue point is a deck position, not a heard
 * time, so no output latency applies to it.
 */
export function cuePlacement(grid: BeatGrid, pos: number): CuePlacement {
  const beat = trackBeat(grid, pos);
  const nearest = Math.round(beat);
  const signedMs = ((beat - nearest) * 60_000) / grid.bpm;
  const beatOfBar = ((((nearest - grid.downbeatIndex) % 4) + 4) % 4) + 1;
  return { signedMs, beatOfBar, downbeat: beatOfBar === 1 };
}

/**
 * `cue-point.cue-on-downbeat`: for each track, the last cue set on it is within ±20 ms of its
 * nearest beat, and that beat is beat 1. Also used by `cut-on-phrase` in Placement.
 *
 * The detail carries each cue, numbered from 1 in task order, for the result card's per-cue lines:
 * `cue<N>.offsetMs` (signed: positive is late, after the beat) and `cue<N>.beat` (the beat of the bar,
 * 1 to 4, it is nearest). A cue that was never set has neither key.
 */
export function cueOnDownbeat(context: CheckContext, trackIds: readonly string[]): CriterionResult {
  const placements = trackIds.map((trackId) => {
    const cue = context.attempt.cuePoints.filter((candidate) => candidate.trackId === trackId).at(-1);
    const grid = context.attempt.grids[trackId];
    if (cue === undefined || grid === undefined) return null;
    const placement = cuePlacement(grid, cue.pos);
    return { ...placement, offsetMs: Math.abs(placement.signedMs) };
  });
  const perCue = Object.fromEntries(
    placements.flatMap((placement, index) =>
      placement === null ? [] : [[`cue${String(index + 1)}.offsetMs`, placement.signedMs], [`cue${String(index + 1)}.beat`, placement.beatOfBar]],
    ),
  );
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
      detail: { tracks: trackIds.length, wrongBeat, missing, ...perCue },
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
