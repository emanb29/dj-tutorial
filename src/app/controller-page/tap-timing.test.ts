import { describe, expect, it } from "vitest";
import { isTapPress, offsetFromClicks } from "./tap-timing.ts";

describe("the Timing check's taps", () => {
  it("measures each tap from the nearest click, early negative", () => {
    // Clicks at 1.0 s, 1.6 s, 2.2 s (100 BPM).
    expect(offsetFromClicks(1.62, 1, 0.6)).toBeCloseTo(20);
    expect(offsetFromClicks(2.17, 1, 0.6)).toBeCloseTo(-30);
  });

  it("takes a pad and BEAT ◀ / ▶ (SHIFT + BEAT ▶ too) as TAP, on press only, and not the BROWSE press (the app's press)", () => {
    expect(isTapPress({ kind: "pad", deck: "A", mode: "hot-cue", pad: 0, shift: false, pressed: true })).toBe(true);
    expect(isTapPress({ kind: "pad", deck: "A", mode: "hot-cue", pad: 0, shift: false, pressed: false })).toBe(false);
    expect(isTapPress({ kind: "button", control: "fx-beat-forward", deck: null, shift: false, pressed: true })).toBe(true);
    expect(isTapPress({ kind: "button", control: "fx-beat-forward", deck: null, shift: true, pressed: true })).toBe(true);
    expect(isTapPress({ kind: "button", control: "browse-press", deck: null, shift: false, pressed: true })).toBe(false);
    expect(isTapPress({ kind: "button", control: "browse-press", deck: null, shift: true, pressed: true })).toBe(false);
    expect(isTapPress({ kind: "button", control: "sync", deck: "A", shift: false, pressed: true })).toBe(false);
  });
});
