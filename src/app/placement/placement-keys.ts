// Placement's own keys (placement-design §2, §4): Enter = go, Esc = skip (start at Lesson 1 at the
// Mission, skip the rest in a task), N = Not yet, R = Ready, 1–4 = answers, and on the result card
// any other key goes on. Pure, so the mapping is testable without a DOM.

export type PlacementScreen = "mission" | "task" | "answering" | "card" | "summary";

export type PlacementKey =
  | { readonly kind: "go" }
  | { readonly kind: "skip" }
  | { readonly kind: "notYet" }
  | { readonly kind: "ready" }
  | { readonly kind: "answer"; readonly value: number }
  | { readonly kind: "next" };

export type KeyPress = Pick<KeyboardEvent, "code" | "repeat" | "ctrlKey" | "metaKey" | "altKey">;

const ANSWER_KEY = /^Digit([1-4])$/;
/** Keys that are not "a key" to a Learner: modifiers on their own, and focus movement. */
const NOT_A_PRESS: ReadonlySet<string> = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "Tab", "CapsLock", "Fn"]);

export function placementKey(press: KeyPress, screen: PlacementScreen): PlacementKey | null {
  if (press.repeat || press.ctrlKey || press.metaKey || press.altKey) return null;
  const { code } = press;
  switch (screen) {
    case "mission":
      if (code === "Enter" || code === "NumpadEnter") return { kind: "go" };
      return code === "Escape" ? { kind: "skip" } : null;
    case "summary":
      return code === "Enter" || code === "NumpadEnter" ? { kind: "go" } : null;
    case "card":
      if (code === "Escape") return { kind: "skip" };
      return NOT_A_PRESS.has(code) ? null : { kind: "next" };
    case "task":
    case "answering": {
      if (code === "Escape") return { kind: "skip" };
      if (code === "KeyN") return { kind: "notYet" };
      if (code === "KeyR") return { kind: "ready" };
      const digit = screen === "answering" ? ANSWER_KEY.exec(code)?.[1] : undefined;
      return digit === undefined ? null : { kind: "answer", value: Number(digit) };
    }
  }
}
