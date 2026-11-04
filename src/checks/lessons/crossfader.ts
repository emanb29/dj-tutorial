// Lesson 10, `crossfader`: a blend and a cut with the crossfader only, channel faders up (check-design §4).
import type { CtxSpan, DeckId } from "@shared/attempt.ts";
import type { CriterionResult } from "@shared/check-result.ts";
import { blendLength, blendStart, handover, loudSteady } from "../blend.ts";
import { loadedDeck, type CheckContext, type LessonCheck, type TaskOf } from "../context.ts";
import { allOf, judge } from "../criterion.ts";
import { channelFaderAt, cueOnSeconds, entryActionTime, exitActionTime } from "../mix.ts";
import { loudJump, phraseOffsetSeconds } from "../phrasing.ts";
import { beatSeconds, controlEvents } from "../timeline.ts";
import { mirroredAttempt } from "../set.ts";
import { pointActionToleranceMs } from "../tolerance.ts";
import { CUED_BEFORE_S, LOUD_JUMP_DB } from "./cut-on-phrase.ts";
import { SYNC_BLEND_BARS } from "./sync-blend.ts";

const FADERS_UP = 0.95;

/**
 * `xf-cut`, as `cut-on-phrase` (cut-start, cut-tight, cued-before, loud-jump). Point actions, so
 * timed on intent: the incoming deck's action time (its Play, or the start of the crossfader move
 * that opened it, whichever is later) and the start of the move that silenced the outgoing deck.
 */
function crossfaderCut(context: CheckContext, span: CtxSpan, incoming: DeckId): CriterionResult {
  const { attempt } = context;
  const outgoing: DeckId = incoming === "A" ? "B" : "A";
  const outDeck = loadedDeck(context, outgoing);
  const inAt = entryActionTime(attempt, incoming, span);
  const outAt = exitActionTime(attempt, outgoing, span);
  const startOffset = outDeck === null || inAt === null ? null : phraseOffsetSeconds(outDeck, inAt);
  const beat = outDeck === null || inAt === null ? null : beatSeconds(outDeck.playhead, outDeck.grid, inAt);
  return allOf("crossfader.xf-cut", [
    judge({
      id: "crossfader.xf-cut",
      severity: "fail",
      unit: "ms",
      threshold: { op: "<=", value: pointActionToleranceMs("cut-on-phrase", context.lessonId), unit: "ms" },
      measured: startOffset === null ? null : Math.abs(startOffset) * 1000,
      evidence: inAt === null ? [] : [{ from: inAt, to: inAt, label: `${incoming} in` }],
    }),
    judge({
      id: "crossfader.xf-cut",
      severity: "fail",
      unit: "beats",
      threshold: { op: "<=", value: 1, unit: "beats" },
      measured: inAt === null || outAt === null || beat === null ? null : Math.abs(outAt - inAt) / beat,
      evidence: outAt === null ? [] : [{ from: outAt, to: outAt, label: `${outgoing} out` }],
    }),
    judge({
      id: "crossfader.xf-cut",
      severity: "fail",
      unit: "s",
      threshold: { op: ">=", value: CUED_BEFORE_S, unit: "s" },
      measured: inAt === null ? null : cueOnSeconds(attempt, incoming, { from: span.from, to: inAt }),
    }),
    judge({
      id: "crossfader.xf-cut",
      severity: "fail",
      unit: "dB",
      threshold: { op: "<=", value: LOUD_JUMP_DB, unit: "dB" },
      measured: outDeck === null || inAt === null ? null : loudJump(context, outDeck, inAt),
    }),
  ]);
}

/** The lowest channel fader on either deck at any moment of the spans. */
function lowestFader(context: CheckContext, spans: readonly CtxSpan[]): number {
  const { attempt } = context;
  return Math.min(
    ...spans.flatMap((span) =>
      (["A", "B"] as const).flatMap((deck) => [
        channelFaderAt(attempt, deck, span.from),
        ...controlEvents(attempt.events, "channelFader", deck, span).map((move) => move.value),
      ]),
    ),
  );
}

/**
 * The Check's two transitions, each as a two-track view (outgoing A, incoming B, as a set's views,
 * check-design §5.4): the blend, A to B, over its section; the cut back to A over its section, the
 * decks swapped. The standing transition criteria (cued-first, level-match, on-phrase, trim-still)
 * then read each transition's own incoming deck and entry: CUE A before the cut, not only CUE B
 * before the blend.
 */
function transitionViews(context: CheckContext): readonly CheckContext[] {
  const task = context.spec.task;
  if (task.lessonId !== "crossfader") return [context];
  const blend = { ...context, window: task.blendSection };
  const cut = task.cutSection;
  if (cut === null) return [blend];
  const cutAttempt = cut.incoming === "A" ? mirroredAttempt(context.attempt) : context.attempt;
  return [blend, { ...context, attempt: cutAttempt, window: cut.span }];
}

export const crossfader: LessonCheck<TaskOf<"crossfader">> = {
  situations: { transition: true, transitionViews },
  criteria: ["crossfader.xf-blend", "crossfader.xf-cut", "crossfader.faders-up"],
  run(context, task) {
    const blend = handover(context, "A", "B", task.blendSection);
    const xfBlend = allOf("crossfader.xf-blend", [
      blendStart("crossfader.xf-blend", blend),
      blendLength("crossfader.xf-blend", blend, SYNC_BLEND_BARS[context.spec.variant]),
      loudSteady("crossfader.xf-blend", context, blend),
    ]);
    const cut = task.cutSection;
    const spans = cut === null ? [task.blendSection] : [task.blendSection, cut.span];
    return {
      criteria: [
        xfBlend,
        ...(cut === null ? [] : [crossfaderCut(context, cut.span, cut.incoming)]),
        judge({
          id: "crossfader.faders-up",
          severity: "fail",
          unit: "position",
          threshold: { op: ">=", value: FADERS_UP, unit: "position" },
          measured: lowestFader(context, spans),
        }),
      ],
      metrics: {},
    };
  },
};
