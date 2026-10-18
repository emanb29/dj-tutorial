import { describe, expect, it } from "vitest";
import { forPullRequest, selectSpecs, specFilesOnDisk } from "./e2e-affected.ts";
import { SMOKE_SPECS, SPEC_RULES } from "./e2e-spec-map.ts";

describe("selectSpecs", () => {
  it("runs a Lesson group's spec, mobile and placement for its Checks and catalogue", () => {
    expect(selectSpecs(["src/checks/lessons/bass-swap.ts", "src/lessons/catalogue-eq-filter.ts"])).toEqual({
      all: false,
      specs: ["e2e/lessons-eq-filter.spec.ts", "e2e/mobile.spec.ts", "e2e/placement.spec.ts"],
    });
  });

  it("runs the sync group and the groups that import from catalogue-sync.ts", () => {
    expect(selectSpecs(["src/lessons/catalogue-sync.ts"])).toEqual({
      all: false,
      specs: ["e2e/lessons-by-ear.spec.ts", "e2e/lessons-eq-filter.spec.ts", "e2e/lessons-sync.spec.ts", "e2e/mobile.spec.ts"],
    });
  });

  it("runs a screen's own spec", () => {
    expect(selectSpecs(["src/app/originals/OriginalsPlayer.tsx"])).toEqual({ all: false, specs: ["e2e/originals.spec.ts"] });
  });

  it("runs a changed spec by itself", () => {
    expect(selectSpecs(["e2e/lessons-by-ear.spec.ts"])).toEqual({ all: false, specs: ["e2e/lessons-by-ear.spec.ts"] });
  });

  it.each([
    "src/audio/engine.ts",
    "src/checks/criterion.ts",
    "shared/attempt.ts",
    "server/app.ts",
    "src/app/controller/Deck.tsx",
    "src/app/lesson/LessonPlayer.tsx",
    "src/lessons/catalogue.ts",
    "src/lessons/runtime.ts",
    "e2e/lesson-support.ts",
    "playwright.config.ts",
    "vite.config.ts",
    "package-lock.json",
    ".github/workflows/ci.yml",
  ])("runs the whole suite for shared %s", (path) => {
    expect(selectSpecs(["src/checks/lessons/bass-swap.ts", path])).toMatchObject({ all: true });
  });

  it("runs the whole suite for a path no rule names", () => {
    expect(selectSpecs(["src/app/final-mix/FinalMix.tsx"])).toMatchObject({ all: true });
    expect(selectSpecs(["src/lessons/drill.ts"])).toMatchObject({ all: true });
  });

  it("runs nothing for docs and tests", () => {
    expect(selectSpecs(["docs/adr/0001-v1-stack.md", "AGENTS.md", "tools/composer/x.py", "src/checks/lessons/bass-swap.test.ts", "src/audio/engine.browser.test.ts"])).toEqual({
      all: false,
      specs: [],
    });
  });

  it("runs nothing for an empty diff", () => {
    expect(selectSpecs([])).toEqual({ all: false, specs: [] });
  });
});

describe("forPullRequest", () => {
  it("plays the smoke set where a shared change would play everything", () => {
    expect(forPullRequest(selectSpecs(["src/audio/engine.ts"]))).toEqual({ all: false, specs: SMOKE_SPECS });
  });

  it("keeps a narrow selection as it is", () => {
    const narrow = selectSpecs(["src/app/originals/OriginalsPlayer.tsx"]);
    expect(forPullRequest(narrow)).toEqual(narrow);
  });

  it("names only smoke specs that exist", () => {
    const onDisk = new Set(specFilesOnDisk());
    expect(SMOKE_SPECS.filter((spec) => !onDisk.has(spec))).toEqual([]);
  });
});

describe("the spec map", () => {
  const named = new Set(SPEC_RULES.flatMap((rule) => (typeof rule.specs === "string" ? [] : rule.specs)));

  it("names every spec in e2e/, so a new one cannot run only on main", () => {
    const unnamed = specFilesOnDisk().filter((spec) => !named.has(spec));
    expect(unnamed, "Add these specs to a rule in scripts/e2e-spec-map.ts").toEqual([]);
  });

  it("names only specs that exist", () => {
    const onDisk = new Set(specFilesOnDisk());
    expect([...named].filter((spec) => !onDisk.has(spec)), "Fix or remove these in scripts/e2e-spec-map.ts").toEqual([]);
  });
});
