// Lesson 3 (Count phrases) result lines: which section was named right or wrong, and which phrase
// starts the taps missed. Short captions, one line each. Pure.
import type { PhraseTapMiss, SectionAnswer } from "@checks";

const QUESTION_LABEL = { breakdown: "Breakdown", drop: "Drop" } as const;

/** "Drop: Phrase 5", or "Breakdown: you picked Phrase 3 — it was Phrase 1" (no ✓ or ✗: the card adds it). */
export function sectionAnswerLine(answer: SectionAnswer): string {
  const label = QUESTION_LABEL[answer.question];
  if (answer.answered === answer.correct) return `${label}: Phrase ${String(answer.correct)}`;
  const picked = answer.answered === null ? "no pick" : `you picked Phrase ${String(answer.answered)}`;
  return `${label}: ${picked} — it was Phrase ${String(answer.correct)}`;
}

/** "4", "4 and 7", "3, 4 and 7". */
function listed(phrases: readonly number[]): string {
  const words = phrases.map(String);
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

/** "Missed phrases 4 and 7 · late on phrase 5 · early on phrase 2"; null when every phrase start had its tap. */
export function phraseTapLine(misses: readonly PhraseTapMiss[]): string | null {
  const of = (kind: PhraseTapMiss["kind"]) => misses.filter((miss) => miss.kind === kind).map((miss) => miss.phrase);
  const part = (words: string, phrases: readonly number[]) => (phrases.length === 0 ? null : `${words} ${phrases.length === 1 ? "phrase" : "phrases"} ${listed(phrases)}`);
  const parts = [part("missed", of("missed")), part("late on", of("late")), part("early on", of("early"))].filter((text) => text !== null);
  if (parts.length === 0) return null;
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
