import { describe, expect, it } from "vitest";
import { placementKey, type KeyPress } from "./placement-keys.ts";

const press = (code: string, extra: Partial<KeyPress> = {}): KeyPress => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe("Placement keys", () => {
  it("at the Mission: Enter shows what you can do, Esc starts at Lesson 1", () => {
    expect(placementKey(press("Enter"), "mission")).toEqual({ kind: "go" });
    expect(placementKey(press("Escape"), "mission")).toEqual({ kind: "skip" });
    expect(placementKey(press("KeyN"), "mission")).toBeNull();
  });

  it("in a task: N is Not yet and Esc skips the rest, live all the time; R is Ready", () => {
    expect(placementKey(press("KeyN"), "task")).toEqual({ kind: "notYet" });
    expect(placementKey(press("Escape"), "task")).toEqual({ kind: "skip" });
    expect(placementKey(press("KeyR"), "task")).toEqual({ kind: "ready" });
    // Deck keys are the controller's.
    expect(placementKey(press("KeyX"), "task")).toBeNull();
    expect(placementKey(press("Digit2"), "task")).toBeNull();
  });

  it("answers 1–4 only while a question is open", () => {
    expect(placementKey(press("Digit4"), "answering")).toEqual({ kind: "answer", value: 4 });
    expect(placementKey(press("Digit5"), "answering")).toBeNull();
    expect(placementKey(press("KeyN"), "answering")).toEqual({ kind: "notYet" });
  });

  it("on the result card any key goes on, except Esc (skip the rest) and bare modifiers", () => {
    expect(placementKey(press("Space"), "card")).toEqual({ kind: "next" });
    expect(placementKey(press("KeyX"), "card")).toEqual({ kind: "next" });
    expect(placementKey(press("Escape"), "card")).toEqual({ kind: "skip" });
    expect(placementKey(press("ShiftLeft"), "card")).toBeNull();
    expect(placementKey(press("Tab"), "card")).toBeNull();
  });

  it("ignores held-key repeats and browser shortcuts", () => {
    expect(placementKey(press("Space", { repeat: true }), "card")).toBeNull();
    expect(placementKey(press("KeyR", { metaKey: true }), "task")).toBeNull();
  });

  it("starts the Lesson with Enter on the Summary", () => {
    expect(placementKey(press("Enter"), "summary")).toEqual({ kind: "go" });
    expect(placementKey(press("Space"), "summary")).toBeNull();
  });
});
