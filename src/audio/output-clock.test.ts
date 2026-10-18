// The smoothed output clock (ISS-91) against a trace of output timestamps from a loaded machine.
import { afterEach, describe, expect, it, vi } from "vitest";
import { audioContextClock, heardContextTime, outputClockFit, type OutputTimestamp } from "./output-clock.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// The two timestamps recorded on a loaded machine (ISS-84), 36 ms apart: the second one's contextTime
// is 99 ms earlier, 135 ms off the line through the first.
const RECORDED: readonly OutputTimestamp[] = [
  { contextTime: 18.7853, performanceTime: 24_066.6 },
  { contextTime: 18.6863, performanceTime: 24_102.4 },
];
/** The true clock: the line through the first recorded timestamp, from before the jump. */
const TRUE_OFFSET_SEC = 18.7853 - 24.0666;
const truth = (performanceTimeMs: number) => performanceTimeMs / 1000 + TRUE_OFFSET_SEC;
const FRAME_MS = 16.7;

/** A timestamp `offSec` off the true clock at `performanceTime`. */
const off = (performanceTime: number, offSec: number): OutputTimestamp => ({ contextTime: truth(performanceTime) + offSec, performanceTime });

/**
 * A timestamp a frame from 22 s to 28 s of performance time, with ±2 ms of jitter, and three load
 * episodes as the machine produced them: the recorded jump back, held for 100 ms; the high side of a
 * jump, 100 ms ahead for 120 ms; and 250 ms of timestamps 100 ms behind.
 */
function loadedTrace(): OutputTimestamp[] {
  const [first, second] = RECORDED;
  if (first === undefined || second === undefined) throw new Error("two recorded timestamps");
  const recordedEpisode = { fromMs: first.performanceTime, toMs: 24_200 };
  const heldJump = Array.from({ length: 5 }, (_, index) => second.performanceTime + FRAME_MS * (index + 1))
    .filter((at) => at < recordedEpisode.toMs)
    .map((at) => ({ contextTime: second.contextTime + (at - second.performanceTime) / 1000, performanceTime: at }));
  const frames = Array.from({ length: Math.round(6_000 / FRAME_MS) }, (_, index) => 22_000 + FRAME_MS * index)
    .filter((at) => at < recordedEpisode.fromMs || at >= recordedEpisode.toMs)
    .map((at, index) => {
      const jitter = 0.002 * Math.sin(index * 1.7);
      if (at >= 25_000 && at < 25_120) return off(at, 0.1 + jitter);
      if (at >= 26_000 && at < 26_250) return off(at, -0.1 + jitter);
      return off(at, jitter);
    });
  return [...frames, first, second, ...heldJump].sort((a, b) => a.performanceTime - b.performanceTime);
}

/**
 * Plays the trace through the clock as the app reads it: a playhead read every frame, and taps every
 * 47 ms delivered 4 ms late. Returns each tap's heard time against the truth, and what the newest
 * timestamp alone would have said.
 */
function tapsAgainst(trace: readonly OutputTimestamp[]) {
  let nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  const newest = () => trace.filter((each) => each.performanceTime <= nowMs).at(-1) ?? { contextTime: 0, performanceTime: 0 };
  const context = {
    state: "running",
    // Rendered ahead of what is heard, by the output's latency.
    get currentTime() {
      return truth(nowMs) + 0.05;
    },
    getOutputTimestamp: newest,
  } as unknown as AudioContext;
  const clock = audioContextClock(context);
  const taps = Array.from({ length: 100 }, (_, index) => 22_500 + 47 * index + (index % 3));
  const errors = { fitted: [] as number[], newest: [] as number[] };
  for (const [index, frame] of trace.entries()) {
    const next = trace[index + 1]?.performanceTime ?? frame.performanceTime + FRAME_MS;
    nowMs = frame.performanceTime + 1;
    clock.heardTime();
    for (const tap of taps.filter((at) => at + 4 >= frame.performanceTime && at + 4 < next)) {
      nowMs = tap + 4;
      const heard = clock.heardTime(tap);
      const raw = heardContextTime(newest(), tap);
      if (heard.ok) errors.fitted.push(heard.ctx - truth(tap));
      if (raw.ok) errors.newest.push(raw.ctx - truth(tap));
    }
  }
  return { taps: taps.length, errors };
}

