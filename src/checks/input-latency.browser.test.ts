// The Timing check's correction, end to end through the engine: a Learner whose taps land 60 ms late
// (input lag, or a habit of tapping after the sound) fails the beats-and-bars Check as they hear it, and
// passes once their measured latency is taken off their inputs. Rendered offline: never the speakers.
import { describe, expect, it } from "vitest";
import { createAudioEngine, type AudioEngine, type OutputClock } from "@audio";
import { offlineContext } from "@audio/offline-test-support.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "./run-check.ts";
import { BAR, BEAT, MUSIC, attempt, frames, playing, spec, taps } from "./testing/synthetic.ts";

/** Heard time is the input's performance time, so the test controls exactly when each tap is heard. */
function performanceClock(context: BaseAudioContext): OutputClock {
  return { heardTime: (performanceTimeMs) => ({ ok: true, ctx: performanceTimeMs === undefined ? context.currentTime : performanceTimeMs / 1000 }) };
}

const range = (count: number, first: number, step: number): number[] => Array.from({ length: count }, (_, index) => first + index * step);
const beatSection = { from: 4, to: 4 + 8 * BAR };
const downbeatSection = { from: beatSection.to, to: beatSection.to + 8 * BAR };
const targets = [...range(32, 4, BEAT), ...range(8, beatSection.to, BAR)];
const LATE_MS = 60;

/** Taps every target `LATE_MS` late through the engine, and grades the heard taps. */
function tapLateAndGrade(engine: AudioEngine): CheckResult {
  const heard: number[] = [];
  const stop = engine.on("command", (event) => {
    if (event.command.control === "tap" && event.heardCtx !== null) heard.push(event.heardCtx);
  });
  for (const target of targets) engine.command({ control: "tap" }, { device: "midi", eventTimeMs: target * 1000 + LATE_MS, gestureEnd: true });
  stop();
  const result = runCheck(
    spec({ lessonId: "beats-and-bars", beatSection, downbeatSection }, { from: 0, to: downbeatSection.to + 2 }),
    attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
      events: taps(heard),
      meters: { master: frames(0, 40, () => MUSIC), A: frames(0, 40, () => MUSIC) },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

describe("the Timing check's input correction", () => {
  it("fails taps 60 ms late without it, and passes them once the measured 60 ms is taken off", async () => {
    const context = offlineContext(1);
    const engine = await createAudioEngine({ context, clock: performanceClock(context), masterTempo: false });

    expect(tapLateAndGrade(engine).outcome.kind).toBe("failed");

    engine.setInputCorrection(LATE_MS);
    const corrected = tapLateAndGrade(engine);
    expect(corrected.outcome).toEqual({ kind: "passed" });
    expect(corrected.metrics["medianTapOffsetMs"]).toBeCloseTo(0, 6);
  });

  it("is held to ±150 ms, so a wild stored value cannot move taps further", async () => {
    const context = offlineContext(1);
    const engine = await createAudioEngine({ context, clock: performanceClock(context), masterTempo: false, inputCorrectionMs: 900 });
    expect(engine.inputCorrection).toBe(150);
  });
});
