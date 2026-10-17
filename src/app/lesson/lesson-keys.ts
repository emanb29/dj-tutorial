// The Lesson's own keys, apart from the controller's: Enter = into the Check (again), P = practice,
// R = Ready, Escape = back to the list, 1–8 = answers. Pure, so the mapping is testable without a DOM.

export type LessonKey =
  | { readonly kind: "check" }
  | { readonly kind: "practice" }
  /** "This is set": a level in gain-staging, a cue point in cue-point. */
  | { readonly kind: "ready" }
  | { readonly kind: "exit" }
  | { readonly kind: "answer"; readonly value: number };

export type KeyPress = Pick<KeyboardEvent, "code" | "repeat" | "ctrlKey" | "metaKey" | "altKey">;

const ANSWER_KEY = /^Digit([1-8])$/;

/** What a key press means in a Lesson; null for keys the Lesson leaves alone (and a held key's repeats). */
export function lessonKey(press: KeyPress, state: { readonly answering: boolean }): LessonKey | null {
  // A held key repeats every ~30 ms: each repeat would restart the Check and abandon its recording.
  if (press.repeat || press.ctrlKey || press.metaKey || press.altKey) return null;
  if (press.code === "Enter") return { kind: "check" };
  if (press.code === "KeyP") return { kind: "practice" };
  if (press.code === "KeyR") return { kind: "ready" };
  if (press.code === "Escape") return { kind: "exit" };
  const digit = state.answering ? ANSWER_KEY.exec(press.code)?.[1] : undefined;
  return digit === undefined ? null : { kind: "answer", value: Number(digit) };
}
