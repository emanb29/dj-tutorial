import { describe, expect, it } from "vitest";
import type { CheckVariant } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BEAT, MUSIC, PHRASE, attempt, frames, playing, spec, taps } from "../testing/synthetic.ts";

/** Phrase starts heard at 8, 24 … 120 s (eight, full) inside the tap section. */
const MARKERS = [8, 24, 40, 56, 72, 88, 104, 120];
const SECTIONS = { breakdown: 3, drop: 4 };

function check(
  tapTimes: readonly number[],
  answers: Readonly<Record<string, number>> = SECTIONS,
  variant: CheckVariant = "full",
): CheckResult {
  const tapSection = variant === "full" ? { from: 4, to: 132 } : { from: 4, to: 52 };
  const result = runCheck(
    spec({ lessonId: "phrases", tapSection, sections: SECTIONS }, { from: 0, to: 136 }, { variant }),
    attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
      phraseMarkers: { "track-a": MARKERS },
      events: taps(tapTimes),
      answers,
      meters: { master: frames(0, 136, () => MUSIC), A: frames(0, 136, () => MUSIC) },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const statusOf = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id)?.status;

describe("phrases", () => {
  it("passes taps on every phrase start and both sections named", () => {
    const result = check(MARKERS);

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria[0]).toMatchObject({ id: "phrases.phrase-taps", measured: 8, detail: { extras: 0 } });
    expect(PHRASE).toBe(16);
  });

  it("allows a tap up to 1 beat off a phrase start, not more", () => {
    expect(check(MARKERS.map((t) => t + BEAT)).outcome.kind).toBe("passed");
    expect(statusOf(check(MARKERS.map((t) => t - BEAT - 0.01)), "phrases.phrase-taps")).toBe("notMet");
  });

  it("needs 6 of 8 phrase starts and at most 1 false tap", () => {
    expect(statusOf(check(MARKERS.slice(2)), "phrases.phrase-taps")).toBe("met");
    expect(statusOf(check(MARKERS.slice(3)), "phrases.phrase-taps")).toBe("notMet");
    expect(statusOf(check([...MARKERS, 16]), "phrases.phrase-taps")).toBe("met");
    expect(statusOf(check([...MARKERS, 16, 32]), "phrases.phrase-taps")).toBe("notMet");
  });

  it("fails tapping every bar: it hits each start but adds many false taps", () => {
    const everyBar = Array.from({ length: 64 }, (_, index) => 4 + index * 2);

    expect(check(everyBar).criteria[0]).toMatchObject({ status: "notMet", detail: { matched: 8 } });
  });

  it("needs both the breakdown and the drop named", () => {
    expect(statusOf(check(MARKERS, { breakdown: 3, drop: 5 }), "phrases.name-sections")).toBe("notMet");
    expect(statusOf(check(MARKERS, { drop: 4 }), "phrases.name-sections")).toBe("notMet");
  });

  describe("short form (32 bars, 3 starts, drop only)", () => {
    it("needs all 3 starts, no false tap, and only the drop", () => {
      expect(check([8, 24, 40], { drop: 4 }, "short").outcome.kind).toBe("passed");
      expect(statusOf(check([8, 24], { drop: 4 }, "short"), "phrases.phrase-taps")).toBe("notMet");
      expect(statusOf(check([8, 24, 40, 30], { drop: 4 }, "short"), "phrases.phrase-taps")).toBe("notMet");
      expect(statusOf(check([8, 24, 40], { drop: 2 }, "short"), "phrases.name-sections")).toBe("notMet");
    });
  });
});
