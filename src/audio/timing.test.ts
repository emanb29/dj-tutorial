import { afterEach, describe, expect, it, vi } from "vitest";
import { barBeatAt, beatAt, beatGridProblems, beatLengthSec, positionOfBeat, type BeatGrid } from "./beat-grid.ts";
import { audioContextClock, heardContextTime } from "./output-clock.ts";
import { PlayheadTracker } from "./playhead.ts";
import { phaseAlignedPosition, syncTempo } from "./sync.ts";
import { tempoFaderForRate, tempoRate } from "./tempo.ts";

const grid = (bpm: number, firstBeat: number, downbeatIndex = 0): BeatGrid => ({ bpm, firstBeat, downbeatIndex, rmsResidualMs: 3 });
const grid120 = grid(120, 0.25, 1);

describe("tempo fader", () => {
  it("maps the fader ends to the range and the centre to unity", () => {
    expect(tempoRate(0, 6)).toBe(1);
    expect(tempoRate(1, 6)).toBeCloseTo(1.06, 12);
    expect(tempoRate(-1, 10)).toBeCloseTo(0.9, 12);
    expect(tempoRate(0.5, 16)).toBeCloseTo(1.08, 12);
  });

  it("finds the fader position for a rate, or reports that the range cannot reach it", () => {
    expect(tempoFaderForRate(1.03, 6)).toEqual({ ok: true, fader: expect.closeTo(0.5, 9) as number });
    expect(tempoFaderForRate(1.08, 6)).toEqual({
      ok: false,
      error: { kind: "tempo-out-of-range", requestedRate: 1.08, rangePercent: 6 },
    });
  });
});

describe("beat grid", () => {
  it("counts beats from the first beat at the grid tempo", () => {
    expect(beatAt(grid120, 0.25)).toBe(0);
    expect(beatAt(grid120, 1.25)).toBe(2);
    expect(beatAt(grid120, 0)).toBe(-0.5);
    expect(positionOfBeat(grid120, 2)).toBe(1.25);
  });

  it("names the bar and beat-in-bar, with beat 1 at the downbeat", () => {
    // Beat index 1 is the first downbeat, so beat index 0 is beat 4 of bar 0.
    expect(barBeatAt(grid120, positionOfBeat(grid120, 1))).toEqual({ bar: 1, beatInBar: 1 });
    expect(barBeatAt(grid120, positionOfBeat(grid120, 0))).toEqual({ bar: 0, beatInBar: 4 });
    expect(barBeatAt(grid120, positionOfBeat(grid120, 6.5))).toEqual({ bar: 2, beatInBar: 2 });
  });

  it("shortens the heard beat when the deck plays faster", () => {
    expect(beatLengthSec(grid120, 1)).toBe(0.5);
    expect(beatLengthSec(grid120, 1.25)).toBe(0.4);
  });

  it("lists every problem with a bad grid", () => {
    expect(beatGridProblems(grid120)).toEqual([]);
    expect(beatGridProblems({ bpm: 0, firstBeat: Number.NaN, downbeatIndex: 4, rmsResidualMs: -1 })).toHaveLength(4);
  });
});

