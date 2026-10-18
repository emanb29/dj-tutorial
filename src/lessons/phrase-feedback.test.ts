import { describe, expect, it } from "vitest";
import { phraseTapLine, sectionAnswerLine } from "./phrase-feedback.ts";

describe("Count phrases result lines", () => {
  it("says the pick and the right phrase for each section", () => {
    expect(sectionAnswerLine({ question: "drop", answered: 5, correct: 5 })).toBe("Drop: Phrase 5");
    expect(sectionAnswerLine({ question: "breakdown", answered: 3, correct: 1 })).toBe("Breakdown: you picked Phrase 3 — it was Phrase 1");
    expect(sectionAnswerLine({ question: "drop", answered: null, correct: 6 })).toBe("Drop: no pick — it was Phrase 6");
  });

  it("lists missed, late and early phrase starts on one line", () => {
    expect(phraseTapLine([])).toBeNull();
    expect(phraseTapLine([{ phrase: 4, kind: "missed" }])).toBe("Missed phrase 4");
    expect(phraseTapLine([{ phrase: 4, kind: "missed" }, { phrase: 7, kind: "missed" }])).toBe("Missed phrases 4 and 7");
    expect(
      phraseTapLine([
        { phrase: 2, kind: "early", beats: 1.5 },
        { phrase: 3, kind: "missed" },
        { phrase: 4, kind: "missed" },
        { phrase: 5, kind: "late", beats: 2 },
        { phrase: 7, kind: "missed" },
      ]),
    ).toBe("Missed phrases 3, 4 and 7 · late on phrase 5 · early on phrase 2");
    expect(phraseTapLine([{ phrase: 5, kind: "late", beats: 2 }])).toBe("Late on phrase 5");
  });
});
