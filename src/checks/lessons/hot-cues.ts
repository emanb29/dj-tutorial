// Lesson 17, `hot-cues`: set hot cues on phrase starts, then trigger each on A's phrase start
// (check-design §4). One deck: each trigger jumps A to another phrase, on the phrase.
import type { CriterionResult } from "@shared/check-result.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judgeAll } from "../criterion.ts";
import { TIME_EPSILON } from "../measures.ts";
import { phraseOffsetSeconds } from "../phrasing.ts";
import { CUE_PLACEMENT_TOLERANCE_MS, pointActionToleranceMs } from "../tolerance.ts";

export const hotCues: LessonCheck<TaskOf<"hot-cues">> = {
  situations: { transition: false },
  criteria: ["hot-cues.hc-place", "hot-cues.hc-trigger"],
  run(context, task) {
    const { attempt, lessonId } = context;
    const deckA = loadedDeck(context, "A");
    const on = (span: { from: number; to: number }) => (event: { ctx: number; deck?: string }) =>
      event.deck === "A" && event.ctx >= span.from - TIME_EPSILON && event.ctx < span.to;

    // `hc-place`: the last hot cue set on each pad while A sat paused near its phrase start. On a paused
    // deck only the stored position counts, so a set belongs where it took effect (a press made right
    // after the Check's cue can be heard just before the cue reached the output). The last set takes
    // effect with the Ready that ends the placement, at the section's very end, so the end is included.
    const placedIn = { from: task.placeSection.from, to: task.placeSection.to + TIME_EPSILON * 2 };
    const sets = attempt.events.filter((event) => event.control === "hotCueSet" && on(placedIn)({ ...event, ctx: event.appliedCtx ?? event.ctx }));
    const placements = task.slots.map((slot) => {
      const set = sets.filter((event) => event.value === slot).at(-1);
      if (set?.pos === undefined || deckA === null || deckA.phraseMarkers.length === 0) return null;
      const pos = set.pos;
      const nearest = deckA.phraseMarkers.reduce((best, marker) => (Math.abs(marker - pos) < Math.abs(best - pos) ? marker : best));
      return Math.abs(pos - nearest) * 1000;
    });
    const placed = placements.filter((offset) => offset !== null);
    const notSet = placements.length - placed.length;

    // `hc-trigger`: every trigger once A plays, timed from the press (heard) on A's phrase starts. The jump
    // takes effect later (appliedCtx), so the playhead at the press is what the Learner heard.
    const triggers = attempt.events.filter((event) => event.control === "hotCue" && event.byEngine !== true && on(task.triggerSection)(event));
    const offsets = deckA === null ? [] : triggers.map((trigger) => phraseOffsetSeconds(deckA, trigger.ctx)).filter((offset) => offset !== null);
    const untriggered = task.slots.filter((slot) => !triggers.some((trigger) => trigger.value === slot)).length;
    const worstTriggerMs = offsets.length === 0 ? null : Math.max(...offsets.map((offset) => Math.abs(offset) * 1000));

    const criteria: CriterionResult[] = [
      judgeAll(
        {
          id: "hot-cues.hc-place",
          severity: "fail",
          unit: "ms",
          threshold: { op: "<=", value: CUE_PLACEMENT_TOLERANCE_MS, unit: "ms" },
          measured: placed.length === 0 ? null : Math.max(...placed),
          detail: { pads: task.slots.length, notSet },
          evidence: sets.map((set) => ({ from: set.ctx, to: set.ctx, label: `hot cue ${String(set.value)} set` })),
        },
        { id: "hot-cues.hc-place", severity: "fail", unit: "count", threshold: { op: "<=", value: 0, unit: "count" }, measured: notSet, scale: 1 },
      ),
      judgeAll(
        {
          id: "hot-cues.hc-trigger",
          severity: "fail",
          unit: "ms",
          threshold: { op: "<=", value: pointActionToleranceMs("hot-cues", lessonId), unit: "ms" },
          measured: worstTriggerMs,
          detail: { triggers: triggers.length, pads: task.slots.length, untriggered },
          evidence: triggers.map((trigger) => ({ from: trigger.ctx, to: trigger.ctx, label: `pad ${String(trigger.value)}` })),
        },
        { id: "hot-cues.hc-trigger", severity: "fail", unit: "count", threshold: { op: "<=", value: 0, unit: "count" }, measured: untriggered, scale: 1 },
      ),
    ];
    return { criteria, metrics: { hotCueTriggers: triggers.length } };
  },
};
