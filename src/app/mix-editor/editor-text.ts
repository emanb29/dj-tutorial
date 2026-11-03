// What the Mix Editor says: Transition summaries, positions as the captions name them ("Phrase 3, bar
// 2, beat 1"), rating words, reasons, the one-line warning, lane names and exact values. The editor
// speaks in musical terms (volume, EQ, filter, tempo, echo, loop); only the Execution strip names the
// FLX4's controls, from the one table (flx4-keys.ts).
import { flx4LayoutControl } from "@app/controller/flx4-keys.ts";
import { eqKnobToDecibels, filterKnobSettings } from "@audio/curves.ts";
import { RECIPES } from "@shared/mix-plan-recipes.ts";
import { BEATS_PER_BAR, BEATS_PER_PHRASE, beatIndexOf, phraseOf, type LaneParam, type Transition } from "@shared/mix-plan.ts";
import type { Complexity, ComplexityFactor, ComplexityReason } from "./complexity.ts";
import type { ExecutionStep } from "./execution-plan.ts";

const RATING_WORDS = ["easy", "steady", "busy", "hard", "very hard"] as const;

/** The rating above which the editor shows its one-line warning. */
export const WARN_ABOVE_RATING = 3;

export function ratingWord(rating: Complexity["rating"]): string {
  return RATING_WORDS[rating - 1] ?? "very hard";
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function recipeName(transition: Pick<Transition, "recipe">): string {
  return transition.recipe === "custom" ? "Custom" : RECIPES[transition.recipe].name;
}

export function barsText(beats: number): string {
  const bars = round(beats / BEATS_PER_BAR, 2);
  return `${String(bars)} bar${bars === 1 ? "" : "s"}`;
}

/** "Bass swap at Phrase 3, 16 bars". */
export function transitionSummary(transition: Transition): string {
  return `${recipeName(transition)} at Phrase ${String(phraseOf(transition.outgoingAt).phrase)}, ${barsText(transition.lengthBeats)}`;
}

/** A Transition beat on the outgoing track's grid, as the captions say it: "Phrase 3", or "Phrase 3, bar 2, beat 1". */
export function positionText(transition: Pick<Transition, "outgoingAt">, beat: number): string {
  const onGrid = beatIndexOf(transition.outgoingAt) + beat;
  const phrase = Math.floor(onGrid / BEATS_PER_PHRASE) + 1;
  const inPhrase = onGrid - (phrase - 1) * BEATS_PER_PHRASE;
  const bar = Math.floor(inPhrase / BEATS_PER_BAR) + 1;
  const beatInBar = round(inPhrase - (bar - 1) * BEATS_PER_BAR + 1, 3);
  if (bar === 1 && beatInBar === 1) return `Phrase ${String(phrase)}`;
  return `Phrase ${String(phrase)}, bar ${String(bar)}, beat ${String(beatInBar)}`;
}

const REASON_WORDS: Readonly<Record<ComplexityFactor, string>> = {
  "three-hands": "three moves at once",
  "one-hand-two-moves": "two moves on one hand",
  "tempo-ride": "a tempo change while both tracks play",
  "not-unlocked": "a control whose Lesson you haven't passed",
  "dense-bar": "a busy bar",
  "fine-timing": "a move that must land right on the beat",
  "long-ramp": "a long move that must end on a phrase",
  "hand-jump": "one hand crossing between decks",
};

/** "three moves at once at Phrase 3, beat 1". */
export function reasonText(reason: ComplexityReason, transition: Pick<Transition, "outgoingAt">): string {
  return `${REASON_WORDS[reason.factor]} at ${positionText(transition, reason.beat)}`;
}

/** The one line past rating 3, naming the heaviest reason (the first of the heaviest); null at 3 or under. Never a block. */
export function hardWarning(complexity: Complexity, transition: Pick<Transition, "outgoingAt">): string | null {
  if (complexity.rating <= WARN_ABOVE_RATING) return null;
  const heaviest = complexity.reasons.reduce<ComplexityReason | null>((best, each) => (best === null || each.points > best.points ? each : best), null);
  return heaviest === null ? "Hard to play live" : `Hard to play live: ${reasonText(heaviest, transition)}`;
}

const LANE_LABELS: Readonly<Record<LaneParam, string>> = {
  volume: "Volume",
  "eq-low": "Low EQ",
  "eq-mid": "Mid EQ",
  "eq-high": "High EQ",
  filter: "Filter",
  tempo: "Tempo",
  "echo-send": "Echo",
  loop: "Loop",
};

export function laneLabel(param: LaneParam): string {
  return LANE_LABELS[param];
}

/** A lane value exactly, as on hover and focus: "50%", "−6 dB", "kill", "low-pass 800 Hz", "124.0 BPM". */
export function formatLaneValue(param: LaneParam, value: number): string {
  switch (param) {
    case "volume":
      return `${String(Math.round(value * 100))}%`;
    case "eq-low":
    case "eq-mid":
    case "eq-high": {
      const decibels = eqKnobToDecibels(value);
      if (decibels === Number.NEGATIVE_INFINITY) return "kill";
      const shown = round(decibels, 1);
      return `${shown > 0 ? "+" : ""}${String(shown)} dB`;
    }
    case "filter": {
      const settings = filterKnobSettings(value);
      return settings.kind === "off" ? "off" : `${settings.kind === "lowpass" ? "low-pass" : "high-pass"} ${String(Math.round(settings.cutoffHz))} Hz`;
    }
    case "tempo":
      return `${value.toFixed(1)} BPM`;
    case "echo-send":
      return `${String(Math.round(value * 100))}% wet`;
    case "loop":
      return value >= 0.5 ? "on" : "off";
  }
}

/** An Execution step as the strip labels it: the FLX4 control, and which way it goes ("LOW B ↑", "PLAY B"). */
export function stepLabel(step: Pick<ExecutionStep, "control" | "from" | "to">): string {
  const { name } = flx4LayoutControl(step.control);
  if (typeof step.from === "number" && typeof step.to === "number") return step.to === step.from ? name : `${name} ${step.to > step.from ? "↑" : "↓"}`;
  if (typeof step.to === "boolean" && !step.to && !step.control.endsWith("play")) return `${name} off`;
  return name;
}
