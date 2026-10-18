import { describe, expect, it } from "vitest";
import { globalKeyAllowed, hotCueKeyHint, KEY_BINDINGS, keyHintFor, resolveKey } from "./keymap.ts";

describe("globalKeyAllowed (H1)", () => {
  const body = { tagName: "BODY", role: null, isContentEditable: false };
  const button = { tagName: "BUTTON", role: null, isContentEditable: false };
  const slider = { tagName: "DIV", role: "slider", isContentEditable: false };

  it("handles bound keys when nothing in particular has focus", () => {
    expect(globalKeyAllowed(body, "Space", false)).toBe(true);
    expect(globalKeyAllowed(null, "KeyX", false)).toBe(true);
  });

  it("never takes keys from text entry or an IME composition", () => {
    expect(globalKeyAllowed({ tagName: "INPUT", role: null, isContentEditable: false }, "KeyX", false)).toBe(false);
    expect(globalKeyAllowed({ tagName: "TEXTAREA", role: null, isContentEditable: false }, "Space", false)).toBe(false);
    expect(globalKeyAllowed({ tagName: "SELECT", role: null, isContentEditable: false }, "KeyX", false)).toBe(false);
    expect(globalKeyAllowed({ tagName: "DIV", role: null, isContentEditable: true }, "KeyX", false)).toBe(false);
    expect(globalKeyAllowed(body, "KeyX", true)).toBe(false);
  });

  it("leaves Space and Enter to a focused button or link", () => {
    expect(globalKeyAllowed(button, "Space", false)).toBe(false);
    expect(globalKeyAllowed(button, "Enter", false)).toBe(false);
    expect(globalKeyAllowed({ tagName: "A", role: null, isContentEditable: false }, "Space", false)).toBe(false);
    expect(globalKeyAllowed({ tagName: "DIV", role: "button", isContentEditable: false }, "Space", false)).toBe(false);
  });

  it("still lets deck keys through a focused button, so a click never disables the keyboard", () => {
    expect(globalKeyAllowed(button, "KeyX", false)).toBe(true);
  });

  it("leaves a focused slider its own keys", () => {
    expect(globalKeyAllowed(slider, "Space", false)).toBe(false);
    expect(globalKeyAllowed(slider, "ArrowUp", false)).toBe(false);
    expect(globalKeyAllowed(slider, "KeyX", false)).toBe(true);
  });
});

describe("key hints", () => {
  it("labels controls with the keys bound to them", () => {
    expect(keyHintFor("A.channel-fader")).toBe("W/S");
    expect(keyHintFor("B.play")).toBe(",");
    expect(keyHintFor("A.trim")).toBeNull();
    expect(hotCueKeyHint("B", 3)).toBe("0");
    expect(hotCueKeyHint("A", 6)).toBeNull();
  });
});

const plain = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

describe("resolveKey", () => {
  it("binds play and cue for both decks, cue left of play as on the hardware", () => {
    expect(resolveKey("KeyZ", plain)).toEqual({ kind: "deck-cue", deck: "A" });
    expect(resolveKey("KeyX", plain)).toEqual({ kind: "play-pause", deck: "A" });
    expect(resolveKey("KeyM", plain)).toEqual({ kind: "deck-cue", deck: "B" });
    expect(resolveKey("Comma", plain)).toEqual({ kind: "play-pause", deck: "B" });
  });

  it("binds the space bar to tap", () => {
    expect(resolveKey("Space", plain)).toEqual({ kind: "tap" });
  });

  it("binds hot cues 1–4 to the left digits for deck A and the right digits for deck B", () => {
    expect(resolveKey("Digit1", plain)).toEqual({ kind: "hot-cue", deck: "A", slot: 0, erase: false });
    expect(resolveKey("Digit4", plain)).toEqual({ kind: "hot-cue", deck: "A", slot: 3, erase: false });
    expect(resolveKey("Digit7", plain)).toEqual({ kind: "hot-cue", deck: "B", slot: 0, erase: false });
    expect(resolveKey("Digit0", plain)).toEqual({ kind: "hot-cue", deck: "B", slot: 3, erase: false });
  });

  it("erases a hot cue with Shift, as SHIFT + pad does", () => {
    expect(resolveKey("Digit2", { ...plain, shiftKey: true })).toEqual({ kind: "hot-cue", deck: "A", slot: 1, erase: true });
  });

  it("binds cut keys that snap each channel fader fully open or closed", () => {
    expect(resolveKey("KeyW", plain)).toEqual({ kind: "cut", deck: "A", open: true });
    expect(resolveKey("KeyS", plain)).toEqual({ kind: "cut", deck: "A", open: false });
    expect(resolveKey("KeyO", plain)).toEqual({ kind: "cut", deck: "B", open: true });
    expect(resolveKey("KeyL", plain)).toEqual({ kind: "cut", deck: "B", open: false });
  });

  it("toggles the key legend with ?", () => {
    expect(resolveKey("Slash", plain)).toEqual({ kind: "toggle-legend" });
    expect(resolveKey("Slash", { ...plain, shiftKey: true })).toEqual({ kind: "toggle-legend" });
  });

  it("leaves browser shortcuts alone", () => {
    expect(resolveKey("KeyX", { ...plain, metaKey: true })).toBeNull();
    expect(resolveKey("KeyW", { ...plain, ctrlKey: true })).toBeNull();
    expect(resolveKey("Digit1", { ...plain, altKey: true })).toBeNull();
  });

  it("ignores unbound keys", () => {
    expect(resolveKey("KeyK", plain)).toBeNull();
    expect(resolveKey("ArrowUp", plain)).toBeNull();
  });

  it("holds a nudge on B with the arrows and on A with Q and E", () => {
    expect(resolveKey("ArrowRight", plain)).toEqual({ kind: "jog-nudge", deck: "B", faster: true });
    expect(resolveKey("ArrowLeft", plain)).toEqual({ kind: "jog-nudge", deck: "B", faster: false });
    expect(resolveKey("KeyQ", plain)).toEqual({ kind: "jog-nudge", deck: "A", faster: false });
    expect(resolveKey("KeyE", plain)).toEqual({ kind: "jog-nudge", deck: "A", faster: true });
  });
});

describe("KEY_BINDINGS", () => {
  it("binds every physical key once", () => {
    const codes = KEY_BINDINGS.map((binding) => binding.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("names the control each binding needs unlocked, except the legend toggle", () => {
    const needing = KEY_BINDINGS.filter((binding) => binding.action.kind !== "toggle-legend");
    expect(needing.every((binding) => binding.control !== null)).toBe(true);
    expect(KEY_BINDINGS.find((binding) => binding.code === "KeyX")?.control).toBe("A.play");
    expect(KEY_BINDINGS.find((binding) => binding.code === "KeyS")?.control).toBe("A.channel-fader");
    expect(KEY_BINDINGS.find((binding) => binding.code === "Digit7")?.control).toBe("B.hot-cue");
  });
});
