// Lesson 10, `crossfader`: a blend and a cut with the crossfader only, channel faders up (check-design §4).
import type { CtxSpan, DeckId } from "@shared/attempt.ts";
import type { CriterionResult } from "@shared/check-result.ts";
import { blendLength, blendStart, handover, loudSteady } from "../blend.ts";
import type { CheckContext, LessonCheck, TaskOf } from "../context.ts";
import { allOf, judge } from "../criterion.ts";
import { channelFaderAt } from "../mix.ts";
import { phraseOffsetSeconds } from "../phrasing.ts";
import { beatSeconds, controlEvents } from "../timeline.ts";
import { pointActionToleranceMs } from "../tolerance.ts";
import { SYNC_BLEND_BARS } from "./sync-blend.ts";

const FADERS_UP = 0.95;

/**
 * `xf-cut`, as `cut-on-phrase`: the incoming deck in within the point-action tolerance of the
 * outgoing deck's phrase start (its `t_in`, so either Play or the crossfader slam can be the cut),
 * and the outgoing deck out within 1 beat of it.
 */
function crossfaderCut(context: CheckContext, span: CtxSpan, incoming: DeckId): CriterionResult {
  const outgoing: DeckId = incoming === "A" ? "B" : "A";
  const move = handover(context, outgoing, incoming, span);
  const { inAt, outAt } = move;
  const startOffset = move.outgoing === null || inAt === null ? null : phraseOffsetSeconds(move.outgoing, inAt);
  const beat = move.outgoing === null || inAt === null ? null : beatSeconds(move.outgoing.playhead, move.outgoing.grid, inAt);
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

export const crossfader: LessonCheck<TaskOf<"crossfader">> = {
  situations: { transition: true },
  run(context, task) {
    const blend = handover(context, "A", "B", task.blendSection);
    const xfBlend = allOf("crossfader.xf-blend", [
      blendStart("crossfader.xf-blend", blend),
      blendLength("crossfader.xf-blend", blend, SYNC_BLEND_BARS.full),
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
