import { describe, expect, it } from "vitest";
import type { Attempt } from "@shared/attempt.ts";
import { runCheck } from "./run-check.ts";
import { BAR, MUSIC, SILENT, attempt, event, frames, grid, playing, spec } from "./testing/synthetic.ts";

const WINDOW = { from: 0, to: 30 };
const deckBasics = spec({ lessonId: "deck-basics" }, WINDOW, {
  tracks: [{ trackId: "track-a", trackSetId: "set-1", deck: "A" }],
});

/** A plays from 2 s; the fader opens at `openAt` and closes to `endFader` at 20 s. */
function fadeInAndOut({ openAt = 3, endFader = 0, peak = -3 } = {}): Attempt {
  return attempt({
    decks: { A: { trackId: "track-a", playhead: { segments: playing(2) } } },
    events: [event(openAt, "channelFader", 1, "A"), event(20, "channelFader", endFader, "A")],
    meters: {
      master: frames(0, 30, (t) => (t >= 2 && t >= openAt && (t < 20 || endFader > 0) ? { ...MUSIC, peak } : SILENT)),
      A: frames(0, 30, (t) => (t >= 2 ? MUSIC : SILENT)),
    },
  });
}

describe("runCheck: void attempts", () => {
  it("voids an abandoned attempt instead of failing it", () => {
    const result = runCheck(deckBasics, { ...fadeInAndOut(), abandoned: true });

    expect(result.outcome).toEqual({ kind: "void", reason: "abandoned" });
    expect("criteria" in result).toBe(false);
  });

  it("voids an attempt whose AudioContext suspended or tab hid inside the task window", () => {
    expect(runCheck(deckBasics, { ...fadeInAndOut(), interruptions: [{ ctx: 10, kind: "tabHidden" }] }).outcome).toEqual({
      kind: "void",
      reason: "tabHidden",
    });
    expect(
      runCheck(deckBasics, { ...fadeInAndOut(), interruptions: [{ ctx: 29.9, kind: "contextSuspended" }] }).outcome,
    ).toEqual({ kind: "void", reason: "contextSuspended" });
  });

  it("ignores interruptions outside the task window", () => {
    const result = runCheck(deckBasics, { ...fadeInAndOut(), interruptions: [{ ctx: 31, kind: "tabHidden" }] });

    expect(result.outcome.kind).toBe("passed");
  });

  it("voids an attempt whose track has no beat grid, or a grid residual that is not a number", () => {
    expect(runCheck(deckBasics, { ...fadeInAndOut(), grids: {} }).outcome).toEqual({ kind: "void", reason: "gridUntrusted" });
    expect(
      runCheck(deckBasics, { ...fadeInAndOut(), grids: { "track-a": grid({ rmsResidualMs: Number.NaN }) } }).outcome,
    ).toEqual({ kind: "void", reason: "gridUntrusted" });
  });

  it("refuses a task with nothing to grade instead of passing it", () => {
    const empty = spec({ lessonId: "gain-staging", decks: [] }, WINDOW);

    expect(() => runCheck(empty, fadeInAndOut())).toThrow(/no criteria/);
  });

  it("voids an attempt on a beat grid too uneven to grade (residual over 15 ms)", () => {
    const untrusted = { ...fadeInAndOut(), grids: { "track-a": grid({ rmsResidualMs: 15.5 }) } };

    expect(runCheck(deckBasics, untrusted).outcome).toEqual({ kind: "void", reason: "gridUntrusted" });
    expect(runCheck(deckBasics, { ...untrusted, grids: { "track-a": grid({ rmsResidualMs: 15 }) } }).outcome.kind).toBe(
      "passed",
    );
  });
});

describe("runCheck: deck-basics", () => {
  it("passes a fade in within 4 bars of Play and a fade out to zero, without clipping", () => {
    const result = runCheck(deckBasics, fadeInAndOut());

    expect(result.outcome).toEqual({ kind: "passed" });
    if (!("criteria" in result)) return;
    expect(result.criteria.map((criterion) => [criterion.id, criterion.status])).toEqual([
      ["deck-basics.fade-in", "met"],
      ["deck-basics.fade-out", "met"],
      ["deck-basics.no-clip-local", "met"],
    ]);
    expect(result.criteria[0]?.measured).toBeCloseTo(0.5);
  });

  it("copies the attempt's identity, tracks, aids and input device into the result", () => {
    const result = runCheck(deckBasics, fadeInAndOut());

    expect(result).toMatchObject({
      schemaVersion: 1,
      attemptId: "attempt-1",
      learnerId: "learner-1",
      lessonId: "deck-basics",
      mode: "lesson",
      variant: "full",
      inputDevice: "keyboard",
      startedAt: "2026-10-17T10:00:00.000Z",
      endedAt: "2026-10-17T10:01:00.000Z",
      tracks: [{ trackId: "track-a", trackSetId: "set-1", deck: "A" }],
    });
  });

  it("accepts a fade in exactly 4 bars after Play and fails one later", () => {
    expect(runCheck(deckBasics, fadeInAndOut({ openAt: 2 + 4 * BAR })).outcome.kind).toBe("passed");
    expect(runCheck(deckBasics, fadeInAndOut({ openAt: 2 + 4 * BAR + 0.1 })).outcome).toEqual({
      kind: "failed",
      failedCriteria: ["deck-basics.fade-in"],
    });
  });

  it("fails when the fader is not fully down at the end", () => {
    expect(runCheck(deckBasics, fadeInAndOut({ endFader: 0.02 })).outcome).toEqual({
      kind: "failed",
      failedCriteria: ["deck-basics.fade-out"],
    });
  });

  it("fails on one master frame over −0.1 dBFS and passes at exactly −0.1", () => {
    expect(runCheck(deckBasics, fadeInAndOut({ peak: 0 })).outcome).toEqual({
      kind: "failed",
      failedCriteria: ["deck-basics.no-clip-local"],
    });
    expect(runCheck(deckBasics, fadeInAndOut({ peak: -0.1 })).outcome.kind).toBe("passed");
  });

  it("fails the fade in, with nothing measured, when the track never plays", () => {
    const result = runCheck(deckBasics, { ...fadeInAndOut(), decks: {} });

    if (!("criteria" in result)) throw new Error("expected a graded result");
    expect(result.criteria[0]).toMatchObject({ id: "deck-basics.fade-in", status: "notMet", measured: null });
  });

  it("is deterministic: the same input gives the same result", () => {
    expect(runCheck(deckBasics, fadeInAndOut())).toEqual(runCheck(deckBasics, fadeInAndOut()));
  });
});

