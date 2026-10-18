import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CriterionResult } from "@shared/check-result.ts";
import type { PhrasePreviewSession } from "./PhrasePreview.tsx";
import { CriterionFeedback } from "./ResultCard.tsx";

function criterion(id: CriterionResult["id"], status: CriterionResult["status"], detail: Record<string, number>): CriterionResult {
  return { id, severity: "fail", status, measured: 0, unit: "count", threshold: null, margin: null, evidence: [], detail };
}

/** Records which phrases ▶ asked to play; plays nothing. */
function previews(): PhrasePreviewSession & { readonly played: number[] } {
  const played: number[] = [];
  return {
    played,
    previewPhrase: (phrase) => {
      played.push(phrase);
      return true;
    },
    previewHeard: () => null,
    stopPreview: () => undefined,
  };
}

afterEach(cleanup);

describe("the result card's Count phrases lines", () => {
  const named = criterion("phrases.name-sections", "notMet", { questions: 2, "breakdown.answered": 3, "breakdown.correct": 1, "drop.answered": 5, "drop.correct": 5 });

  it("shows one line per section: the wrong pick against the right phrase, a right one ticked", () => {
    const { container } = render(<CriterionFeedback criterion={named} previews={previews()} />);
    const lines = [...container.querySelectorAll("li")].map((line) => line.textContent);

    expect(lines).toEqual([expect.stringMatching(/^Breakdown: you picked Phrase 3 — it was Phrase 1 ✗/), "Drop: Phrase 5 ✓"]);
  });

  it("replays the right phrase, and the Learner's own pick, from ▶ on the wrong line only", () => {
    const session = previews();
    render(<CriterionFeedback criterion={named} previews={session} />);

    fireEvent.click(screen.getByRole("button", { name: "Play the breakdown: phrase 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Play your pick: phrase 3" }));

    expect(session.played).toEqual([1, 3]);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("says which phrase starts the taps missed, only when the taps failed", () => {
    const detail = { matched: 5, extras: 2, targets: 8, "missed.4": 1, "missed.7": 1, "late.2": 2 };
    render(<CriterionFeedback criterion={criterion("phrases.phrase-taps", "notMet", detail)} previews={null} />);

    expect(screen.getByTestId("phrase-tap-misses").textContent).toBe("Missed phrases 4 and 7 · late on phrase 2");
    cleanup();
    const { container } = render(<CriterionFeedback criterion={criterion("phrases.phrase-taps", "met", detail)} previews={null} />);
    expect(container.textContent).toBe("");
  });
});
