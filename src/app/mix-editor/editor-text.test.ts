import { describe, expect, it } from "vitest";
import { ALL_CONTROL_IDS, type ControlId } from "@app/controller/control-ids.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import type { Transition } from "@shared/mix-plan.ts";
import type { Complexity } from "./complexity.ts";
import { deriveExecution } from "./execution-plan.ts";
import { formatLaneValue, hardWarning, laneLabel, positionText, ratingWord, reasonText, stepLabel, transitionSummary } from "./editor-text.ts";

const EVERYTHING: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS);
const PLACE = { outgoingAt: { bar: 17, beat: 1 }, incomingAt: { bar: 1, beat: 1 }, tempos: { outgoing: 124, incoming: 124 } } as const;
const DECKS = { outgoing: "A", incoming: "B" } as const;

describe("editor text", () => {
  it("summarises a Transition by recipe, phrase and length", () => {
    expect(transitionSummary(transitionFromRecipe("bass-swap", PLACE))).toBe("Bass swap at Phrase 3, 16 bars");
    expect(transitionSummary(transitionFromRecipe("cut-on-the-1", PLACE))).toBe("Cut on the 1 at Phrase 3, 1 bar");
    const custom: Transition = { ...transitionFromRecipe("echo-out", PLACE), recipe: "custom", lengthBeats: 6 };
    expect(transitionSummary(custom)).toBe("Custom at Phrase 3, 1.5 bars");
  });

  it("names beats as the captions do: Phrase, bar and beat on the outgoing track", () => {
    const transition = transitionFromRecipe("crossfade-16", PLACE);
    expect(positionText(transition, 0)).toBe("Phrase 3");
    expect(positionText(transition, 32)).toBe("Phrase 4");
    expect(positionText(transition, 5)).toBe("Phrase 3, bar 2, beat 2");
    expect(positionText(transition, 4.5)).toBe("Phrase 3, bar 2, beat 1.5");
  });

  it("gives each rating its word", () => {
    expect([1, 2, 3, 4, 5].map((rating) => ratingWord(rating as Complexity["rating"]))).toEqual(["easy", "steady", "busy", "hard", "very hard"]);
  });

  it("warns past rating 3 with the heaviest reason, and says nothing at 3 or under", () => {
    const transition = transitionFromRecipe("crossfade-16", PLACE);
    const calm: Complexity = { rating: 3, reasons: [], score: 5, weightsVersion: 1 };
    expect(hardWarning(calm, transition)).toBeNull();
    const hard: Complexity = {
      rating: 4,
      score: 9,
      weightsVersion: 1,
      reasons: [
        { factor: "fine-timing", beat: 0, lanes: [0], points: 1 },
        { factor: "three-hands", beat: 32, lanes: [0, 1, 2], points: 4 },
      ],
    };
    expect(hardWarning(hard, transition)).toBe("Hard to play live: three moves at once at Phrase 4");
    expect(reasonText({ factor: "fine-timing", beat: 0, lanes: [0], points: 1 }, transition)).toBe("a move that must land right on the beat at Phrase 3");
  });

  it("labels lanes and values in musical terms, with exact values", () => {
    expect(laneLabel("eq-low")).toBe("Low EQ");
    expect(formatLaneValue("volume", 0.5)).toBe("50%");
    expect(formatLaneValue("eq-low", -1)).toBe("kill");
    expect(formatLaneValue("eq-high", 0)).toBe("0 dB");
    expect(formatLaneValue("filter", 0)).toBe("off");
    expect(formatLaneValue("filter", -0.5)).toMatch(/^low-pass \d+ Hz$/);
    expect(formatLaneValue("tempo", 124)).toBe("124.0 BPM");
    expect(formatLaneValue("echo-send", 0.25)).toBe("25% wet");
    expect(formatLaneValue("loop", 1)).toBe("on");
  });

  it("labels each Execution step with its FLX4 control", () => {
    const plan = deriveExecution(transitionFromRecipe("bass-swap", PLACE), DECKS, EVERYTHING);
    const labels = plan.steps.map(stepLabel);
    expect(labels).toContain("PLAY B");
    expect(labels).toContain("fader B ↑");
    expect(labels).toContain("LOW B ↑");
  });
});
