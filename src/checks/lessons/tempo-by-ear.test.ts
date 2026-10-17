import { describe, expect, it } from "vitest";
import type { CheckVariant, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import type { EngineCommandRecord } from "../deck-commands.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BPM, LESSON_AIDS, attempt, engineCommand, spec } from "../testing/synthetic.ts";

const MATCH_FROM = 4;
const WINDOW = { from: 0, to: 80 };
const BY_EAR_AIDS = { ...LESSON_AIDS, bpmDisplay: false, phaseMeter: false };

/**
 * B 2% fast from 4 s, then the Learner overcorrects (119.4 BPM at 8 s), comes back (120.24 at 12 s)
 * and lands on 120 BPM in phase at `landAt`, `offsetS` behind A, `gapBpm` off.
 */
function hunting({ landAt = 16, offsetS = 0, gapBpm = 0 } = {}): PlayheadSegment[] {
  return [
    { fromCtx: MATCH_FROM, pos: MATCH_FROM, rate: 1.02 },
    { fromCtx: 8, pos: 8.08, rate: 0.995 },
    { fromCtx: 12, pos: 12.06, rate: 1.002 },
    { fromCtx: landAt, pos: landAt - offsetS, rate: (BPM + gapBpm) / BPM },
  ];
}

const TEMPO_MOVES: EngineCommandRecord[] = [
  engineCommand(8, "tempo", "B", -0.05),
  engineCommand(12, "tempo", "B", 0.02),
  engineCommand(16, "tempo", "B", 0),
];

function check(
  segments: readonly PlayheadSegment[],
  options: { variant?: CheckVariant; engineEvents?: readonly EngineCommandRecord[] } = {},
): CheckResult {
  const result = runCheck(spec({ lessonId: "tempo-by-ear", matchFrom: MATCH_FROM }, WINDOW, { variant: options.variant ?? "full", aids: BY_EAR_AIDS }), {
    ...attempt({
      decks: {
        A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }] } },
        B: { trackId: "track-b", playhead: { segments } },
      },
    }),
    engineEvents: options.engineEvents ?? TEMPO_MOVES,
  });
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("tempo-by-ear", () => {
  it("passes tempos matched and in phase within 32 bars, held for 8, and reports the hunting", () => {
    const result = check(hunting());

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["tempo-by-ear.tempo-match"]);
    expect(byId(result, "tempo-by-ear.tempo-match")?.measured).toBeCloseTo(6, 1);
    // 122.4 → 119.4 → 120.24 → 120: two reversals of the tempo fader.
    expect(result.metrics).toMatchObject({ tempoReversals: 2, maxBendPercent: 0 });
  });

  it("allows tempos 0.1 BPM apart and fails 0.12", () => {
    expect(byId(check(hunting({ gapBpm: 0.1 })), "tempo-by-ear.tempo-match")?.status).toBe("met");
    expect(byId(check(hunting({ gapBpm: 0.12 })), "tempo-by-ear.tempo-match")).toMatchObject({ status: "notMet", measured: null });
  });

  it("needs the phase under 20 ms too, not only matched tempos", () => {
    expect(byId(check(hunting({ offsetS: 0.019 })), "tempo-by-ear.tempo-match")?.status).toBe("met");
    expect(byId(check(hunting({ offsetS: 0.03 })), "tempo-by-ear.tempo-match")?.status).toBe("notMet");
  });

  it("needs the match by 32 bars in the full form and by 24 bars in the short form", () => {
    const late = hunting({ landAt: MATCH_FROM + 26 * BAR });
    expect(byId(check(late), "tempo-by-ear.tempo-match")?.status).toBe("met");
    expect(byId(check(late, { variant: "short" }), "tempo-by-ear.tempo-match")?.status).toBe("notMet");
  });

  it("reports the largest jog bend as a percentage", () => {
    const result = check(hunting(), {
      engineEvents: [...TEMPO_MOVES, engineCommand(17, "jog-bend", "B", -0.04), engineCommand(17.2, "jog-bend", "B", 0)],
    });
    expect(result.metrics["maxBendPercent"]).toBeCloseTo(4);
  });

  it("ignores tempo jitter of 0.02 BPM or less when counting reversals", () => {
    const steady: PlayheadSegment[] = [
      { fromCtx: MATCH_FROM, pos: MATCH_FROM, rate: 1 },
      { fromCtx: 8, pos: 8, rate: (BPM + 0.015) / BPM },
      { fromCtx: 12, pos: 12, rate: 1 },
    ];
    const result = check(steady, { engineEvents: [engineCommand(8, "tempo", "B", 0.001), engineCommand(12, "tempo", "B", 0)] });
    expect(result.metrics["tempoReversals"]).toBe(0);
  });
});
