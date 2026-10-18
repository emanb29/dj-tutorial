// Lesson 8, `tempo-fader`: set B to target BPMs, and hear whether Master Tempo is on (check-design §4).
import type { Attempt, CtxTime, DeckId } from "@shared/attempt.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge, notApplicable } from "../criterion.ts";
import { TIME_EPSILON } from "../measures.ts";
import { tempoBpmAt } from "../phase.ts";
import { controlEvents } from "../timeline.ts";

const BPM_TOLERANCE = 0.05;
const PLAYHEAD_CONTROLS: ReadonlySet<string> = new Set(["tempo", "jogBend", "sync", "masterTempo"]);

/**
 * When the deck's tempo as it stood at the press `at` is in the playhead model. A move takes effect an
 * output latency (and, with Master Tempo, the stretch lead) after it was made, while the display shows
 * it at once: a Ready pressed in that gap confirms the BPM the display read (input leeway).
 */
function settledAt(attempt: Attempt, deck: DeckId, at: CtxTime): CtxTime {
  return attempt.events
    .filter((event) => event.deck === deck && PLAYHEAD_CONTROLS.has(event.control) && event.ctx <= at + TIME_EPSILON)
    .reduce((latest, event) => Math.max(latest, event.appliedCtx ?? event.ctx), at);
}

export const tempoFader: LessonCheck<TaskOf<"tempo-fader">> = {
  situations: { transition: false },
  run(context, task) {
    const { attempt, window } = context;
    const deckB = loadedDeck(context, "B");
    // Confirm presses: "Ready" for each target but the last, which may be "Done".
    const confirms = [...controlEvents(attempt.events, "ready", "B", window), ...controlEvents(attempt.events, "done", undefined, window)]
      .map((press) => press.ctx)
      .sort((a, b) => a - b)
      .slice(0, task.targetsBpm.length);
    const errors = task.targetsBpm.map((target, index) => {
      const at = confirms[index];
      const bpm = at === undefined || deckB === null ? null : tempoBpmAt(attempt, deckB, settledAt(attempt, "B", at));
      return bpm === null ? null : Math.abs(bpm - target);
    });
    const worst = errors.some((error) => error === null) ? null : Math.max(...errors.filter((error) => error !== null));
    const correct = task.masterTempoClips.filter((clip) => attempt.answers[clip.answerKey] === (clip.masterTempoOn ? 1 : 0)).length;
    const earThreshold = { op: ">=", value: task.masterTempoClips.length, unit: "count" } as const;

    return {
      criteria: [
        judge({
          id: "tempo-fader.set-bpm",
          severity: "fail",
          unit: "BPM",
          threshold: { op: "<=", value: BPM_TOLERANCE, unit: "BPM" },
          measured: worst,
          detail: { targets: task.targetsBpm.length, confirmed: confirms.length },
          evidence: confirms.map((at) => ({ from: at, to: at, label: "BPM set" })),
        }),
        // No clip was played (Master Tempo could not load): there is nothing the ear was asked.
        task.masterTempoClips.length === 0
          ? notApplicable("tempo-fader.master-tempo-ear", "fail", "count", earThreshold)
          : judge({
              id: "tempo-fader.master-tempo-ear",
              severity: "fail",
              unit: "count",
              threshold: earThreshold,
              measured: correct,
            }),
      ],
      metrics: {},
    };
  },
};