describe("playhead tracker", () => {
  it("integrates position across rate segments, including a jog bend", () => {
    const tracker = new PlayheadTracker({ durationSec: 300 });
    tracker.seek(10, 0);
    tracker.setRate(11, 1); // play
    tracker.setRate(13, 1.1); // jog bend
    tracker.setRate(14, 1); // release

    expect(tracker.positionAt(10.5)).toBe(0);
    expect(tracker.positionAt(12)).toBe(1);
    expect(tracker.positionAt(13.5)).toBeCloseTo(2.55, 12);
    expect(tracker.positionAt(15)).toBeCloseTo(4.1, 12);
  });

  it("is stopped at position 0 before its first segment", () => {
    const tracker = new PlayheadTracker({ durationSec: 300 });
    expect(tracker.positionAt(9)).toBe(0);
    expect(tracker.segments()).toEqual([]);
  });

  it("jumps on seek and stops at the end of the track", () => {
    const tracker = new PlayheadTracker({ durationSec: 10 });
    tracker.setRate(0, 1);
    tracker.seek(2, 8);

    expect(tracker.positionAt(1)).toBe(1);
    expect(tracker.positionAt(3)).toBe(9);
    expect(tracker.positionAt(100)).toBe(10);
  });

  it("exports segments in the attempt contract's shape, merging same-time changes", () => {
    const tracker = new PlayheadTracker({ durationSec: 10 });
    tracker.seek(1, 5);
    tracker.setRate(1, 1);
    expect(tracker.segments()).toEqual([{ fromCtx: 1, pos: 5, rate: 1 }]);
  });

  it("skips changes that change nothing", () => {
    const tracker = new PlayheadTracker({ durationSec: 10 });
    tracker.setRate(1, 1);
    tracker.setRate(2, 1);
    tracker.setRate(3, 1);
    expect(tracker.segments()).toHaveLength(1);
  });

  it("reports the time of its latest change, or null before any", () => {
    const tracker = new PlayheadTracker({ durationSec: 10 });
    expect(tracker.lastCtx()).toBeNull();
    tracker.seek(1, 5);
    tracker.setRate(3, 1);
    expect(tracker.lastCtx()).toBe(3);
  });

  it("refuses to rewrite history, as a typed error", () => {
    const tracker = new PlayheadTracker({ durationSec: 10 });
    tracker.setRate(5, 1);
    expect(tracker.setRate(4, 0)).toEqual({ ok: false, error: { kind: "playhead-out-of-order", atCtx: 4, lastCtx: 5 } });
  });

  it("is bounded: past its segment limit it refuses changes with a typed error", () => {
    const tracker = new PlayheadTracker({ durationSec: 10, segmentLimit: 2 });
    expect(tracker.setRate(1, 1)).toEqual({ ok: true });
    expect(tracker.setRate(2, 1.1)).toEqual({ ok: true });
    expect(tracker.setRate(3, 1)).toEqual({ ok: false, error: { kind: "playhead-full", limit: 2 } });
    expect(tracker.segments()).toHaveLength(2);
  });
});

