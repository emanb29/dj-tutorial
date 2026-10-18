// Lesson 14, `nudge-phase`: bring B back in phase with the jog wheel and hold it (check-design §4).
import type { LessonCheck, TaskOf } from "../context.ts";
import { barSeconds } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import { firstPhaseUnder, phaseHold, phasePair } from "../phase.ts";
import { controlEvents } from "../timeline.ts";

const CONVERGE_MS = 15;
const CONVERGE_BARS = 4;
const HOLD_FRACTION = 0.95;
const RUN_LIMIT_MS = 30;
/** `hold` over 8 bars in the full form, 4 in the short form. */
const HOLD_BARS = { full: 8, short: 4 } as const;
const MAX_CUE_PRESSES = 1;

export const nudgePhase: LessonCheck<TaskOf<"nudge-phase">> = {
  situations: { transition: false },
  criteria: ["nudge-phase.converge", "nudge-phase.hold", "nudge-phase.cue-presses"],
  run(context, task) {
    const { attempt, window, spec } = context;
    const pair = phasePair(context);
    const bar = pair === null ? null : barSeconds(pair.master, task.phaseFrom);
    const convergedAt = pair === null ? null : firstPhaseUnder(pair, { from: task.phaseFrom, to: window.to }, CONVERGE_MS);
    const holdSpan = bar === null || convergedAt === null ? null : { from: convergedAt, to: convergedAt + HOLD_BARS[spec.variant] * bar };
    // The whole hold span counts, even past the window end: an attempt cut short has not held.
    const hold = pair === null || holdSpan === null ? null : phaseHold(pair, [holdSpan], CONVERGE_MS, RUN_LIMIT_MS);
    const beat = bar === null ? null : bar / 4;
    const cuePresses = controlEvents(attempt.events, "deckCue", "B", window).filter((press) => press.value === 1);

    return {
      criteria: [
        judge({
          id: "nudge-phase.converge",
          severity: "fail",
          unit: "bars",
          threshold: { op: "<=", value: CONVERGE_BARS, unit: "bars" },
          measured: bar === null || convergedAt === null ? null : (convergedAt - task.phaseFrom) / bar,
          evidence: convergedAt === null ? [] : [{ from: task.phaseFrom, to: convergedAt, label: "in phase" }],
        }),
        judgeAll(
          {
            id: "nudge-phase.hold",
            severity: "fail",
            unit: "ratio",
            threshold: { op: ">=", value: HOLD_FRACTION, unit: "ratio" },
            measured: hold?.holdFraction ?? null,
            ...(hold === null || beat === null ? {} : { detail: { worstRunBeats: hold.worstRunS / beat } }),
            evidence: hold?.worstRun == null ? [] : [{ ...hold.worstRun, label: "phase over 30 ms" }],
          },
          {
            id: "nudge-phase.hold",
            severity: "fail",
            unit: "beats",
            threshold: { op: "<=", value: 1, unit: "beats" },
            measured: hold === null || beat === null ? null : hold.worstRunS / beat,
          },
        ),
        judge({
          id: "nudge-phase.cue-presses",
          severity: "fail",
          unit: "count",
          threshold: { op: "<=", value: MAX_CUE_PRESSES, unit: "count" },
          measured: cuePresses.length,
          evidence: cuePresses.map((press) => ({ from: press.ctx, to: press.ctx, label: "CUE B" })),
        }),
      ],
      metrics: {},
    };
  },
};
