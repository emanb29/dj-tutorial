import { describe, expect, it } from "vitest";
import type { ControlEvent } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BLEND_WINDOW, LESSON_AIDS, blendScenario, event, spec } from "../testing/synthetic.ts";

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

function check(moves: readonly ControlEvent[], options: { short?: boolean; extra?: readonly ControlEvent[] } = {}): CheckResult {
  const scenario = blendScenario({
    initialB: { channelFader: 1 },
    crossfader: 0,
    faderEvents: [...moves, ...(options.extra ?? [])],
  });
  const withRecue = {
    ...scenario,
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

  it("drops the cut in the short form", () => {
    const result = check(crossfaderMoves({ cut: [] }), { short: true });

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["crossfader.xf-blend", "crossfader.faders-up"]);
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
