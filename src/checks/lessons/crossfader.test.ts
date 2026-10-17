import { describe, expect, it } from "vitest";
import type { ControlEvent } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BLEND_WINDOW, LESSON_AIDS, MUSIC, blendScenario, event, frames, ramp, spec } from "../testing/synthetic.ts";

const BLEND = { from: 0, to: 70 };
const CUT = { span: { from: 70, to: 96 }, incoming: "A" as const };

/**
 * Both channel faders up the whole time. Blend: crossfader from full A to centre at 32 s and to full B
 * 16 bars later. Cut: A, re-cued at 66 s, plays from its first phrase marker at 80 s (B's phrase
 * start), with the crossfader slammed back to A at `cutAt`.
 */
function crossfaderMoves({ cutAt = 80, cut = [event(cutAt, "crossfader", 0)] as readonly ControlEvent[] } = {}): ControlEvent[] {
  return [event(32, "crossfader", 0.5), event(32 + 16 * BAR, "crossfader", 1), ...cut];
}

function check(
  moves: readonly ControlEvent[],
  options: {
    short?: boolean;
    extra?: readonly ControlEvent[];
    cueAAt?: number | null;
    masterLufs?: (t: number) => number;
    aQuietUntil?: number;
  } = {},
): CheckResult {
  const cueAAt = options.cueAAt === undefined ? 70 : options.cueAAt;
  const scenario = blendScenario({
    initialB: { channelFader: 1 },
    crossfader: 0,
    faderEvents: [...moves, ...(options.extra ?? []), ...(cueAAt === null ? [] : [event(cueAAt, "cueMonitor", 1, "A")])],
    ...(options.masterLufs === undefined ? {} : { masterLufs: options.masterLufs }),
  });
  const quietUntil = options.aQuietUntil ?? 0;
  const withRecue = {
    ...scenario,
    meters: { ...scenario.meters, A: frames(0, 96, (t) => (t >= 80 && t < quietUntil ? { peak: -40, momentary: -45 } : MUSIC)) },
    decks: {
      ...scenario.decks,
      A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 1 }, { fromCtx: 66, pos: 66, rate: 0 }, { fromCtx: 80, pos: 0, rate: 1 }] } },
    },
  };
  const result = runCheck(
    spec({ lessonId: "crossfader", blendSection: BLEND, cutSection: options.short === true ? null : CUT }, BLEND_WINDOW, {
      variant: options.short === true ? "short" : "full",
      aids: { ...LESSON_AIDS, sync: true },
    }),
    withRecue,
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("crossfader", () => {
  it("passes a 16-bar crossfader blend and a crossfader cut on the phrase, channel faders up", () => {
    const result = check(crossfaderMoves());

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["crossfader.xf-blend", "crossfader.xf-cut", "crossfader.faders-up"]);
  });

  it("passes a continuous 50 Hz crossfade over 16 bars from the phrase start", () => {
    const crossfade = [...ramp("crossfader", undefined, { from: 32, to: 32 + 16 * BAR }, 0, 1), event(80, "crossfader", 0)];
    const result = check(crossfade);

    expect(byId(result, "crossfader.xf-blend")).toMatchObject({ status: "met" });
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("measures an even sweep short of its length: the ends are inaudible, so the Lesson asks for 10 bars, not 8", () => {
    const sweep = (bars: number) => check([...ramp("crossfader", undefined, { from: 32, to: 32 + bars * BAR }, 0, 1), event(80, "crossfader", 0)]);
    // B is heard from about 4% of the travel, A gone from about 96%: 8 bars measure about 7.4.
    expect(byId(sweep(8), "crossfader.xf-blend")).toMatchObject({ status: "notMet" });
    expect(byId(sweep(10), "crossfader.xf-blend")).toMatchObject({ status: "met" });
  });

  it("drops the cut in the short form, which needs sync-blend's short 8–9 bar blend", () => {
    const shortBlend = [event(32, "crossfader", 0.5), event(32 + 8.5 * BAR, "crossfader", 1)];
    const result = check(shortBlend, { short: true });

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["crossfader.xf-blend", "crossfader.faders-up"]);
    expect(byId(check(crossfaderMoves({ cut: [] }), { short: true }), "crossfader.xf-blend")?.status).toBe("notMet");
  });

  it("needs the incoming deck cued for 2 s before the cut, as cut-on-phrase does", () => {
    expect(byId(check(crossfaderMoves(), { cueAAt: 78 }), "crossfader.xf-cut")?.status).toBe("met");
    expect(byId(check(crossfaderMoves(), { cueAAt: 78.5 }), "crossfader.xf-cut")?.status).toBe("notMet");
    expect(byId(check(crossfaderMoves(), { cueAAt: null }), "crossfader.xf-cut")?.status).toBe("notMet");
  });

  it("fails a master loudness jump over 2 dB across the cut, as cut-on-phrase does", () => {
    const after = (db: number) => (t: number) => (t >= 80 ? -14 + db : -14);
    expect(byId(check(crossfaderMoves(), { masterLufs: after(2) }), "crossfader.xf-cut")?.status).toBe("met");
    expect(byId(check(crossfaderMoves(), { masterLufs: after(2.5) }), "crossfader.xf-cut")?.status).toBe("notMet");
  });

  it("times the cut from the incoming deck's Play, not from when it becomes audible", () => {
    // Crossfader slammed to A's side at 79.75 s; A's Play at 80 s on the phrase; A's first 200 ms are
    // under −40 LUFS (not audible), so its first audible frame is 80.2 s.
    const quietStart = check(crossfaderMoves({ cutAt: 79.75 }), { aQuietUntil: 80.2 });
    expect(byId(quietStart, "crossfader.xf-cut")).toMatchObject({ status: "met", measured: 0 });
  });

  it("allows the cut ±80 ms off the phrase start (a later Lesson than cut-on-phrase)", () => {
    expect(byId(check(crossfaderMoves({ cutAt: 80.08 })), "crossfader.xf-cut")?.status).toBe("met");
    expect(byId(check(crossfaderMoves({ cutAt: 80.09 })), "crossfader.xf-cut")?.status).toBe("notMet");
  });

  it("times a crossfader drag from its start, so a slow drag that starts on the phrase passes", () => {
    const drag = [0.85, 0.7, 0.5, 0.3, 0.15, 0.05, 0].map((value, index) => event(80 + index * 0.13, "crossfader", value));
    expect(byId(check(crossfaderMoves({ cut: drag })), "crossfader.xf-cut")?.status).toBe("met");
  });

  it("fails a blend off the phrase or too short, like sync-blend", () => {
    const offPhrase = [event(32 + 2 * BAR, "crossfader", 0.5), event(32 + 18 * BAR, "crossfader", 1), event(80, "crossfader", 0)];
    expect(byId(check(offPhrase), "crossfader.xf-blend")?.status).toBe("notMet");
    const short = [event(32, "crossfader", 0.5), event(32 + 4 * BAR, "crossfader", 1), event(80, "crossfader", 0)];
    expect(byId(check(short), "crossfader.xf-blend")?.status).toBe("notMet");
  });

  it("needs both channel faders at 0.95 or above throughout", () => {
    expect(byId(check(crossfaderMoves(), { extra: [event(40, "channelFader", 0.95, "A")] }), "crossfader.faders-up")?.status).toBe("met");
    expect(byId(check(crossfaderMoves(), { extra: [event(40, "channelFader", 0.9, "A")] }), "crossfader.faders-up")).toMatchObject({
      status: "notMet",
      measured: 0.9,
    });
  });
});
