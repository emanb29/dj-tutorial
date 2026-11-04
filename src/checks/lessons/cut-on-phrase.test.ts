import { describe, expect, it } from "vitest";
import type { CheckMode } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import {
  BAR,
  BEAT,
  CUT_WINDOW,
  applied,
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

  it("times B's Play from the press, so output latency and the engine's lookahead never count against the Learner", () => {
    // Bluetooth headphones and the lookahead: B's audio starts 250 ms after the press heard on the 1.
    const lateAudio = (pressedAt: number) =>
      cutScenario({
        playB: pressedAt + 0.25,
        closeA: [event(pressedAt, "channelFader", 0, "A")],
        extraEvents: [event(20, "channelFader", 1, "B"), applied(pressedAt, "play", 1, "B", 0.25)],
      });
    const graded = (recorded: ReturnType<typeof lateAudio>) =>
      runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { passedLessons: ["deck-basics", "gain-staging"] }), recorded);

    const onTheOne = graded(lateAudio(32));
    if (!("criteria" in onTheOne)) throw new Error("expected a graded result");
    expect(byId(onTheOne, "cut-on-phrase.cut-start")).toMatchObject({ status: "met" });
    expect(byId(onTheOne, "cut-on-phrase.cut-start")?.measured).toBeCloseTo(0);
    expect(byId(onTheOne, "cut-on-phrase.cut-tight")?.measured).toBeCloseTo(0);
    expect(byId(onTheOne, "cut-on-phrase.cut-start")?.evidence).toEqual([{ from: 32, to: 32, label: "B plays" }]);

    const late = graded(lateAudio(32.13));
    if (!("criteria" in late)) throw new Error("expected a graded result");
    expect(byId(late, "cut-on-phrase.cut-start")).toMatchObject({ status: "notMet" });
    expect(byId(late, "cut-on-phrase.cut-start")?.measured).toBeCloseTo(130);
  });

  it("ignores a Play that did not start B's run (on deck A, or applied elsewhere): then B's audio start is all there is", () => {
    const recorded = cutScenario({ playB: 32.25, extraEvents: [applied(32, "play", 1, "A", 0.25), applied(31, "play", 1, "B", 0.25)] });
    const result = runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { passedLessons: ["gain-staging"] }), recorded);
    if (!("criteria" in result)) throw new Error("expected a graded result");
    expect(byId(result, "cut-on-phrase.cut-start")?.measured).toBeCloseTo(250);
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

  it("fails a master loudness jump over 3 dB across the cut (the 3 dB loud-steady allows a blend)", () => {
    expect(byId(check({ jumpDb: 3 }), "cut-on-phrase.loud-jump")?.status).toBe("met");
    expect(byId(check({ jumpDb: -3.5 }), "cut-on-phrase.loud-jump")).toMatchObject({ status: "notMet" });
  });

  it("takes the crossfader curve's own change off the jump: centred with A alone (−3 dB) to all B (0 dB) is +3 dB by design", () => {
    // The crossfader starts centred; it is slammed to B with the cut, so B plays at 0 dB where A played at −3 dB.
    const toB = [event(32, "crossfader", 1)];
    expect(byId(check({ jumpDb: 3, extraEvents: toB }), "cut-on-phrase.loud-jump")).toMatchObject({ status: "met", measured: expect.closeTo(0, 1) as number });
    // The curve's 3 dB, and B 3.5 dB hotter than A: a real mismatch still fails.
    expect(byId(check({ jumpDb: 6.5, extraEvents: toB }), "cut-on-phrase.loud-jump")).toMatchObject({ status: "notMet", measured: expect.closeTo(3.5, 1) as number });
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
