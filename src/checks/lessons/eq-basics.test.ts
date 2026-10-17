import { describe, expect, it } from "vitest";
import type { ControlEvent } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, attempt, channel, event, frames, MUSIC, playing, spec } from "../testing/synthetic.ts";

const WINDOW = { from: 0, to: 48 };

/** A plays with its fader up; LOW A is cut at 16 s and back at 32 s (phrase starts) by default. */
function check(events: readonly ControlEvent[] = [event(16, "eqLow", -120, "A"), event(32, "eqLow", 0, "A")]): CheckResult {
  const result = runCheck(
    spec({ lessonId: "eq-basics" }, WINDOW),
    attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
      events,
      meters: { master: frames(0, 48, () => MUSIC), A: frames(0, 48, () => MUSIC) },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("eq-basics", () => {
  it("passes LOW cut for a phrase and back on the next phrase start, EQs centred at the end", () => {
    const result = check();

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["eq-basics.low-kill", "eq-basics.low-return", "eq-basics.eq-centred"]);
    expect(byId(result, "eq-basics.low-kill")?.measured).toBeCloseTo(8);
  });

  it("needs the low cut to −20 dB or below for at least 7 bars", () => {
    expect(byId(check([event(16, "eqLow", -20, "A"), event(16 + 7 * BAR, "eqLow", 0, "A")]), "eq-basics.low-kill")?.status).toBe("met");
    expect(byId(check([event(16, "eqLow", -19, "A"), event(32, "eqLow", 0, "A")]), "eq-basics.low-kill")?.status).toBe("notMet");
    expect(byId(check([event(16, "eqLow", -120, "A"), event(16 + 6.9 * BAR, "eqLow", 0, "A")]), "eq-basics.low-kill")?.status).toBe(
      "notMet",
    );
  });

  it("times the return when LOW is back at −1 dB or above, within 1 beat of a phrase start", () => {
    const turned = [event(16, "eqLow", -120, "A"), event(31.6, "eqLow", -10, "A"), event(32 + 0.4, "eqLow", -1, "A"), event(32.6, "eqLow", 0, "A")];
    expect(byId(check(turned), "eq-basics.low-return")).toMatchObject({ status: "met" });
    expect(byId(check(turned), "eq-basics.low-return")?.measured).toBeCloseTo(0.8);
    expect(byId(check([event(16, "eqLow", -120, "A"), event(32 + 2 * BEAT, "eqLow", 0, "A")]), "eq-basics.low-return")?.status).toBe(
      "notMet",
    );
    expect(byId(check([event(16, "eqLow", -120, "A")]), "eq-basics.low-return")).toMatchObject({ status: "notMet", measured: null });
  });

  it("needs every band within 1 dB of centre at the end", () => {
    const base = [event(16, "eqLow", -120, "A"), event(32, "eqLow", 0, "A")];
    expect(byId(check([...base, event(40, "eqHigh", 0.9, "A")]), "eq-basics.eq-centred")?.status).toBe("met");
    expect(byId(check([...base, event(40, "eqHigh", 2, "A")]), "eq-basics.eq-centred")).toMatchObject({ status: "notMet", measured: 2 });
  });
});
