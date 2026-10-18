// Lesson 15, `tempo-by-ear`: match B's tempo to A's by ear, display hidden (check-design §4).
import type { CtxTime } from "@shared/attempt.ts";
import { barSeconds, type LessonCheck, type TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { TIME_EPSILON } from "../measures.ts";
import { overcorrection } from "../overcorrect.ts";
import { phaseErrorMs, phasePair, PHASE_SAMPLE_S, sampleTimes, tempoBpmAt } from "../phase.ts";

const MAX_GAP_BPM = 0.1;
const PHASE_MS = 20;
const HOLD_FRACTION = 0.95;
/** `t_c` within 32 bars of the start, held 8 bars; the short form: within 24, held 4. */
const LIMITS = { full: { withinBars: 32, holdBars: 8 }, short: { withinBars: 24, holdBars: 4 } } as const;

export const tempoByEar: LessonCheck<TaskOf<"tempo-by-ear">> = {
  situations: { transition: false },
  criteria: ["tempo-by-ear.tempo-match"],
  run(context, task) {
    const { attempt, window, spec } = context;
    const pair = phasePair(context);
    const { withinBars, holdBars } = LIMITS[spec.variant];
    let convergedAt: CtxTime | null = null;
    let bar: number | null = null;

    if (pair !== null) {
      bar = barSeconds(pair.master, task.matchFrom);
      // One pass of samples over every hold window a candidate t_c could need; past the window end nothing holds.
      const times = sampleTimes({ from: task.matchFrom, to: task.matchFrom + (withinBars + holdBars) * bar });
      const samples = times.map((t) => {
        if (t >= window.to) return { tempo: false, phase: false };
        const a = tempoBpmAt(attempt, pair.master, t);
        const b = tempoBpmAt(attempt, pair.other, t);
        const error = phaseErrorMs(pair, t);
        return {
          tempo: a !== null && b !== null && Math.abs(a - b) <= MAX_GAP_BPM + TIME_EPSILON,
          phase: error !== null && Math.abs(error) < PHASE_MS,
        };
      });
      // Prefix sums, so each candidate's hold window is counted in O(1).
      const prefix = (pick: (sample: (typeof samples)[number]) => boolean) => {
        const sums = [0];
        for (const sample of samples) sums.push((sums.at(-1) ?? 0) + (pick(sample) ? 1 : 0));
        return sums;
      };
      const tempoOk = prefix((sample) => sample.tempo);
      const phaseOk = prefix((sample) => sample.phase);
      const holdSamples = Math.round((holdBars * bar) / PHASE_SAMPLE_S);
      const candidates = Math.round((withinBars * bar) / PHASE_SAMPLE_S) + 1;
      const count = (sums: readonly number[], index: number) => (sums[index + holdSamples] ?? 0) - (sums[index] ?? 0);
      const first = Array.from({ length: Math.min(candidates, samples.length - holdSamples + 1) }, (_, index) => index).find(
        (index) => count(tempoOk, index) === holdSamples && count(phaseOk, index) >= HOLD_FRACTION * holdSamples,
      );
      convergedAt = first === undefined ? null : (times[first] ?? null);
    }

    const { tempoReversals, maxBendPercent } = overcorrection(context);
    return {
      criteria: [
        judge({
          id: "tempo-by-ear.tempo-match",
          severity: "fail",
          unit: "bars",
          threshold: { op: "<=", value: withinBars, unit: "bars" },
          measured: convergedAt === null || bar === null ? null : (convergedAt - task.matchFrom) / bar,
          evidence: convergedAt === null || bar === null ? [] : [{ from: convergedAt, to: convergedAt + holdBars * bar, label: "matched" }],
        }),
      ],
      metrics: { tempoReversals, maxBendPercent },
    };
  },
};
