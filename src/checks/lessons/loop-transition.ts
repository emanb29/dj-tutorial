// Lesson 18, `loop-transition`: loop A's last phrase for 4 or 8 bars, bring B in on the loop's 1,
// exit the loop on a downbeat (check-design §4). Button presses are point actions, timed from the press;
// the loop's audio is in A's playhead model.
import type { CtxTime } from "@shared/attempt.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import { TIME_EPSILON } from "../measures.ts";
import { entryActionTime, isAudible } from "../mix.ts";
import { phraseOffsetBeats } from "../phrasing.ts";
import { downbeatOffsetAt, downbeatOffsetBeats, loopOnAt, loopsIn, type RecordedLoop } from "../performance.ts";
import { beatSeconds, playingFrom, rateAt } from "../timeline.ts";
import { pointActionToleranceMs } from "../tolerance.ts";

/** An auto loop is exact by construction: its length is graded to this. */
export const LOOP_LENGTH_TOLERANCE_MS = 20;
/** `loop-length`: 4 or 8 bars. */
const LOOP_BEATS = [16, 32] as const;
/** `no-double`: loop presses closer than this, while A is heard, are a double trigger. */
const DOUBLE_BEATS = 2;

export const loopTransition: LessonCheck<TaskOf<"loop-transition">> = {
  situations: { transition: true },
  criteria: ["loop-transition.loop-length", "loop-transition.loop-in", "loop-transition.loop-exit", "loop-transition.loop-entry", "loop-transition.no-double"],
  run(context) {
    const { attempt, window, lessonId } = context;
    const deckA = loadedDeck(context, "A");
    const deckB = loadedDeck(context, "B");
    const inB = entryActionTime(attempt, "B", window);
    const loops = loopsIn(attempt, "A", window);
    // The loop A was on when B came in; without an entry, the last loop of the attempt.
    const loop: RecordedLoop | null = (inB === null ? loops.at(-1) : loops.filter((each) => each.ctx <= inB + TIME_EPSILON).at(-1)) ?? null;

    const beat = deckA === null || loop === null ? null : beatSeconds(deckA.playhead, deckA.grid, loop.appliedCtx);
    const rate = deckA === null || loop === null ? 1 : rateAt(deckA.playhead, loop.appliedCtx) || 1;
    const heardLength = loop === null ? null : loop.length / rate;
    const lengthOffMs =
      heardLength === null || beat === null ? null : Math.min(...LOOP_BEATS.map((beats) => Math.abs(heardLength - beats * beat))) * 1000;
    // A loop closed by hand (LOOP OUT, then perhaps 2X/½X) carries the out press's leeway; 4 BEAT is on the grid.
    const lengthTolerance = loop?.closedBy === "loopOut" ? pointActionToleranceMs("loop-transition", lessonId) : LOOP_LENGTH_TOLERANCE_MS;

    const exit = loop === null ? undefined : attempt.events.find((event) => event.control === "loopExit" && event.deck === "A" && event.byEngine !== true && event.ctx > loop.ctx && event.ctx < window.to);
    const exitOff = deckA === null || exit === undefined ? null : downbeatOffsetAt(deckA, exit.ctx);

    const entryOffA = deckA === null || inB === null ? null : downbeatOffsetAt(deckA, inB);
    // B's Play is timed from its press; its own phrase position is read where its audio starts.
    const entryOffB = deckB === null || inB === null ? null : phraseOffsetBeats(deckB, playingFrom(deckB.playhead, inB));
    const notLooping = inB === null ? 1 : loopOnAt(attempt, "A", inB) ? 0 : 1;

    const presses = attempt.events.filter(
      (event) =>
        event.deck === "A" &&
        event.byEngine !== true &&
        (event.control === "loopIn" || event.control === "loopAuto" || event.control === "loopExit") &&
        event.ctx >= window.from - TIME_EPSILON &&
        event.ctx < window.to,
    );
    const doubles = deckA === null ? [] : presses.filter((press, index) => {
      const previous = presses[index - 1];
      return previous !== undefined && press.ctx - previous.ctx < DOUBLE_BEATS * beatSeconds(deckA.playhead, deckA.grid, press.ctx) && isAudible(attempt, "A", press.ctx);
    });

    const at = (t: CtxTime | null | undefined, label: string) => (t == null ? [] : [{ from: t, to: t, label }]);
    return {
      criteria: [
        judge({
          id: "loop-transition.loop-length",
          severity: "fail",
          unit: "ms",
          threshold: { op: "<=", value: lengthTolerance, unit: "ms" },
          measured: lengthOffMs,
          ...(heardLength === null || beat === null ? {} : { detail: { loopBeats: heardLength / beat } }),
          evidence: loop === null ? [] : [{ from: loop.ctx, to: loop.ctx, label: "loop on" }],
        }),
        judge({
          id: "loop-transition.loop-in",
          severity: "fail",
          unit: "beats",
          threshold: { op: "<=", value: 1, unit: "beats" },
          measured: deckA === null || loop === null ? null : Math.abs(downbeatOffsetBeats(deckA, loop.start)),
        }),
        judge({
          id: "loop-transition.loop-exit",
          severity: "fail",
          unit: "beats",
          threshold: { op: "<=", value: 1, unit: "beats" },
          measured: exitOff === null ? null : Math.abs(exitOff),
          evidence: at(exit?.ctx, "EXIT"),
        }),
        judgeAll(
          {
            id: "loop-transition.loop-entry",
            severity: "fail",
            unit: "beats",
            threshold: { op: "<=", value: 1, unit: "beats" },
            measured: entryOffA === null ? null : Math.abs(entryOffA),
            ...(entryOffB === null ? {} : { detail: { incomingPhraseBeats: entryOffB } }),
            evidence: at(inB, "B in"),
          },
          { id: "loop-transition.loop-entry", severity: "fail", unit: "beats", threshold: { op: "<=", value: 1, unit: "beats" }, measured: entryOffB === null ? null : Math.abs(entryOffB) },
          { id: "loop-transition.loop-entry", severity: "fail", unit: "count", threshold: { op: "<=", value: 0, unit: "count" }, measured: notLooping, scale: 1 },
        ),
        judge({
          id: "loop-transition.no-double",
          severity: "fail",
          unit: "count",
          threshold: { op: "<=", value: 0, unit: "count" },
          measured: doubles.length,
          scale: 1,
          evidence: doubles.map((press) => ({ from: press.ctx, to: press.ctx, label: "double press" })),
        }),
      ],
      metrics: { loops: loops.length },
    };
  },
};
