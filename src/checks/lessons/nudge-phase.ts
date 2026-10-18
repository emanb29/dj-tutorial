// Lesson 14, `nudge-phase`: bring B back in phase with the jog wheel and hold it (check-design §4).
import type { CtxSpan, CtxTime } from "@shared/attempt.ts";
import type { LessonCheck, TaskOf } from "../context.ts";
import { barSeconds } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import { firstPhaseUnder, phaseErrorMs, phaseHold, phasePair, sampleTimes, type PhasePair } from "../phase.ts";
import { controlEvents } from "../timeline.ts";

const CONVERGE_MS = 15;
const CONVERGE_BARS = 4;
const HOLD_FRACTION = 0.95;
const RUN_LIMIT_MS = 30;
/** `hold` over 8 bars in the full form, 4 in the short form. */
const HOLD_BARS = { full: 8, short: 4 } as const;
const MAX_CUE_PRESSES = 1;

/**
 * `t_c`: the first moment under 15 ms from which the 8-bar hold is met, if one comes within the 4
 * bars `converge` allows; else the first moment under 15 ms (the hold then reports how it failed).
 * A first nudge that swings B through A and out the other side passes under 15 ms on the way: the
 * Learner who brings it back and holds it converged when the hold began, not at that crossing.
 */
function convergence(pair: PhasePair, phaseFrom: CtxTime, window: CtxSpan, bar: number, holdBars: number): CtxTime | null {
  const first = firstPhaseUnder(pair, { from: phaseFrom, to: window.to }, CONVERGE_MS);
  if (first === null) return null;
  const holdS = holdBars * bar;
  const times = sampleTimes({ from: phaseFrom, to: phaseFrom + (CONVERGE_BARS + holdBars) * bar });
  // Past the window nothing is held (the deck stopped, or was never heard).
  const under = times.map((t) => {
    const error = t < window.to ? phaseErrorMs(pair, t) : null;
    return error !== null && Math.abs(error) < CONVERGE_MS;
  });
  const sums = [0];
  for (const held of under) sums.push((sums.at(-1) ?? 0) + (held ? 1 : 0));
  const holdSamples = sampleTimes({ from: 0, to: holdS }).length;
  const candidates = sampleTimes({ from: phaseFrom, to: phaseFrom + CONVERGE_BARS * bar }).length + 1;
  for (let index = 0; index < Math.min(candidates, times.length); index += 1) {
    const t = times[index];
    if (t === undefined || under[index] !== true) continue;
    // Cheap test first (the hold fraction from the sums), then the exact one with the run rule.
    if ((sums[index + holdSamples] ?? 0) - (sums[index] ?? 0) < HOLD_FRACTION * holdSamples) continue;
    const hold = phaseHold(pair, [{ from: t, to: t + holdS }], CONVERGE_MS, RUN_LIMIT_MS);
    if (hold.holdFraction >= HOLD_FRACTION && hold.worstRunS <= bar / 4) return t;
  }
  return first;
}

export const nudgePhase: LessonCheck<TaskOf<"nudge-phase">> = {
  situations: { transition: false },
  criteria: ["nudge-phase.converge", "nudge-phase.hold", "nudge-phase.cue-presses"],
  run(context, task) {
    const { attempt, window, spec } = context;
    const pair = phasePair(context);
    const bar = pair === null ? null : barSeconds(pair.master, task.phaseFrom);
    const convergedAt = pair === null || bar === null ? null : convergence(pair, task.phaseFrom, window, bar, HOLD_BARS[spec.variant]);
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
