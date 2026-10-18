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

  it("while answering, previews with Shift + 1–8 or P (the focused chip), instead of answering or practice", () => {
    const answering = (code: string, shiftKey = false) => lessonKey({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey }, { answering: true });
    expect(answering("Digit3", true)).toEqual({ kind: "preview", value: 3 });
    expect(answering("KeyP")).toEqual({ kind: "preview-focused" });
    expect(answering("Digit3")).toEqual({ kind: "answer", value: 3 });
  });

  it("while a phrase preview plays, P or Escape stops it; Shift + 1–8 still plays another", () => {
    const playing = (code: string, shiftKey = false) => lessonKey({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey }, { answering: true, previewing: true });
    expect(playing("KeyP")).toEqual({ kind: "stop-preview" });
    expect(playing("Escape")).toEqual({ kind: "stop-preview" });
    expect(playing("Digit5", true)).toEqual({ kind: "preview", value: 5 });
    expect(playing("Digit5")).toEqual({ kind: "answer", value: 5 });
    // Nothing playing: Escape is back to the list, as everywhere else.
    expect(lessonKey({ code: "Escape", repeat: false, ctrlKey: false, metaKey: false, altKey: false }, { answering: true, previewing: false })).toEqual({ kind: "exit" });
  });
});
