// Lesson 12, `bass-swap`: a sync blend with B's lows cut, swapping the lows on a phrase start
// (check-design §4). Its Placement form also measures the skills the Sync-mixing group credits.
import type { CtxTime } from "@shared/attempt.ts";
import type { CriterionResult } from "@shared/check-result.ts";
import { blendLength, blendStart, clashShort, handover, loudSteady, lowDbAt, swapOnPhrase, type Handover } from "../blend.ts";
import type { CheckContext, LessonCheck, TaskOf } from "../context.ts";
import { judge, notApplicable } from "../criterion.ts";
import { deckControlChanges, isSyncedAt } from "../deck-controls.ts";
import { TIME_EPSILON } from "../measures.ts";
import { overlapSpans } from "../mix.ts";
import { phasePair, sampleTimes, tempoBpmAt } from "../phase.ts";
import { firstPlayStart } from "../timeline.ts";
import { SYNC_BLEND_BARS } from "./sync-blend.ts";

const ENTER_LOW_DB = -20;
/** `tempo-fader.set-bpm`'s tolerance, reused for tempos matched during a blend. */
const TEMPO_MATCH_BPM = 0.05;

/**
 * Placement-only `tempo-fader.tempo-matched`: the largest `|bpm_A − bpm_B|` (tempo faders, jog
 * bends factored out) while both decks are audible. It shows the tempo-fader skill only when the
 * Learner matched by hand: the tempos started apart (the Placement setup puts them 1–3% apart) and
 * SYNC stayed off on both decks during the overlap. Otherwise it is `notApplicable` and Placement
 * must not credit `tempo-fader`, which stays unpassed for its own Lesson.
 */
function tempoMatched(context: CheckContext): CriterionResult {
  const { attempt, window } = context;
  const pair = phasePair(context);
  const overlap = overlapSpans(attempt, window);
  const threshold = { op: "<=", value: TEMPO_MATCH_BPM, unit: "BPM" } as const;
  const bpmGap = (t: CtxTime) => {
    if (pair === null) return null;
    const a = tempoBpmAt(attempt, pair.master, t);
    const b = tempoBpmAt(attempt, pair.other, t);
    return a === null || b === null ? null : Math.abs(a - b);
  };

  const starts = pair === null ? [] : [pair.master, pair.other].map((deck) => firstPlayStart(deck.playhead, window.from));
  const bothPlaying = starts.some((start) => start === null) ? null : Math.max(...starts.map((start) => start ?? 0));
  const startGap = bothPlaying === null ? null : bpmGap(bothPlaying + TIME_EPSILON * 10);
  const syncUsed = overlap.some((span) =>
    (["A", "B"] as const).some((deck) =>
      [span.from, ...deckControlChanges(attempt, "sync", deck).map((command) => command.ctx).filter((t) => t > span.from && t < span.to)].some((t) =>
        isSyncedAt(attempt, deck, t),
      ),
    ),
  );
  const detail = { tempoGapAtStartBpm: startGap ?? 0, syncUsed: syncUsed ? 1 : 0 };
  if (syncUsed || startGap === null || startGap <= TEMPO_MATCH_BPM + TIME_EPSILON) {
    return { ...notApplicable("tempo-fader.tempo-matched", "fail", "BPM", threshold), detail };
  }

  const gaps = overlap.flatMap(sampleTimes).map(bpmGap);
  const measured = gaps.length === 0 || gaps.some((gap) => gap === null) ? null : Math.max(...gaps.map((gap) => gap ?? 0));
  return judge({ id: "tempo-fader.tempo-matched", severity: "fail", unit: "BPM", threshold, measured, detail });
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
        ? [
            blendStart("sync-blend.blend-start", move),
            // The Lesson's own (full-form) range: the bass-swap task is not sync-blend's 8-bar short form.
            blendLength("sync-blend.blend-length", move, SYNC_BLEND_BARS.full),
            loudSteady("sync-blend.loud-steady", context, move),
            tempoMatched(context),
          ]
        : [];
    return { criteria: [...criteria, ...placement], metrics: {} };
  },
};
