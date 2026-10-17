// Lesson 12, `bass-swap`: a sync blend with B's lows cut, swapping the lows on a phrase start
// (check-design §4). Its Placement form also measures the skills the Sync-mixing group credits.
import type { CriterionResult } from "@shared/check-result.ts";
import { clashShort, handover, loudSteady, lowDbAt, swapOnPhrase, blendStart, type Handover } from "../blend.ts";
import type { CheckContext, LessonCheck, TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { overlapSpans } from "../mix.ts";
import { phasePair, sampleTimes, tempoBpmAt } from "../phase.ts";

const ENTER_LOW_DB = -20;
/** `tempo-fader.set-bpm`'s tolerance, reused for tempos matched during a blend. */
const TEMPO_MATCH_BPM = 0.05;

/**
 * Placement-only `tempo-fader.tempo-matched`: the largest `|bpm_A − bpm_B|` (tempo faders, jog
 * bends factored out) while both decks are audible. The Placement setup puts the tempos 1–3% apart,
 * so this is where crediting `tempo-fader` rests on a measurement.
 */
function tempoMatched(context: CheckContext): CriterionResult {
  const pair = phasePair(context);
  const overlap = overlapSpans(context.attempt, context.window);
  const gaps =
    pair === null
      ? []
      : overlap.flatMap(sampleTimes).map((t) => {
          const a = tempoBpmAt(context.attempt, pair.master, t);
          const b = tempoBpmAt(context.attempt, pair.other, t);
          return a === null || b === null ? null : Math.abs(a - b);
        });
  const measured = gaps.length === 0 || gaps.some((gap) => gap === null) ? null : Math.max(...gaps.map((gap) => gap ?? 0));
  return judge({
    id: "tempo-fader.tempo-matched",
    severity: "fail",
    unit: "BPM",
    threshold: { op: "<=", value: TEMPO_MATCH_BPM, unit: "BPM" },
    measured,
  });
}

export function enterLowCut(context: CheckContext, move: Handover): CriterionResult {
  return judge({
    id: "bass-swap.enter-low-cut",
    severity: "fail",
    unit: "dB",
    threshold: { op: "<=", value: ENTER_LOW_DB, unit: "dB" },
    measured: move.inAt === null ? null : lowDbAt(context, "B", move.inAt),
  });
}

export const bassSwap: LessonCheck<TaskOf<"bass-swap">> = {
  situations: { transition: true },
  run(context) {
    const move = handover(context, "A", "B");
    const criteria = [
      enterLowCut(context, move),
      swapOnPhrase("bass-swap.swap-time", context, move),
      clashShort("bass-swap.clash-short", context, move),
    ];
    // Placement design §4.1: credit for the group's earlier Lessons rests on measurements.
    const placement =
      context.spec.mode === "placement"
        ? [blendStart("sync-blend.blend-start", move), loudSteady("sync-blend.loud-steady", context, move), tempoMatched(context)]
        : [];
    return { criteria: [...criteria, ...placement], metrics: {} };
  },
};
