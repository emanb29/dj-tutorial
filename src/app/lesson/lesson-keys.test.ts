import { describe, expect, it } from "vitest";
import { lessonKey } from "./lesson-keys.ts";

const press = (code: string, extra: Partial<Parameters<typeof lessonKey>[0]> = {}) =>
  lessonKey({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra }, { answering: false });

describe("lessonKey: the Lesson's own keys", () => {
  it("maps Enter, P and Escape to the Check, practice and the list", () => {
    expect(press("Enter")).toEqual({ kind: "check" });
    expect(press("KeyP")).toEqual({ kind: "practice" });
    expect(press("Escape")).toEqual({ kind: "exit" });
  });

  it("maps R to Ready (a level set, a cue point final)", () => {
    expect(press("KeyR")).toEqual({ kind: "ready" });
    expect(press("KeyR", { repeat: true })).toBeNull();
  });

  it("ignores a held key's repeats: holding Enter starts the Check once, not every 30 ms", () => {
    expect(press("Enter", { repeat: true })).toBeNull();
    expect(press("KeyP", { repeat: true })).toBeNull();
  });

  it("leaves shortcuts with a modifier to the browser", () => {
    expect(press("KeyP", { metaKey: true })).toBeNull();
    expect(press("Enter", { ctrlKey: true })).toBeNull();
  });

  it("answers with 1–8 only while answering", () => {
    expect(press("Digit4")).toBeNull();
    expect(lessonKey({ code: "Digit4", repeat: false, ctrlKey: false, metaKey: false, altKey: false }, { answering: true })).toEqual({ kind: "answer", value: 4 });
    expect(lessonKey({ code: "Digit9", repeat: false, ctrlKey: false, metaKey: false, altKey: false }, { answering: true })).toBeNull();
  });
});
