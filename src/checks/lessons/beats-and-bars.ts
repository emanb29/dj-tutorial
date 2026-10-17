// Lesson 2, `beats-and-bars`: tap every beat, then only downbeats (check-design §4).
import type { CheckVariant } from "@shared/attempt.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judgeAll } from "../criterion.ts";
import { median } from "../measures.ts";
import { scoreTaps, tapDetail, tapsFor } from "../taps.ts";
import { heardBeats } from "../timeline.ts";
import { TAP_TOLERANCE_MS } from "../tolerance.ts";

/**
 * Full form: 8 + 8 bars. Short form: 4 + 4 bars, same ratios (extras scaled down). The downbeat
 * extras cap is an owner decision (2026-10-17) so tap spam around each downbeat cannot pass.
 */
const LIMITS: Readonly<Record<CheckVariant, { beatExtras: number; downbeatsMatched: number; downbeatExtras: number }>> = {
  full: { beatExtras: 3, downbeatsMatched: 7, downbeatExtras: 3 },
  short: { beatExtras: 1, downbeatsMatched: 4, downbeatExtras: 1 },
};
const BEAT_RATIO = 0.9;

export const beatsAndBars: LessonCheck<TaskOf<"beats-and-bars">> = {
  situations: { transition: false },
  run(context, { beatSection, downbeatSection }) {
    const limits = LIMITS[context.spec.variant];
    const tolerance = TAP_TOLERANCE_MS / 1000;
    const deckA = loadedDeck(context, "A");

    const beats = deckA === null ? [] : heardBeats(deckA.playhead, deckA.grid, beatSection);
    const beatTaps = scoreTaps(tapsFor(context, beatSection, tolerance), beats.map((beat) => beat.ctx), tolerance);

    const around = { from: downbeatSection.from - 1, to: downbeatSection.to + 1 };
    const nearbyBeats = deckA === null ? [] : heardBeats(deckA.playhead, deckA.grid, around);
    const downbeats = nearbyBeats
      .filter((beat) => beat.isDownbeat && beat.ctx >= downbeatSection.from && beat.ctx < downbeatSection.to)
      .map((beat) => beat.ctx);
    const downbeatTapTimes = tapsFor(context, downbeatSection, tolerance);
    const downbeatTaps = scoreTaps(downbeatTapTimes, downbeats, tolerance);
    const wrongBeat = downbeatTapTimes.filter((tap) => {
      const nearest = nearbyBeats.reduce<(typeof nearbyBeats)[number] | null>(
        (best, beat) => (best === null || Math.abs(beat.ctx - tap) < Math.abs(best.ctx - tap) ? beat : best),
        null,
      );
      return nearest !== null && !nearest.isDownbeat;
    }).length;

    const medianOffset = median([...beatTaps.offsets, ...downbeatTaps.offsets]);

    return {
      criteria: [
        judgeAll(
          {
            id: "beats-and-bars.beat-taps",
            severity: "fail",
            unit: "ratio",
            threshold: { op: ">=", value: BEAT_RATIO, unit: "ratio" },
            measured: beatTaps.ratio,
            detail: tapDetail(beatTaps),
          },
          {
            id: "beats-and-bars.beat-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: "<=", value: limits.beatExtras, unit: "count" },
            measured: beatTaps.extras,
            scale: 1,
          },
        ),
        judgeAll(
          {
            id: "beats-and-bars.downbeat-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: ">=", value: limits.downbeatsMatched, unit: "count" },
            measured: downbeatTaps.matched,
            detail: { ...tapDetail(downbeatTaps), wrongBeat },
          },
          {
            id: "beats-and-bars.downbeat-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: "<=", value: 0, unit: "count" },
            measured: wrongBeat,
            scale: 1,
          },
          {
            id: "beats-and-bars.downbeat-taps",
            severity: "fail",
            unit: "count",
            threshold: { op: "<=", value: limits.downbeatExtras, unit: "count" },
            measured: downbeatTaps.extras,
          },
        ),
      ],
      metrics: medianOffset === null ? {} : { medianTapOffsetMs: medianOffset * 1000 },
    };
  },
};
