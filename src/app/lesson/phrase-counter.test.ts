import { describe, expect, it } from "vitest";
import { phraseCountText } from "./PhraseCounter.tsx";

describe("phraseCountText", () => {
  it("names the bar, flags a phrase's first bar, and steps aside by ear", () => {
    expect(phraseCountText({ bar: 3, shown: true })).toBe("bar 3 of 8");
    expect(phraseCountText({ bar: 1, shown: true })).toBe("bar 1 of 8 · new phrase!");
    expect(phraseCountText({ bar: 1, shown: false })).toBe("now by ear");
    expect(phraseCountText(null)).toBe("");
  });
});
