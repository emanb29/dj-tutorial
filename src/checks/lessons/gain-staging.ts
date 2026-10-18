// Lesson 4, `gain-staging`: set trim so each channel peaks in the target zone (check-design §4).
import type { CheckVariant, CtxSpan, DeckId } from "@shared/attempt.ts";
import type { CriterionId, CriterionResult } from "@shared/check-result.ts";
import { barSeconds, loadedDeck, maxOf, type CheckContext, type LessonCheck, type TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { energyMeanDb } from "../measures.ts";
import { framesIn } from "../mix.ts";
import { controlEvents } from "../timeline.ts";

const WINDOW_BARS: Readonly<Record<CheckVariant, number>> = { full: 8, short: 4 };
/** The target zone for a channel's sample peak, dBFS (the top edge is the clip line). */
const PEAK_ZONE: readonly [number, number] = [-6, -0.1];
const LOUD_MATCH_DB = 1.5;
/** Integrated loudness ignores frames below this (EBU R128 absolute gate). */
const ABSOLUTE_GATE_LUFS = -70;

/** The 8 (or 4) bars after the deck's last Ready press; `null` when they do not fit in the task window. */
function readyWindow(context: CheckContext, deck: DeckId): CtxSpan | null {
  const ready = controlEvents(context.attempt.events, "ready", deck, context.window).at(-1);
  const loaded = loadedDeck(context, deck);
  if (ready === undefined || loaded === null) return null;
  const length = WINDOW_BARS[context.spec.variant] * barSeconds(loaded, ready.ctx);
  const to = ready.ctx + length;
  return to <= context.window.to + 1e-9 ? { from: ready.ctx, to } : null;
}

/** Integrated loudness over a span: gated energy mean of momentary loudness. */
function integratedLufs(context: CheckContext, deck: DeckId, span: CtxSpan): number | null {
  const loud = framesIn(context.attempt.meters[deck], span)
    .map((frame) => frame.momentaryLufs)
    .filter((lufs) => lufs > ABSOLUTE_GATE_LUFS);
  return energyMeanDb(loud);
}

export const gainStaging: LessonCheck<TaskOf<"gain-staging">> = {
  situations: { transition: false },
  criteria: ["gain-staging.trim-A", "gain-staging.trim-B", "gain-staging.loud-match"],
  run(context, { decks }) {
    const windows = new Map(decks.map((deck) => [deck, readyWindow(context, deck)] as const));
    const trims: CriterionResult[] = decks.map((deck) => {
      const span = windows.get(deck) ?? null;
      return judge({
        id: `gain-staging.trim-${deck}` satisfies CriterionId,
        severity: "fail",
        unit: "dBFS",
        threshold: { op: "in", value: PEAK_ZONE, unit: "dBFS" },
        measured: span === null ? null : maxOf(context.attempt.meters[deck], span, (frame) => frame.samplePeakDb),
        evidence: span === null ? [] : [{ ...span, label: `deck ${deck} after Ready` }],
      });
    });
    if (context.spec.variant === "short" || decks.length < 2) return { criteria: trims, metrics: {} };

    const loudness = decks.map((deck) => {
      const span = windows.get(deck) ?? null;
      return span === null ? null : integratedLufs(context, deck, span);
    });
    const [first, second] = loudness;
    const difference =
      first === null || second === null || first === undefined || second === undefined ? null : Math.abs(first - second);

    return {
      criteria: [
        ...trims,
        judge({
          id: "gain-staging.loud-match",
          severity: "fail",
          unit: "dB",
          threshold: { op: "<=", value: LOUD_MATCH_DB, unit: "dB" },
          measured: difference,
        }),
      ],
      metrics: {},
    };
  },
};
