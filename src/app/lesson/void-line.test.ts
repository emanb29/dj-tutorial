import { describe, expect, it } from "vitest";
import { voidLine } from "./void-line.ts";

describe("the line on a Check that didn't count", () => {
  it("says why a void attempt was not graded", () => {
    expect(voidLine("tabHidden", null)).toBe("Not graded: the tab was hidden.");
    expect(voidLine("recordingFailed", "Try again with Enter.")).toBe("Not graded: it could not be recorded. Try again with Enter.");
  });

  it("does not claim a result the profile refused was never recorded, and says what to do", () => {
    const line = voidLine("profileRefused", "criteria.x: bad id");
    expect(line).not.toContain("could not be recorded");
    expect(line).toContain("graded, but your profile refused to store it");
    expect(line).toContain("Reload the page and go again");
    expect(line).toContain("criteria.x: bad id");
  });
});
