// Lesson 13, `filter-transition`: high-pass A out over 8–16 bars while B comes in (check-design §4).
import type { CtxTime } from "@shared/attempt.ts";
import { handover } from "../blend.ts";
import type { LessonCheck, TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { deckControlChanges, filterAt, type DeckControlChange } from "../deck-controls.ts";
import { TIME_EPSILON } from "../measures.ts";

const HPF_DEPTH = 0.7;
/** The filter counts as on past this; within it, as centred (±5%). */
export const CFX_CENTRE_BAND = 0.05;
/** `filter-length`: 8–16 bars ± 1 beat; the short form 8–9 bars. */
const FILTER_BARS = { full: [8 - 0.25, 16 + 0.25], short: [8, 9] } as const;

/**
 * Where the filter-out starts: the CFX move that begins the high-pass sweep still on when A goes
 * silent. Excursions that come back to centre earlier (a nudge) are not it; a dip to centre shorter
 * than 1 beat inside the sweep does not restart it. `null` when no sweep reaches `t_out` (within 1 beat).
 */
function sustainedSweepStart(moves: readonly DeckControlChange[], outAt: CtxTime, beat: number): CtxTime | null {
  const spans: { from: CtxTime; to: CtxTime }[] = [];
  moves.forEach((move, index) => {
    if (move.value <= CFX_CENTRE_BAND) return;
    const to = moves.slice(index + 1).find((next) => next.value <= CFX_CENTRE_BAND)?.ctx ?? outAt;
    const last = spans.at(-1);
    if (last !== undefined && move.ctx <= last.to + TIME_EPSILON) return;
    if (last !== undefined && move.ctx - last.to < beat) last.to = to;
    else spans.push({ from: move.ctx, to });
  });
  const sweep = spans.at(-1);
  return sweep !== undefined && sweep.to >= outAt - beat - TIME_EPSILON ? sweep.from : null;
}

export const filterTransition: LessonCheck<TaskOf<"filter-transition">> = {
  situations: { transition: true },
  criteria: ["filter-transition.hpf-depth", "filter-transition.filter-length", "filter-transition.cfx-back"],
  run(context) {
    const { attempt, window, spec } = context;
    const move = handover(context, "A", "B");
    const { outAt, bar } = move;
    const filterMoves = deckControlChanges(attempt, "filter", "A").filter((change) => change.ctx >= window.from - TIME_EPSILON);
    const beforeOut = outAt === null ? [] : filterMoves.filter((change) => change.ctx < outAt);
    const depth = outAt === null ? null : beforeOut.reduce((most, change) => Math.max(most, change.value), 0);
    const filterOn = outAt === null || bar === null ? null : sustainedSweepStart(beforeOut, outAt, bar / 4);
    const centredAt = (from: CtxTime): CtxTime | null =>
      Math.abs(filterAt(attempt, "A", from)) <= CFX_CENTRE_BAND
        ? from
        : (filterMoves.find((change) => change.ctx > from && Math.abs(change.value) <= CFX_CENTRE_BAND)?.ctx ?? null);
    const backAt = outAt === null ? null : centredAt(outAt);

    return {
      criteria: [
        judge({
          id: "filter-transition.hpf-depth",
          severity: "fail",
          unit: "ratio",
          threshold: { op: ">=", value: HPF_DEPTH, unit: "ratio" },
          measured: depth,
        }),
        judge({
          id: "filter-transition.filter-length",
          severity: "fail",
          unit: "bars",
          threshold: { op: "in", value: FILTER_BARS[spec.variant], unit: "bars" },
          measured: filterOn === null || outAt === null || bar === null ? null : (outAt - filterOn) / bar,
          evidence: filterOn === null || outAt === null ? [] : [{ from: filterOn, to: outAt, label: "filter on" }],
        }),
        judge({
          id: "filter-transition.cfx-back",
          severity: "fail",
          unit: "bars",
          threshold: { op: "<=", value: 1, unit: "bars" },
          measured: backAt === null || outAt === null || bar === null ? null : (backAt - outAt) / bar,
          evidence: backAt === null || outAt === null ? [] : [{ from: outAt, to: backAt, label: "CFX back" }],
        }),
      ],
      metrics: {},
    };
  },
};
