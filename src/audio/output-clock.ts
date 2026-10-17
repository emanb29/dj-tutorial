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

export function audioContextClock(context: AudioContext): OutputClock {
  return {
    heardTime(performanceTimeMs = performance.now()) {
      // A suspended context keeps its last timestamp; extrapolating it with the wall clock would invent time.
      if (context.state !== "running") return fail({ kind: "output-not-running" });
      const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
      return heardContextTime({ contextTime, performanceTime }, performanceTimeMs);
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
