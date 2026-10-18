// Lesson 5, `headphone-cue`: tap B's beat in headphones while B stays off the master (check-design §4).
import type { CheckVariant } from "@shared/attempt.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judgeAll } from "../criterion.ts";
import { cueOnFraction, maxChannelGainDb } from "../mix.ts";
import { scoreTaps, tapDetail, tapsFor } from "../taps.ts";
import { heardBeats } from "../timeline.ts";
import { CUED_TAP_TOLERANCE_MS } from "../tolerance.ts";

const MAX_EXTRAS: Readonly<Record<CheckVariant, number>> = { full: 5, short: 2 };
const TAP_RATIO = 0.85;
const OFF_MASTER_DB = -60;
const CUE_ON_FRACTION = 0.95;

export const headphoneCue: LessonCheck<TaskOf<"headphone-cue">> = {
  situations: { transition: false },
  criteria: ["headphone-cue.cued-taps", "headphone-cue.b-off-master"],
  run(context, { tapSection }) {
    const tolerance = CUED_TAP_TOLERANCE_MS / 1000;
    const deckB = loadedDeck(context, "B");
    const beats = deckB === null ? [] : heardBeats(deckB.playhead, deckB.grid, tapSection).map((beat) => beat.ctx);
    const scored = scoreTaps(tapsFor(context, tapSection, tolerance), beats, tolerance);
    const cueFraction = cueOnFraction(context.attempt, "B", tapSection);

    return {
      criteria: [
        judgeAll(
          {
            id: "headphone-cue.cued-taps",
            severity: "fail",
            unit: "ratio",
            threshold: { op: ">=", value: TAP_RATIO, unit: "ratio" },
            measured: scored.ratio,
            detail: tapDetail(scored),
          },
          {
            id: "headphone-cue.cued-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: "<=", value: MAX_EXTRAS[context.spec.variant], unit: "count" },
            measured: scored.extras,
            scale: 1,
          },
        ),
        judgeAll(
          {
            id: "headphone-cue.b-off-master",
            severity: "fail",
            unit: "dB",
            threshold: { op: "<=", value: OFF_MASTER_DB, unit: "dB" },
            measured: maxChannelGainDb(context.attempt, "B", context.window),
            detail: { cueOnFraction: cueFraction },
          },
          {
            id: "headphone-cue.b-off-master",
            severity: "fail",
            unit: "ratio",
            threshold: { op: ">=", value: CUE_ON_FRACTION, unit: "ratio" },
            measured: cueFraction,
          },
        ),
      ],
      metrics: {},
    };
  },
};
