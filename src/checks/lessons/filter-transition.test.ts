import { describe, expect, it } from "vitest";
import type { CheckVariant } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import type { EngineCommandRecord } from "../deck-commands.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BLEND_WINDOW, LESSON_AIDS, blendScenario, engineCommand, spec } from "../testing/synthetic.ts";

/** A's high-pass: on at `from`, at `depth` by 50 s, back to centre at `backAt` (A's fader closes at 56 s). */
function sweep({ from = 40, depth = 0.8, backAt = 57 }: { from?: number; depth?: number; backAt?: number | null } = {}): EngineCommandRecord[] {
  return [
    engineCommand(from, "filter", "A", 0.06),
    engineCommand(50, "filter", "A", depth),
    ...(backAt === null ? [] : [engineCommand(backAt, "filter", "A", 0)]),
  ];
}

function check(engineEvents: readonly EngineCommandRecord[], variant: CheckVariant = "full"): CheckResult {
  const result = runCheck(
    spec({ lessonId: "filter-transition" }, BLEND_WINDOW, { variant, aids: { ...LESSON_AIDS, sync: true } }),
    blendScenario({ engineEvents }),
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

  it("ignores filter moves the engine refused", () => {
    const refused = [...sweep({ depth: 0.5 }), { ...engineCommand(52, "filter", "A", 0.9), rejected: { kind: "value-out-of-range" } }];
    expect(byId(check(refused), "filter-transition.hpf-depth")?.status).toBe("notMet");
  });
});
