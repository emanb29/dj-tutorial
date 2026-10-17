import { describe, expect, it } from "vitest";
import type { CheckVariant, ControlEvent } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BLEND_WINDOW, LESSON_AIDS, blendScenario, event, ramp, spec } from "../testing/synthetic.ts";

/** A's high-pass: on at `from`, at `depth` by 50 s, back to centre at `backAt` (A's fader closes at 56 s). */
function sweep({ from = 40, depth = 0.8, backAt = 57 }: { from?: number; depth?: number; backAt?: number | null } = {}): ControlEvent[] {
  return [
    event(from, "filter", 0.06, "A"),
    event(50, "filter", depth, "A"),
    ...(backAt === null ? [] : [event(backAt, "filter", 0, "A")]),
  ];
}

function check(
  filterEvents: readonly ControlEvent[],
  variant: CheckVariant = "full",
  faderEvents?: readonly ControlEvent[],
): CheckResult {
  const result = runCheck(
    spec({ lessonId: "filter-transition" }, BLEND_WINDOW, { variant, aids: { ...LESSON_AIDS, sync: true } }),
    blendScenario({ extraEvents: filterEvents, ...(faderEvents === undefined ? {} : { faderEvents }) }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("filter-transition", () => {
  it("passes an 8-bar high-pass out of A, deep enough, centred again right after", () => {
    const result = check(sweep());

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "filter-transition.hpf-depth",
      "filter-transition.filter-length",
      "filter-transition.cfx-back",
    ]);
    expect(byId(result, "filter-transition.filter-length")?.measured).toBeCloseTo(8);
  });

  it("needs at least 70% high-pass before A's fader closes", () => {
    expect(byId(check(sweep({ depth: 0.7 })), "filter-transition.hpf-depth")?.status).toBe("met");
    expect(byId(check(sweep({ depth: 0.69 })), "filter-transition.hpf-depth")?.status).toBe("notMet");
    // Turned to the low-pass side instead: no high-pass at all.
    expect(byId(check(sweep({ depth: -0.9 })), "filter-transition.hpf-depth")).toMatchObject({ status: "notMet", measured: 0.06 });
  });

  it("needs the filter on 8–16 bars (± 1 beat) before A leaves; 8–9 bars in the short form", () => {
    expect(byId(check(sweep({ from: 56 - 16 * BAR - 0.5 })), "filter-transition.filter-length")?.status).toBe("met");
    expect(byId(check(sweep({ from: 56 - 7 * BAR })), "filter-transition.filter-length")?.status).toBe("notMet");
    expect(byId(check(sweep(), "short"), "filter-transition.filter-length")?.status).toBe("met");
    expect(byId(check(sweep({ from: 56 - 10 * BAR }), "short"), "filter-transition.filter-length")?.status).toBe("notMet");
  });

  it("needs CFX A back within ±5% of centre within 1 bar of A going silent", () => {
    expect(byId(check(sweep({ backAt: 56 + BAR })), "filter-transition.cfx-back")?.status).toBe("met");
    expect(byId(check(sweep({ backAt: 56 + BAR + 0.1 })), "filter-transition.cfx-back")?.status).toBe("notMet");
    expect(byId(check(sweep({ backAt: null })), "filter-transition.cfx-back")).toMatchObject({ status: "notMet", measured: null });
  });

  it("times the filter from the move that starts the sustained sweep, ignoring an earlier nudge back to centre", () => {
    const nudgeFirst = [event(20, "filter", 0.3, "A"), event(20.3, "filter", 0, "A"), ...sweep()];
    expect(byId(check(nudgeFirst), "filter-transition.filter-length")).toMatchObject({ status: "met" });
    expect(byId(check(nudgeFirst), "filter-transition.filter-length")?.measured).toBeCloseTo(8);
    // A brief dip to centre inside the sweep does not restart it.
    const dip = [...sweep(), event(45, "filter", 0, "A"), event(45.2, "filter", 0.5, "A")].sort((a, b) => a.ctx - b.ctx);
    expect(byId(check(dip), "filter-transition.filter-length")?.measured).toBeCloseTo(8);
  });

  it("measures depth, length and reset from the first frame A is not audible, not from the start of its fader drag", () => {
    // A's fader dragged down at 50 Hz from 52 s; it drops under −24 dB at 56 s. The sweep reaches 0.75 at 55 s.
    const result = check(
      [event(40, "filter", 0.06, "A"), event(55, "filter", 0.75, "A"), event(57, "filter", 0, "A")],
      "full",
      [event(32, "channelFader", 1, "B"), ...ramp("channelFader", "A", { from: 52, to: 57.34 }, 1, 0)],
    );
    expect(byId(result, "filter-transition.hpf-depth")?.status).toBe("met");
    expect(byId(result, "filter-transition.filter-length")?.measured).toBeCloseTo(8, 1);
  });
});
