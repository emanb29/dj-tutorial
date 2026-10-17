import { describe, expect, it } from "vitest";
import type { CheckVariant, ControlEvent } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BEAT, MUSIC, attempt, channel, event, frames, playing, spec, taps } from "../testing/synthetic.ts";

/** A on master from 0. B plays from 1.25 s (half a beat off A), fader down, cued. */
function check(tapTimes: readonly number[], extraEvents: readonly ControlEvent[] = [], variant: CheckVariant = "full"): CheckResult {
  const tapSection = variant === "full" ? { from: 4, to: 20 } : { from: 4, to: 12 };
  const result = runCheck(
    spec({ lessonId: "headphone-cue", tapSection }, { from: 0, to: 22 }, { variant }),
    attempt({
      decks: {
        A: { trackId: "track-a", playhead: { segments: playing(0) } },
        B: { trackId: "track-b", playhead: { segments: playing(1.25) } },
      },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel({ cueMonitor: true }), crossfader: 0.5 },
      events: [...taps(tapTimes), ...extraEvents].sort((a, b) => a.ctx - b.ctx),
      meters: { master: frames(0, 22, () => MUSIC), A: frames(0, 22, () => MUSIC), B: frames(0, 22, () => MUSIC) },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const range = (count: number, first: number, step: number): number[] =>
  Array.from({ length: count }, (_, index) => first + index * step);
const bBeats = range(32, 4.25, BEAT);
const aBeats = range(32, 4, BEAT);
const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("headphone-cue", () => {
  it("passes taps on B's beat while B stays off the master and cued", () => {
    const result = check(bBeats);

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["headphone-cue.cued-taps", "headphone-cue.b-off-master"]);
    expect(byId(result, "headphone-cue.b-off-master")).toMatchObject({ measured: -120, detail: { cueOnFraction: 1 } });
  });

  it("grades against B's grid: tapping A's beat fails", () => {
    expect(byId(check(aBeats), "headphone-cue.cued-taps")).toMatchObject({ status: "notMet", detail: { matched: 0 } });
  });

  it("allows ±50 ms, 85% of beats and 5 extras", () => {
    expect(byId(check(bBeats.map((t) => t + 0.05)), "headphone-cue.cued-taps")?.status).toBe("met");
    expect(byId(check(bBeats.map((t) => t + 0.051)), "headphone-cue.cued-taps")?.status).toBe("notMet");
    expect(byId(check(bBeats.slice(4)), "headphone-cue.cued-taps")?.status).toBe("met"); // 28/32 = 0.875
    expect(byId(check(bBeats.slice(5)), "headphone-cue.cued-taps")?.status).toBe("notMet"); // 27/32 = 0.84
    expect(byId(check([...bBeats, ...range(5, 4, 2)]), "headphone-cue.cued-taps")?.status).toBe("met");
    expect(byId(check([...bBeats, ...range(6, 4, 2)]), "headphone-cue.cued-taps")?.status).toBe("notMet");
  });

  it("fails when B's fader rises enough to reach the master, even briefly", () => {
    const flick = [event(8, "channelFader", 0.05, "B"), event(8.2, "channelFader", 0, "B")];
    const result = check(bBeats, flick);

    expect(byId(result, "headphone-cue.b-off-master")?.status).toBe("notMet");
    // The fader at 0.05 is −52 dB, and the crossfader's centre −3 dB more.
    expect(byId(result, "headphone-cue.b-off-master")?.measured).toBeCloseTo(-55.05, 1);
    expect(byId(check(bBeats, [event(8, "channelFader", 0.03, "B")]), "headphone-cue.b-off-master")?.status).toBe("met");
  });

  it("needs CUE B on for 95% of the tap section", () => {
    const cueOff = (seconds: number) => [event(10, "cueMonitor", 0, "B"), event(10 + seconds, "cueMonitor", 1, "B")];

    expect(byId(check(bBeats, cueOff(0.8)), "headphone-cue.b-off-master")?.status).toBe("met"); // 0.95
    expect(byId(check(bBeats, cueOff(1)), "headphone-cue.b-off-master")?.status).toBe("notMet");
  });

  it("short form: 4 bars, 85% of 16 beats, at most 2 extras", () => {
    const short = bBeats.slice(0, 16);

    expect(check(short, [], "short").outcome.kind).toBe("passed");
    expect(byId(check([...short, 4.1, 6.1, 8.1], [], "short"), "headphone-cue.cued-taps")?.status).toBe("notMet");
  });
});
