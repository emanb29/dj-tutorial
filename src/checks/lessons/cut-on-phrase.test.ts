import { describe, expect, it } from "vitest";
import type { CheckMode } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import {
  BAR,
  BEAT,
  CUT_WINDOW,
  attempt,
  channel,
  cutScenario,
  event,
  frames,
  playing,
  spec,
  type CutScenario,
} from "../testing/synthetic.ts";

function check({ mode = "lesson", ...scenario }: CutScenario & { readonly mode?: CheckMode } = {}): CheckResult {
  const result = runCheck(
    spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode, passedLessons: ["deck-basics", "gain-staging"] }),
    cutScenario(scenario),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("cut-on-phrase", () => {
  it("passes a keyboard cut on A's phrase start, cued first, with no loudness jump", () => {
    const result = check();

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "cut-on-phrase.cut-start",
      "cut-on-phrase.cut-tight",
      "cut-on-phrase.cued-before",
      "cut-on-phrase.loud-jump",
      "standing.no-clip",
    ]);
    expect(byId(result, "cut-on-phrase.cut-start")?.measured).toBeCloseTo(0);
  });

  it("allows Play ±120 ms off the phrase start in this Lesson (input leeway) and fails beyond", () => {
    expect(byId(check({ playB: 32.12 }), "cut-on-phrase.cut-start")?.status).toBe("met");
    expect(byId(check({ playB: 31.88 }), "cut-on-phrase.cut-start")?.status).toBe("met");
    expect(byId(check({ playB: 32.121 }), "cut-on-phrase.cut-start")?.status).toBe("notMet");
  });

  it("fails a cut on a bar that is not a phrase start", () => {
    expect(byId(check({ playB: 32 + 2 * BAR }), "cut-on-phrase.cut-start")).toMatchObject({ status: "notMet" });
    expect(byId(check({ playB: 32 + 2 * BAR }), "cut-on-phrase.cut-start")?.measured).toBeCloseTo(4000);
  });

  it("needs A out within 1 beat of B's Play", () => {
    expect(byId(check({ closeA: [event(32 + BEAT, "channelFader", 0, "A")] }), "cut-on-phrase.cut-tight")?.status).toBe("met");
    expect(byId(check({ closeA: [event(32 + BEAT + 0.05, "channelFader", 0, "A")] }), "cut-on-phrase.cut-tight")?.status).toBe(
      "notMet",
    );
    expect(byId(check({ closeA: [] }), "cut-on-phrase.cut-tight")).toMatchObject({ status: "notMet", measured: null });
  });

  it("times a trackpad drag from its start, so a drag that starts on time but lands late passes", () => {
    const drag = [0.95, 0.85, 0.7, 0.5, 0.3, 0.15, 0.05, 0].map((value, index) => event(32 + index * 0.1, "channelFader", value, "A"));

    expect(byId(check({ closeA: drag }), "cut-on-phrase.cut-tight")).toMatchObject({ status: "met" });
    expect(byId(check({ closeA: drag }), "cut-on-phrase.cut-tight")?.measured).toBeCloseTo(0.2, 1);
  });

  it("times the cut from the real Play, not an earlier CUE-hold preview in the headphones", () => {
    const base = cutScenario();
    const previewFirst = {
      ...base,
      decks: {
        ...base.decks,
        B: { trackId: "track-b", playhead: { segments: [...playing(10, 0, 11), { fromCtx: 11, pos: 0, rate: 0 }, ...playing(32, 0)] } },
      },
    };
    const result = runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { passedLessons: ["gain-staging"] }), previewFirst);

    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("needs CUE B on for 2 s before B comes in", () => {
    expect(byId(check({ cueOnAt: 30 }), "cut-on-phrase.cued-before")?.status).toBe("met");
    expect(byId(check({ cueOnAt: 30.5 }), "cut-on-phrase.cued-before")?.status).toBe("notMet");
    expect(byId(check({ cueOnAt: null }), "cut-on-phrase.cued-before")).toMatchObject({ status: "notMet", measured: 0 });
  });

  it("fails a master loudness jump over 2 dB across the cut", () => {
    expect(byId(check({ jumpDb: 2 }), "cut-on-phrase.loud-jump")?.status).toBe("met");
    expect(byId(check({ jumpDb: -2.5 }), "cut-on-phrase.loud-jump")).toMatchObject({ status: "notMet" });
  });

  it("fails everything timing-related when B never plays", () => {
    const result = runCheck(
      spec({ lessonId: "cut-on-phrase" }, { from: 0, to: 48 }),
      attempt({
        decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
        initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
        meters: { master: frames(0, 48, () => ({ peak: -3, momentary: -14 })), A: frames(0, 48, () => ({ peak: -3, momentary: -14 })) },
      }),
    );

    expect(result.outcome).toEqual({
      kind: "failed",
      failedCriteria: ["cut-on-phrase.cut-start", "cut-on-phrase.cut-tight", "cut-on-phrase.cued-before", "cut-on-phrase.loud-jump"],
    });
  });

  it("adds cue-point.cue-on-downbeat in Placement, so crediting cue-point rests on a measurement", () => {
    const result = check({ mode: "placement" });

    expect(byId(result, "cue-point.cue-on-downbeat")).toMatchObject({ status: "met" });
    expect(byId(check(), "cue-point.cue-on-downbeat")).toBeUndefined();
  });
});
