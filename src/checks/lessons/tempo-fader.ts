// Lesson 8, `tempo-fader`: set B to target BPMs, and hear whether Master Tempo is on (check-design §4).
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { tempoBpmAt } from "../phase.ts";
import { controlEvents } from "../timeline.ts";

const BPM_TOLERANCE = 0.05;

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
      const bpm = at === undefined || deckB === null ? null : tempoBpmAt(attempt, deckB, at);
      return bpm === null ? null : Math.abs(bpm - target);
    });
    const worst = errors.some((error) => error === null) ? null : Math.max(...errors.filter((error) => error !== null));
    const correct = task.masterTempoClips.filter((clip) => attempt.answers[clip.answerKey] === (clip.masterTempoOn ? 1 : 0)).length;

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
        judge({
          id: "tempo-fader.master-tempo-ear",
          severity: "fail",
          unit: "count",
          threshold: { op: ">=", value: task.masterTempoClips.length, unit: "count" },
          measured: correct,
        }),
      ],
      metrics: {},
    };
  },
};
