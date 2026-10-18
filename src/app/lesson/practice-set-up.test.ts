import { describe, expect, it } from "vitest";
import { practiceSetUp } from "./practice-set-up.ts";

describe("which practice set-up the decks are cued to", () => {
  it("cues a two-deck Lesson's decks again when practice starts after the hook", () => {
    // The hook leaves them mid-transition (bass-swap: B playing, LOW A down), so practice starts clean.
    expect(practiceSetUp("hook", true)).not.toBe(practiceSetUp("practice", true));
  });

  it("lets a one-deck Lesson play straight on from its hook into practice", () => {
    expect(practiceSetUp("hook", false)).toBe(practiceSetUp("practice", false));
  });

  it("has no practice set-up outside the hook and practice", () => {
    expect(practiceSetUp("check", true)).toBeNull();
    expect(practiceSetUp("result", false)).toBeNull();
  });
});
