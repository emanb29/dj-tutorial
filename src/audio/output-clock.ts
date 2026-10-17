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

/** The engine's view of heard time. Real contexts read the output timestamp; offline renders have no output. */
export interface OutputClock {
  /** Context time heard at `performanceTimeMs`, or now when omitted. */
  heardTime(performanceTimeMs?: number): Result<{ ctx: CtxTime }>;
}

/** How many recent answers the clock keeps to stay in order with (a few seconds of playhead reads). */
const ANSWERS_KEPT = 64;

/**
 * Heard time from the output timestamp, in the order things happened. Under load Chromium's timestamp
 * moves in jumps: one 36 ms after another can put contextTime about 100 ms earlier (ISS-84). Mapped as
 * they come, an input could be heard before one that happened earlier (a fader's last move, to 0,
 * sorted before the move it followed, so the attempt ended at 0.8%), and "now" could fall before an
 * input already heard (outside the attempt that recorded it). So:
 * - an input (a DOM event's time) is never heard before an earlier input already mapped;
 * - "now" is never heard before anything earlier already mapped.
 * An input is not held back by earlier readings of "now": it is placed with the newest timestamp,
 * which is what the Learner's beat was measured against.
 */
export function audioContextClock(context: AudioContext): OutputClock {
  // Recent answers, oldest first.
  const answers: { readonly performanceTimeMs: number; readonly ctx: CtxTime; readonly input: boolean }[] = [];
  return {
    heardTime(eventTimeMs?: number) {
      // A suspended context keeps its last timestamp; extrapolating it with the wall clock would invent time.
      if (context.state !== "running") return fail({ kind: "output-not-running" });
      const input = eventTimeMs !== undefined;
      const performanceTimeMs = eventTimeMs ?? performance.now();
      const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
      const mapped = heardContextTime({ contextTime, performanceTime }, performanceTimeMs);
      if (!mapped.ok) return mapped;
      const earlier = answers.filter((answer) => answer.performanceTimeMs <= performanceTimeMs && (answer.input || !input));
      const ctx = Math.max(mapped.ctx, ...earlier.map((answer) => answer.ctx));
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
