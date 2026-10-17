import { describe, expect, it } from "vitest";
import type { CheckVariant } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, BLEND_WINDOW, LESSON_AIDS, blendScenario, event, spec, type BlendScenario } from "../testing/synthetic.ts";

function check(scenario: BlendScenario = {}, variant: CheckVariant = "full"): CheckResult {
  const result = runCheck(
    spec({ lessonId: "sync-blend" }, BLEND_WINDOW, { variant, aids: { ...LESSON_AIDS, sync: true } }),
    blendScenario(scenario),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("sync-blend", () => {
  it("passes a 12-bar blend started on A's phrase start, level steady, trim untouched", () => {
    const result = check();

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "sync-blend.blend-start",
      "sync-blend.blend-length",
      "sync-blend.loud-steady",
      "sync-blend.trim-untouched",
    ]);
  });

  it("starts within 1 beat of A's phrase start, timing the fader from the start of its move", () => {
    expect(byId(check({ inB: 32 + BEAT }), "sync-blend.blend-start")?.status).toBe("met");
    expect(byId(check({ inB: 32 + BEAT + 0.05 }), "sync-blend.blend-start")?.status).toBe("notMet");
    expect(byId(check({ inB: 32 - BEAT - 0.05, playB: 30 }), "sync-blend.blend-start")?.status).toBe("notMet");
    const drag = [0.15, 0.3, 0.5, 0.7, 1].map((value, index) => event(32 + index * 0.2, "channelFader", value, "B"));
    const late = check({ faderEvents: [...drag, event(56, "channelFader", 0, "A")] });
    expect(byId(late, "sync-blend.blend-start")?.measured).toBeCloseTo(0, 5);
  });

  it("needs the blend between 8 bars − 1 beat and 16 bars + 1 beat", () => {
    expect(byId(check({ outA: 32 + 8 * BAR - BEAT }), "sync-blend.blend-length")?.status).toBe("met");
    expect(byId(check({ outA: 32 + 8 * BAR - BEAT - 0.1 }), "sync-blend.blend-length")?.status).toBe("notMet");
    expect(byId(check({ outA: 32 + 16 * BAR + BEAT }), "sync-blend.blend-length")?.status).toBe("met");
    expect(byId(check({ outA: 32 + 16 * BAR + BEAT + 0.1 }), "sync-blend.blend-length")?.status).toBe("notMet");
  });

  it("needs an 8–9 bar blend in the short form", () => {
    expect(byId(check({}, "short"), "sync-blend.blend-length")?.status).toBe("notMet");
    expect(byId(check({ outA: 32 + 8.5 * BAR }, "short"), "sync-blend.blend-length")?.status).toBe("met");
  });

  it("keeps master loudness within 3 dB of the 4 bars before the blend, until 4 bars after A leaves", () => {
    const bump = (db: number) => (t: number) => (t >= 40 && t < 42 ? -14 + db : -14);
    expect(byId(check({ masterLufs: bump(3) }), "sync-blend.loud-steady")?.status).toBe("met");
    expect(byId(check({ masterLufs: bump(3.5) }), "sync-blend.loud-steady")).toMatchObject({ status: "notMet" });
    // A dip 4 bars after A leaves (56 + 8 = 64 s) is outside the span.
    expect(byId(check({ masterLufs: (t) => (t >= 66 ? -20 : -14) }), "sync-blend.loud-steady")?.status).toBe("met");
  });

  it("fails a trim move while both decks are audible, not one after", () => {
    expect(byId(check({ extraEvents: [event(40, "trim", -2, "B")] }), "sync-blend.trim-untouched")).toMatchObject({
      status: "notMet",
      measured: 1,
    });
    expect(byId(check({ extraEvents: [event(70, "trim", -2, "B")] }), "sync-blend.trim-untouched")?.status).toBe("met");
  });

  it("fails everything when A never leaves", () => {
    const result = check({ outA: 200 });
    expect(byId(result, "sync-blend.blend-length")).toMatchObject({ status: "notMet", measured: null });
  });
});