describe("output clock", () => {
  it("maps a performance time onto the heard context timeline", () => {
    const timestamp = { contextTime: 20, performanceTime: 5_000 };
    expect(heardContextTime(timestamp, 5_250)).toEqual({ ok: true, ctx: 20.25 });
  });

  it("reports when the output has not started", () => {
    expect(heardContextTime({ contextTime: 0, performanceTime: 0 }, 5_250)).toEqual({
      ok: false,
      error: { kind: "output-not-running" },
    });
  });

  it("never extrapolates with the wall clock while the context is suspended", () => {
    const suspended = {
      state: "suspended",
      getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 1_000 }),
    } as unknown as AudioContext;
    expect(audioContextClock(suspended).heardTime(9_000)).toEqual({ ok: false, error: { kind: "output-not-running" } });
  });

  // Two output timestamps 36 ms apart from a loaded machine (ISS-84): the second one's contextTime
  // is 99 ms earlier. Mapped as they are, the fader's last move (to 0) was heard before the one
  // before it (0.008), so the attempt ended at 0.008 and "fade out" failed with the fader down.
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const loadedTimestamps = [
    { contextTime: 18.7853, performanceTime: 24_066.6 },
    { contextTime: 18.6863, performanceTime: 24_102.4 },
  ];
  // `currentTime`: how far the graph has rendered; far ahead unless a test is about it.
  function clockReading(timestamps: readonly { contextTime: number; performanceTime: number }[], currentTime = 1_000_000) {
    let next = 0;
    const context = {
      state: "running",
      currentTime,
      getOutputTimestamp: () => timestamps[Math.min(next++, timestamps.length - 1)],
    } as unknown as AudioContext;
    return audioContextClock(context);
  }
  const ctxOf = (reading: ReturnType<ReturnType<typeof audioContextClock>["heardTime"]>) => (reading.ok ? reading.ctx : Number.NaN);

  it("keeps inputs in the order they happened when the output timestamp jumps back", () => {
    const clock = clockReading(loadedTimestamps);
    const earlier = ctxOf(clock.heardTime(24_024.6));
    const later = ctxOf(clock.heardTime(24_067.3));
    expect(earlier).toBeCloseTo(18.7433, 4);
    expect(later).toBeGreaterThanOrEqual(earlier);
  });

  it("keeps the present after an input already heard", () => {
    const clock = clockReading(loadedTimestamps);
    const move = ctxOf(clock.heardTime(24_060));
    vi.spyOn(performance, "now").mockReturnValue(24_102.4);
    const now = ctxOf(clock.heardTime());
    expect(now).toBeGreaterThanOrEqual(move);
  });

  // A tap the main thread got to late, after a reading of "now": it is placed where it was heard, not
  // held back to that later reading.
  it("does not hold a late-delivered input back to a later reading of now", () => {
    const clock = clockReading([
      { contextTime: 10, performanceTime: 1_000 },
      { contextTime: 10.1, performanceTime: 1_100 },
    ]);
    vi.spyOn(performance, "now").mockReturnValue(1_030);
    const readingAfterTap = ctxOf(clock.heardTime());
    const tap = ctxOf(clock.heardTime(1_020));
    expect(readingAfterTap).toBeCloseTo(10.03, 9);
    expect(tap).toBeCloseTo(10.02, 9);
  });

  // The owner's Lesson 2 voids: a heard "now" past what was rendered put the Check's start after the
  // cue the session had just scheduled (currentTime + lookahead), so the Check never found its cue.
  it("never hears past what has been rendered, even extrapolating a stale timestamp", () => {
    const clock = clockReading([{ contextTime: 10, performanceTime: 1_000 }], 10.02);
    vi.spyOn(performance, "now").mockReturnValue(1_050);
    expect(ctxOf(clock.heardTime())).toBeCloseTo(10.02, 9);
    expect(ctxOf(clock.heardTime(1_040))).toBeCloseTo(10.02, 9);
  });

  it("holds the high side of a timestamp jump only up to what has been rendered", () => {
    const clock = clockReading(loadedTimestamps, 18.8);
    vi.spyOn(performance, "now").mockReturnValue(24_090);
    const before = ctxOf(clock.heardTime());
    vi.spyOn(performance, "now").mockReturnValue(24_102.4);
    const after = ctxOf(clock.heardTime());
    expect(before).toBeLessThanOrEqual(18.8);
    expect(after).toBeLessThanOrEqual(18.8);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("maps as before while the output timestamps agree", () => {
    const clock = clockReading([
      { contextTime: 20, performanceTime: 5_000 },
      { contextTime: 20.5, performanceTime: 5_500 },
    ]);
    expect(ctxOf(clock.heardTime(5_250))).toBeCloseTo(20.25, 9);
    expect(ctxOf(clock.heardTime(5_600))).toBeCloseTo(20.6, 9);
  });
});

describe("beat sync", () => {
  it("matches the leader's heard tempo", () => {
    const result = syncTempo({ leaderGrid: grid(128, 0), leaderRate: 1, followerGrid: grid(124, 0), followerRangePercent: 6 });
    expect(result.ok && result.rate).toBeCloseTo(128 / 124, 12);
    expect(result.ok && result.fader).toBeCloseTo(((128 / 124 - 1) * 100) / 6, 9);
  });

  it("refuses when the follower's tempo range cannot reach the leader", () => {
    const result = syncTempo({ leaderGrid: grid(140, 0), leaderRate: 1, followerGrid: grid(120, 0), followerRangePercent: 10 });
    expect(result).toMatchObject({ ok: false, error: { kind: "tempo-out-of-range" } });
  });

  it("moves the follower by less than half a beat to share the leader's beat phase", () => {
    // Leader is 0.2 of a beat past a beat; follower is 0.4 of a beat past one (0.1 + 20 × 0.5 + 0.2 s).
    const aligned = phaseAlignedPosition({ leaderGrid: grid(120, 0), leaderPos: 10.1, followerGrid: grid(120, 0.1), followerPos: 10.3 });
    expect(aligned).toBeCloseTo(10.2, 12);
  });

  it("wraps the phase the short way round", () => {
    // Leader 0.9 beats in, follower 0.1 beats in: the short way is back 0.2 beats.
    const aligned = phaseAlignedPosition({ leaderGrid: grid(120, 0), leaderPos: 0.45, followerGrid: grid(120, 0), followerPos: 5.05 });
    expect(aligned).toBeCloseTo(4.95, 12);
  });
});
