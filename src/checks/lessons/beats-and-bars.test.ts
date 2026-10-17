import { describe, expect, it } from "vitest";
import type { CheckVariant } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, MUSIC, attempt, frames, playing, spec, taps } from "../testing/synthetic.ts";

/** Deck A plays from 0. Beat section: 8 bars from 4 s; downbeat section: 8 bars after it. */
function check(tapTimes: readonly number[], variant: CheckVariant = "full"): CheckResult {
  const bars = variant === "full" ? 8 : 4;
  const beatSection = { from: 4, to: 4 + bars * BAR };
  const downbeatSection = { from: beatSection.to, to: beatSection.to + bars * BAR };
  const result = runCheck(
    spec({ lessonId: "beats-and-bars", beatSection, downbeatSection }, { from: 0, to: downbeatSection.to + 2 }, { variant }),
    attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
      events: taps(tapTimes),
      meters: { master: frames(0, 40, () => MUSIC), A: frames(0, 40, () => MUSIC) },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const range = (count: number, first: number, step: number): number[] =>
  Array.from({ length: count }, (_, index) => first + index * step);
const everyBeat = range(32, 4, BEAT);
const everyDownbeat = range(8, 20, BAR);
const statusOf = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id)?.status;

describe("beats-and-bars", () => {
  it("passes taps on every beat, then on every downbeat", () => {
    const result = check([...everyBeat, ...everyDownbeat]);

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["beats-and-bars.beat-taps", "beats-and-bars.downbeat-taps"]);
    expect(result.criteria[0]).toMatchObject({ measured: 1, detail: { matched: 32, extras: 0, targets: 32 } });
  });

  it("reports the median signed tap offset, so rushing or dragging is visible", () => {
    const result = check([...everyBeat, ...everyDownbeat].map((t) => t + 0.03));

    expect(result.outcome.kind).toBe("passed");
    expect(result.metrics["medianTapOffsetMs"]).toBeCloseTo(30);
  });

  it("matches taps up to 40 ms off and misses at 41 ms", () => {
    expect(statusOf(check([...everyBeat.map((t) => t - 0.04), ...everyDownbeat]), "beats-and-bars.beat-taps")).toBe("met");
    expect(statusOf(check([...everyBeat.map((t) => t + 0.041), ...everyDownbeat]), "beats-and-bars.beat-taps")).toBe(
      "notMet",
    );
  });

  it("needs 90% of the beats: 29 of 32 passes, 28 fails", () => {
    expect(statusOf(check([...everyBeat.slice(3), ...everyDownbeat]), "beats-and-bars.beat-taps")).toBe("met");
    expect(statusOf(check([...everyBeat.slice(4), ...everyDownbeat]), "beats-and-bars.beat-taps")).toBe("notMet");
  });

  it("allows 3 extra taps and fails on 4", () => {
    const extras = (count: number) => range(count, 4.25, BAR);

    expect(statusOf(check([...everyBeat, ...extras(3), ...everyDownbeat]), "beats-and-bars.beat-taps")).toBe("met");
    expect(statusOf(check([...everyBeat, ...extras(4), ...everyDownbeat]), "beats-and-bars.beat-taps")).toBe("notMet");
  });

  it("does not reward tap spam: tapping every 50 ms matches every beat but fails on extras", () => {
    const spam = range(320, 4, 0.05);
    const result = check([...spam, ...everyDownbeat]);

    expect(result.criteria[0]).toMatchObject({ status: "notMet", detail: { matched: 32 } });
  });

  it("needs 7 of 8 downbeats and no tap on the wrong beat of the bar", () => {
    expect(statusOf(check([...everyBeat, ...everyDownbeat.slice(1)]), "beats-and-bars.downbeat-taps")).toBe("met");
    expect(statusOf(check([...everyBeat, ...everyDownbeat.slice(2)]), "beats-and-bars.downbeat-taps")).toBe("notMet");

    const oneOnBeatTwo = check([...everyBeat, ...everyDownbeat, 20 + BEAT]);
    expect(oneOnBeatTwo.criteria[1]).toMatchObject({ status: "notMet", detail: { matched: 8, wrongBeat: 1 } });
  });

  it("caps extra taps in the downbeat section at 3, so spamming around each downbeat fails", () => {
    const offGrid = (count: number) => range(count, 20.25, BAR); // between beats 1 and 2: extras, not wrong-beat
    const spamAroundDownbeats = everyDownbeat.flatMap((t) => [t - 0.03, t, t + 0.03]);

    expect(statusOf(check([...everyBeat, ...everyDownbeat, ...offGrid(3)]), "beats-and-bars.downbeat-taps")).toBe("met");
    expect(statusOf(check([...everyBeat, ...everyDownbeat, ...offGrid(4)]), "beats-and-bars.downbeat-taps")).toBe("notMet");
    expect(check([...everyBeat, ...spamAroundDownbeats]).criteria[1]).toMatchObject({
      status: "notMet",
      detail: { matched: 8, wrongBeat: 0, extras: 16 },
    });
  });

  it("counts a downbeat tapped 30 ms early, right at the section boundary, in the downbeat section", () => {
    const result = check([...everyBeat, 20 - 0.03, ...everyDownbeat.slice(1)]);

    expect(result.criteria[0]).toMatchObject({ detail: { extras: 0 } });
    expect(result.criteria[1]).toMatchObject({ detail: { matched: 8 } });
  });

  it("fails with nothing tapped", () => {
    expect(check([]).outcome).toEqual({
      kind: "failed",
      failedCriteria: ["beats-and-bars.beat-taps", "beats-and-bars.downbeat-taps"],
    });
  });

  describe("short form (4 + 4 bars, same ratios)", () => {
    const shortBeats = range(16, 4, BEAT);
    const shortDownbeats = range(4, 12, BAR);

    it("needs 90% of 16 beats with at most 1 extra, and all 4 downbeats", () => {
      expect(check([...shortBeats.slice(1), ...shortDownbeats], "short").outcome.kind).toBe("passed");
      expect(statusOf(check([...shortBeats.slice(2), ...shortDownbeats], "short"), "beats-and-bars.beat-taps")).toBe(
        "notMet",
      );
      expect(statusOf(check([...shortBeats, 4.25, 6.25, ...shortDownbeats], "short"), "beats-and-bars.beat-taps")).toBe(
        "notMet",
      );
      expect(statusOf(check([...shortBeats, ...shortDownbeats.slice(1)], "short"), "beats-and-bars.downbeat-taps")).toBe(
        "notMet",
      );
      expect(statusOf(check([...shortBeats, ...shortDownbeats, 12.25], "short"), "beats-and-bars.downbeat-taps")).toBe("met");
      expect(statusOf(check([...shortBeats, ...shortDownbeats, 12.25, 14.25], "short"), "beats-and-bars.downbeat-taps")).toBe(
        "notMet",
      );
    });
  });
});
