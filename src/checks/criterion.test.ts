import { describe, expect, it } from "vitest";
import { judge } from "./criterion.ts";
import { pointActionToleranceMs } from "./tolerance.ts";

describe("judge", () => {
  const base = { id: "deck-basics.fade-in", severity: "fail", unit: "bars" } as const;

  it("meets an upper limit on the boundary, with margin 0, and misses just past it", () => {
    expect(judge({ ...base, measured: 4, threshold: { op: "<=", value: 4, unit: "bars" } })).toMatchObject({
      status: "met",
      margin: 0,
    });
    expect(judge({ ...base, measured: 4.01, threshold: { op: "<=", value: 4, unit: "bars" } }).status).toBe("notMet");
  });

  it("gives margin as (threshold − measured) / threshold, positive when met", () => {
    expect(judge({ ...base, measured: 1, threshold: { op: "<=", value: 4, unit: "bars" } }).margin).toBeCloseTo(0.75);
    expect(judge({ ...base, measured: 0.95, threshold: { op: ">=", value: 0.9, unit: "ratio" } }).margin).toBeCloseTo(
      0.0556,
      3,
    );
    expect(judge({ ...base, measured: 0.8, threshold: { op: ">=", value: 0.9, unit: "ratio" } }).margin).toBeLessThan(0);
  });

  it("measures a range margin from its nearer edge, relative to half its width", () => {
    const threshold = { op: "in", value: [-6, -0.1], unit: "dBFS" } as const;

    expect(judge({ ...base, measured: -3.05, threshold }).margin).toBeCloseTo(1);
    expect(judge({ ...base, measured: -7, threshold })).toMatchObject({ status: "notMet" });
    expect(judge({ ...base, measured: -0.1, threshold })).toMatchObject({ status: "met", margin: 0 });
  });

  it("uses the given scale when the threshold is zero", () => {
    const result = judge({ ...base, measured: 0.2, threshold: { op: "<=", value: 0, unit: "position" }, scale: 1 });

    expect(result).toMatchObject({ status: "notMet" });
    expect(result.margin).toBeCloseTo(-0.2);
  });

  it("marks a missing measurement as not met with no margin", () => {
    expect(judge({ ...base, measured: null, threshold: { op: "<=", value: 4, unit: "bars" } })).toMatchObject({
      status: "notMet",
      measured: null,
      margin: null,
    });
  });
});

describe("judge with non-finite measurements", () => {
  it("treats NaN and ±Infinity as nothing measured, so results stay JSON-safe", () => {
    const threshold = { op: "<=", value: -0.1, unit: "dBFS" } as const;

    for (const measured of [Number.NaN, Infinity, -Infinity]) {
      expect(judge({ id: "deck-basics.no-clip-local", severity: "fail", unit: "dBFS", threshold, measured })).toMatchObject({
        status: "notMet",
        measured: null,
        margin: null,
      });
    }
  });
});

describe("point-action tolerance tiers (input leeway)", () => {
  it("is ±120 ms in the introducing Lesson, ±80 ms later and ±60 ms in final-mix", () => {
    expect(pointActionToleranceMs("cut-on-phrase", "cut-on-phrase")).toBe(120);
    expect(pointActionToleranceMs("cut-on-phrase", "crossfader")).toBe(80);
    expect(pointActionToleranceMs("cut-on-phrase", "final-mix")).toBe(60);
  });
});
