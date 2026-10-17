import { describe, expect, it } from "vitest";
import type { CheckVariant, DeckId, MeterFrame } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, MUSIC, attempt, event, frames, playing, spec } from "../testing/synthetic.ts";

interface Levels {
  readonly peakA?: number;
  readonly peakB?: number;
  readonly lufsA?: number;
  readonly lufsB?: number;
  /** A's peak before its Ready press. */
  readonly earlyPeakA?: number;
}

/** Both decks play from 0; Ready on A at 10 s and on B at 30 s. */
function check(levels: Levels = {}, variant: CheckVariant = "full", readyEvents = [event(10, "ready", 1, "A"), event(30, "ready", 1, "B")]): CheckResult {
  const { peakA = -3, peakB = -2, lufsA = -14, lufsB = -13, earlyPeakA = -20 } = levels;
  const channelFrames = (peak: number, lufs: number, earlyPeak = -20): MeterFrame[] =>
    frames(0, 50, (t) => ({ peak: t >= 10 ? peak : earlyPeak, momentary: lufs }));
  const decks: readonly DeckId[] = variant === "full" ? ["A", "B"] : ["A"];
  const result = runCheck(
    spec({ lessonId: "gain-staging", decks }, { from: 0, to: 50 }, { variant }),
    attempt({
      decks: {
        A: { trackId: "track-a", playhead: { segments: playing(0) } },
        B: { trackId: "track-b", playhead: { segments: playing(0) } },
      },
      events: readyEvents,
      meters: { master: frames(0, 50, () => MUSIC), A: channelFrames(peakA, lufsA, earlyPeakA), B: channelFrames(peakB, lufsB) },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("gain-staging", () => {
  it("passes both channels peaking in [−6, −0.1] dBFS with loudness within 1.5 dB", () => {
    const result = check();

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "gain-staging.trim-A",
      "gain-staging.trim-B",
      "gain-staging.loud-match",
    ]);
    expect(byId(result, "gain-staging.trim-A")?.measured).toBeCloseTo(-3);
    expect(byId(result, "gain-staging.loud-match")?.measured).toBeCloseTo(1);
  });

  it("accepts the zone's edges and fails just outside them", () => {
    expect(byId(check({ peakA: -6 }), "gain-staging.trim-A")?.status).toBe("met");
    expect(byId(check({ peakA: -6.1 }), "gain-staging.trim-A")?.status).toBe("notMet");
    expect(byId(check({ peakB: 0 }), "gain-staging.trim-B")?.status).toBe("notMet");
  });

  it("fails loudness more than 1.5 dB apart", () => {
    expect(byId(check({ lufsB: -12.5 }), "gain-staging.loud-match")?.status).toBe("met");
    expect(byId(check({ lufsB: -12.4 }), "gain-staging.loud-match")?.status).toBe("notMet");
  });

  it("measures only the 8 bars after Ready: a clip before Ready does not count", () => {
    const clipBeforeReady = check({ earlyPeakA: 1 });

    expect(byId(clipBeforeReady, "gain-staging.trim-A")).toMatchObject({ status: "met", measured: -3 });
    expect(clipBeforeReady.criteria[0]?.evidence[0]).toMatchObject({ from: 10, to: 10 + 8 * BAR });
  });

  it("fails a deck whose Ready was never pressed, with nothing measured", () => {
    const result = check({}, "full", [event(10, "ready", 1, "A")]);

    expect(byId(result, "gain-staging.trim-B")).toMatchObject({ status: "notMet", measured: null });
    expect(byId(result, "gain-staging.loud-match")).toMatchObject({ status: "notMet", measured: null });
  });

  it("fails a Ready pressed too late for a full 8 bars to be measured", () => {
    const result = check({}, "full", [event(10, "ready", 1, "A"), event(40, "ready", 1, "B")]);

    expect(byId(result, "gain-staging.trim-B")).toMatchObject({ status: "notMet", measured: null });
  });

  it("short form: one deck, 4 bars, no loudness match", () => {
    const result = check({}, "short");

    expect(result.outcome.kind).toBe("passed");
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["gain-staging.trim-A"]);
    expect(result.criteria[0]?.evidence[0]).toMatchObject({ from: 10, to: 10 + 4 * BAR });
  });
});
