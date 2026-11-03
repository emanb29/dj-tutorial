import { describe, expect, it } from "vitest";
import { MIX_PLAN_VERSION } from "./mix-plan.ts";
import { MIX_PLAN_MIGRATIONS, mixPlanFileName, mixPlanFileText, parseMixPlanFile, readMixPlan, type MixPlanMigration } from "./mix-plan-file.ts";
import { testPlan } from "./mix-plan-test-support.ts";

describe("readMixPlan", () => {
  it("reads a current plan as it is", () => {
    const { plan } = testPlan(2);
    expect(readMixPlan(structuredClone(plan))).toEqual({ ok: true, plan, migratedFrom: null });
  });

  it("has no migrations yet: version 1 is the first", () => {
    expect(MIX_PLAN_VERSION).toBe(1);
    expect(Object.keys(MIX_PLAN_MIGRATIONS)).toEqual([]);
  });

  it("migrates an older plan step by step before checking it", () => {
    const { plan } = testPlan(2);
    // A pretend version 0 that called the tracks "songs".
    const { tracks, ...rest } = plan;
    const saved = { ...rest, version: 0, songs: tracks };
    const zeroToOne: MixPlanMigration = ({ songs, ...older }) => ({ ...older, tracks: songs, version: 1 });

    expect(readMixPlan(saved, { 0: zeroToOne })).toEqual({ ok: true, plan, migratedFrom: 0 });
    expect(readMixPlan(saved)).toMatchObject({ ok: false, problems: [{ kind: "no-migration" }] });
  });

  it("refuses a plan from a newer version, saying to update", () => {
    const { plan } = testPlan(2);
    expect(readMixPlan({ ...plan, version: 2 })).toEqual({
      ok: false,
      problems: [
        {
          kind: "newer-version",
          message: "This plan was saved by a newer version of the app (plan version 2; this one reads up to 1).",
          fix: "Update the app (reload the page), then open it again.",
        },
      ],
    });
  });

  it("lists every field that is wrong", () => {
    const { plan } = testPlan(2);
    const bad = { ...plan, name: 7, tracks: plan.tracks.map((track, index) => (index === 1 ? { ...track, contentHash: "nope", durationMs: -1 } : track)) };
    const read = readMixPlan(bad);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((problem) => problem.message.split(":")[0])).toEqual(["name", "tracks.1.contentHash", "tracks.1.durationMs"]);
    expect(read.problems.every((problem) => problem.kind === "bad-field" && problem.fix !== "")).toBe(true);
  });

  it.each([null, "plan", [], {}, { version: "1" }, { version: -1 }])("says %j is not a plan", (raw) => {
    expect(readMixPlan(raw)).toMatchObject({ ok: false, problems: [{ kind: "not-a-plan" }] });
  });
});

describe("the .mixplan.json file", () => {
  it("round-trips a plan as readable JSON with no audio and no paths", () => {
    const { plan } = testPlan(3);
    const text = mixPlanFileText(plan);

    expect(text).toContain('\n  "name": "Test set",');
    expect(text).not.toMatch(/"path"|"handle"|"audio"/);
    expect(parseMixPlanFile(text)).toEqual({ ok: true, plan, migratedFrom: null });
  });

  it("names the file after the plan, safely", () => {
    expect(mixPlanFileName({ name: "Friday warm-up" })).toBe("Friday warm-up.mixplan.json");
    expect(mixPlanFileName({ name: 'a/b:c*"d"' })).toBe("a-b-c-d-.mixplan.json");
    expect(mixPlanFileName({ name: "  " })).toBe("mix-plan.mixplan.json");
  });

  it("says a file that is not JSON is not a plan", () => {
    expect(parseMixPlanFile("{nope")).toMatchObject({ ok: false, problems: [{ kind: "not-a-plan", message: "This file is not a Mix Plan: it is not readable JSON." }] });
  });
});
