// Maps the performance clock (DOM event.timeStamp, performance.now()) onto the heard context timeline,
// using AudioContext.getOutputTimestamp() (check-design §1). One AudioContext means output latency
// cancels between decks, so grading on heard time leaves only the beat grid's error.

import { fail, type Result } from "./result.ts";
import type { CtxTime } from "./types.ts";

export interface OutputTimestamp {
  readonly contextTime: number;
  /** performance.now() milliseconds at which `contextTime` reached the output. */
  readonly performanceTime: number;
}

export function heardContextTime(timestamp: OutputTimestamp, performanceTimeMs: number): Result<{ ctx: CtxTime }> {
  // Chromium reports a zero timestamp until the output device is actually running.
  if (timestamp.performanceTime === 0) return fail({ kind: "output-not-running" });
  return { ok: true, ctx: timestamp.contextTime + (performanceTimeMs - timestamp.performanceTime) / 1000 };
}

/** How far back, in performance time, the fit looks at output timestamps. */
const FIT_WINDOW_MS = 2_000;
/** At most this many timestamps in the window (a reading per frame at 60 Hz is 120). */
const FIT_TIMESTAMPS_KEPT = 160;
/** A timestamp this far off the window's median is one of the load jumps (about 100 ms), not the clock. */
const OUTLIER_SEC = 0.015;
/**
 * A timestamp this far off the fit is a new clock, not a jump: the context resumed after a suspend, or
 * the output moved to another device. The fit starts again from it.
 */
const RESTART_SEC = 0.5;

/** The fit of contextTime against performance time: what to add to performance seconds to get heard time. */
export interface OutputClockFit {
  /** Takes in a reading of getOutputTimestamp(). A repeat of the last one is ignored. */
  add(timestamp: OutputTimestamp): void;
  /** Heard context time at `performanceTimeMs`, or null before any timestamp. */
  heardAt(performanceTimeMs: number): CtxTime | null;
  /** Forgets every timestamp: the next one starts a new fit. */
  reset(): void;
}

/**
 * A fit of the output clock that rides over Chromium's jumps under load (check-design §1, ISS-91).
 * Both clocks run at the same rate to a few parts per million, so over a 2 s window the line is
 * contextTime = performanceTime / 1000 + offset, and the fit is the offset: the median of the window's
 * offsets finds the line however far the jumps go, then the mean of the timestamps within OUTLIER_SEC of
 * it smooths the jitter. Jumps are a minority of a window's timestamps; a step that lasts (a new output
 * latency) becomes the majority within a second and the fit follows it.
 */
export function outputClockFit(): OutputClockFit {
  // Oldest first.
  let timestamps: { readonly performanceTime: number; readonly offset: number }[] = [];
  let last: OutputTimestamp | null = null;
  let offset: number | null = null;
  const refit = () => {
    const sorted = timestamps.map((each) => each.offset).sort((a, b) => a - b);
    const middle = sorted.length / 2;
    const median = sorted.length % 2 === 1 ? (sorted[Math.floor(middle)] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    const inliers = sorted.filter((each) => Math.abs(each - median) <= OUTLIER_SEC);
    // An even window split down the middle has no timestamp near its median: the median it is.
    offset = inliers.length === 0 ? median : inliers.reduce((sum, each) => sum + each, 0) / inliers.length;
  };
  return {
    add(timestamp) {
      if (last !== null && last.contextTime === timestamp.contextTime && last.performanceTime === timestamp.performanceTime) return;
      last = timestamp;
      const reading = { performanceTime: timestamp.performanceTime, offset: timestamp.contextTime - timestamp.performanceTime / 1000 };
      if (offset !== null && Math.abs(reading.offset - offset) > RESTART_SEC) timestamps = [];
      timestamps = [...timestamps.filter((each) => each.performanceTime > reading.performanceTime - FIT_WINDOW_MS), reading].slice(-FIT_TIMESTAMPS_KEPT);
      refit();
    },
    heardAt(performanceTimeMs) {
      return offset === null ? null : performanceTimeMs / 1000 + offset;
    },
    reset() {
      timestamps = [];
      last = null;
      offset = null;
    },
  };
}

/** The engine's view of heard time. Real contexts read the output timestamp; offline renders have no output. */
export interface OutputClock {
  /** Context time heard at `performanceTimeMs`, or now when omitted. */
  heardTime(performanceTimeMs?: number): Result<{ ctx: CtxTime }>;
}

/** How many recent answers the clock keeps to stay in order with (a few seconds of playhead reads). */
const ANSWERS_KEPT = 64;

/**
 * Heard time from the output timestamp, in the order things happened. Under load Chromium's timestamp
 * moves in jumps: one 36 ms after another can put contextTime about 100 ms earlier (ISS-84). Each
 * timestamp goes into a fit (`outputClockFit`) that rides over the jumps, so a tap is graded within a
 * few ms of when it was heard (ISS-91). The fit can still move a little from one timestamp to the
 * next, and mapped as they come, an input could be heard before one that happened earlier (a fader's
 * last move, to 0, sorted before the move it followed, so the attempt ended at 0.8%), and "now" could
 * fall before an input already heard (outside the attempt that recorded it). So:
 * - an input (a DOM event's time) is never heard before an earlier input already mapped;
 * - "now" is never heard before anything earlier already mapped.
 * An input is not held back by earlier readings of "now": it is placed with the newest fit, which is
 * what the Learner's beat was measured against.
 *
 * Nothing is heard before it is rendered: heard time never passes `currentTime`. The output timestamp
 * can run ahead of it (a stale timestamp extrapolated across a late render callback, or the high side
 * of a jump that the ordering above holds on to), and a heard time past `currentTime` puts the present
 * after changes the engine has only just scheduled (`currentTime` + lookahead): a Check's own cue then
 * falls before its attempt starts, the Check cannot find it and voids (`sectionNotHeard`, the owner's
 * Lesson 2 report). `currentTime` only grows, so the cap keeps the ordering.
 */
export function audioContextClock(context: AudioContext): OutputClock {
  // Recent answers, oldest first.
  const answers: { readonly performanceTimeMs: number; readonly ctx: CtxTime; readonly input: boolean }[] = [];
  const fit = outputClockFit();
  return {
    heardTime(eventTimeMs?: number) {
      // A suspended context keeps its last timestamp; extrapolating it with the wall clock would invent
      // time. Its context time stood still meanwhile, so the fit starts again once it runs.
      if (context.state !== "running") {
        fit.reset();
        return fail({ kind: "output-not-running" });
      }
      const input = eventTimeMs !== undefined;
      const performanceTimeMs = eventTimeMs ?? performance.now();
      const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
      const mapped = heardContextTime({ contextTime, performanceTime }, performanceTimeMs);
      if (!mapped.ok) return mapped;
      fit.add({ contextTime, performanceTime });
      const fitted = fit.heardAt(performanceTimeMs) ?? mapped.ctx;
      const earlier = answers.filter((answer) => answer.performanceTimeMs <= performanceTimeMs && (answer.input || !input));
      const ctx = Math.min(context.currentTime, Math.max(fitted, ...earlier.map((answer) => answer.ctx)));
      answers.push({ performanceTimeMs, ctx, input });
      if (answers.length > ANSWERS_KEPT) answers.shift();
      return { ok: true, ctx };
    },
  };
}

/** For OfflineAudioContext: nothing is heard, so heard time is render time. */
export function renderTimeClock(context: BaseAudioContext): OutputClock {
  return {
    heardTime() {
      return { ok: true, ctx: context.currentTime };
    },
  };
}
