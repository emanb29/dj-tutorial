import { describe, expect, it } from "vitest";
import type { CuePointSet } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, attempt, grid, spec } from "../testing/synthetic.ts";

const TRACKS = ["track-1", "track-2", "track-3"];

function check(cuePositions: readonly (number | null)[], trackIds = TRACKS): CheckResult {
  const cuePoints: CuePointSet[] = cuePositions.flatMap((pos, index) =>
    pos === null ? [] : [{ ctx: 5 + index * 10, deck: "B", trackId: trackIds[index] ?? "missing", pos }],
  );
  const result = runCheck(
    spec({ lessonId: "cue-point" }, { from: 0, to: 40 }, {
      tracks: trackIds.map((trackId) => ({ trackId, trackSetId: "set-1", deck: "B" })),
    }),
    attempt({
      // Track 2's grid starts 0.1 s in, with its first downbeat on beat 1.
      grids: { "track-1": grid(), "track-2": grid({ firstBeat: 0.1, downbeatIndex: 1 }), "track-3": grid() },
      cuePoints,
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

describe("cue-point", () => {
  it("passes a cue on a downbeat of every track", () => {
    const result = check([4 * BAR, 0.1 + BEAT, 8 * BAR]);

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria[0]).toMatchObject({ id: "cue-point.cue-on-downbeat", measured: 0, detail: { tracks: 3, wrongBeat: 0, missing: 0 } });
  });

  it("allows 20 ms off the downbeat and fails 21 ms", () => {
    expect(check([4 * BAR + 0.02, 0.1 + BEAT, 8 * BAR - 0.02]).outcome.kind).toBe("passed");
    const late = check([4 * BAR, 0.1 + BEAT + 0.021, 8 * BAR]);

    expect(late.outcome.kind).toBe("failed");
    expect(late.criteria[0]?.measured).toBeCloseTo(21);
  });

  it("fails a cue exactly on a beat that is not beat 1", () => {
    expect(check([4 * BAR + BEAT, 0.1 + BEAT, 8 * BAR]).criteria[0]).toMatchObject({
      status: "notMet",
      measured: 0,
      detail: { wrongBeat: 1 },
    });
  });

  it("uses the last cue set on a track and fails a track with no cue", () => {
    const reset: CuePointSet[] = [
      { ctx: 5, deck: "B", trackId: "track-1", pos: 3 },
      { ctx: 6, deck: "B", trackId: "track-1", pos: 4 * BAR },
    ];
    const result = runCheck(
      spec({ lessonId: "cue-point" }, { from: 0, to: 40 }, { tracks: [{ trackId: "track-1", trackSetId: "set-1", deck: "B" }] }),
      attempt({ grids: { "track-1": grid() }, cuePoints: reset }),
    );

    expect(result.outcome.kind).toBe("passed");
    expect(check([4 * BAR, null, 8 * BAR]).criteria[0]).toMatchObject({ status: "notMet", detail: { missing: 1 } });
  });

  it("short form: one track", () => {
    expect(check([4 * BAR], ["track-1"]).outcome.kind).toBe("passed");
  });
});