const worst = (errors: readonly number[]) => Math.max(...errors.map(Math.abs));

describe("smoothed output clock", () => {
  it("grades taps within ±10 ms of the truth against the recorded jumpy timestamps", () => {
    const { taps, errors } = tapsAgainst(loadedTrace());
    expect(errors.fitted).toHaveLength(taps);
    // The trace is as jumpy as the machine was: the newest timestamp alone is off by about 100 ms.
    expect(worst(errors.newest)).toBeGreaterThan(0.09);
    expect(worst(errors.fitted)).toBeLessThanOrEqual(0.01);
  });

  it("maps a tap on the recorded jump back where it was heard", () => {
    const fit = outputClockFit();
    for (const at of [23_900, 23_950, 24_000, 24_030]) fit.add(off(at, 0));
    for (const timestamp of RECORDED) fit.add(timestamp);
    expect(fit.heardAt(24_090)).toBeCloseTo(truth(24_090), 3);
  });

  it("has nothing to say before its first timestamp, then maps with it", () => {
    const fit = outputClockFit();
    expect(fit.heardAt(1_000)).toBeNull();
    fit.add({ contextTime: 10, performanceTime: 1_000 });
    expect(fit.heardAt(1_250)).toBeCloseTo(10.25, 9);
  });

  it("does not let a repeated stale timestamp outweigh the others", () => {
    const fit = outputClockFit();
    for (const at of [1_000, 1_017, 1_033, 1_050]) fit.add(off(at, 0));
    const stale = off(1_060, 0.1);
    for (let repeat = 0; repeat < 30; repeat += 1) fit.add(stale);
    expect(fit.heardAt(1_070)).toBeCloseTo(truth(1_070), 2);
  });

  it("follows a latency that changes for good within about a second", () => {
    const fit = outputClockFit();
    for (let at = 0; at < 2_000; at += FRAME_MS) fit.add(off(at, 0));
    // The output moved to a device 150 ms slower.
    for (let at = 2_000; at < 3_100; at += FRAME_MS) fit.add(off(at, -0.15));
    expect(fit.heardAt(3_100)).toBeCloseTo(truth(3_100) - 0.15, 2);
  });

  it("starts again at a new clock rather than averaging it with the old", () => {
    const fit = outputClockFit();
    for (let at = 0; at < 1_000; at += FRAME_MS) fit.add(off(at, 0));
    fit.add(off(1_000, -2));
    expect(fit.heardAt(1_000)).toBeCloseTo(truth(1_000) - 2, 9);
  });

  it("starts again after the context was suspended, whose time stood still meanwhile", () => {
    let state = "running";
    let timestamp = { contextTime: 10, performanceTime: 1_000 };
    const context = {
      get state() {
        return state;
      },
      currentTime: 1_000,
      getOutputTimestamp: () => timestamp,
    } as unknown as AudioContext;
    const clock = audioContextClock(context);
    expect(clock.heardTime(1_000)).toEqual({ ok: true, ctx: 10 });
    state = "suspended";
    expect(clock.heardTime(1_200)).toEqual({ ok: false, error: { kind: "output-not-running" } });
    // Resumed after 300 ms: context time is 300 ms behind where the old fit would put it.
    state = "running";
    timestamp = { contextTime: 10.1, performanceTime: 1_400 };
    const heard = clock.heardTime(1_400);
    expect(heard.ok && heard.ctx).toBeCloseTo(10.1, 9);
  });
});
