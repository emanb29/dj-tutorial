// Lesson 11, `eq-basics`: cut A's LOW for a phrase and bring it back on the next (check-design §4).
import type { DeckId } from "@shared/attempt.ts";
import { lowDbAt, lowSpans } from "../blend.ts";
import { barSeconds, loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { TIME_EPSILON } from "../measures.ts";
import { phraseOffsetBeats } from "../phrasing.ts";
import { controlEvents, controlValueAt } from "../timeline.ts";

const KILL_DB = -20;
const KILL_BARS = 7;
const RETURNED_DB = -1;
const CENTRED_DB = 1;

export const EQ_BANDS = [
  ["eqHigh", "eqHighDb"],
  ["eqMid", "eqMidDb"],
  ["eqLow", "eqLowDb"],
] as const;

export const eqBasics: LessonCheck<TaskOf<"eq-basics">> = {
  situations: { transition: false },
  run(context) {
    const { attempt, window } = context;
    const deckA = loadedDeck(context, "A");
    const kills = lowSpans(context, "A", window, (db) => db <= KILL_DB);
    const longest = kills.reduce<(typeof kills)[number] | null>(
      (best, span) => (best === null || span.to - span.from > best.to - best.from ? span : best),
      null,
    );
    const bar = deckA === null || longest === null ? null : barSeconds(deckA, longest.from);
    // `t_return`: LOW back at −1 dB or above, after the longest kill.
    const returnAt =
      longest === null
        ? null
        : (controlEvents(attempt.events, "eqLow", "A", { from: longest.to - TIME_EPSILON, to: window.to }).find(
            (move) => move.value >= RETURNED_DB,
          )?.ctx ?? null);
    const returnOffset = deckA === null || returnAt === null ? null : phraseOffsetBeats(deckA, returnAt);
    const loaded = (["A", "B"] as const).filter((deck): deck is DeckId => attempt.decks[deck] !== undefined);
    const atEnd = window.to - TIME_EPSILON;
    const offCentre = loaded.flatMap((deck) =>
      EQ_BANDS.map(([control, field]) => Math.abs(controlValueAt(attempt.events, control, deck, atEnd, attempt.initialMixer[deck][field]))),
    );

    return {
      criteria: [
        judge({
          id: "eq-basics.low-kill",
          severity: "fail",
          unit: "bars",
          threshold: { op: ">=", value: KILL_BARS, unit: "bars" },
          // No cut at all is 0 bars; a cut on a deck without a grid cannot be measured in bars.
          measured: longest === null ? 0 : bar === null ? null : (longest.to - longest.from) / bar,
          evidence: longest === null ? [] : [{ ...longest, label: "LOW cut" }],
        }),
        judge({
          id: "eq-basics.low-return",
          severity: "fail",
          unit: "beats",
          threshold: { op: "<=", value: 1, unit: "beats" },
          measured: returnOffset === null ? null : Math.abs(returnOffset),
          evidence: returnAt === null ? [] : [{ from: returnAt, to: returnAt, label: "LOW back" }],
        }),
        judge({
          id: "eq-basics.eq-centred",
          severity: "fail",
          unit: "dB",
          threshold: { op: "<=", value: CENTRED_DB, unit: "dB" },
          measured: offCentre.length === 0 ? null : Math.max(...offCentre),
          detail: { lowAtEndDb: lowDbAt(context, "A", atEnd) },
        }),
      ],
      metrics: {},
    };
  },
};
