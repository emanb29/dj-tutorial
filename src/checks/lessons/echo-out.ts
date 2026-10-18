// Lesson 19, `echo-out`: ECHO on A, cut A's fader on a downbeat, B in on the phrase start A would have
// reached, Beat FX off once the echoes die out (check-design §4). The cut and B's Play are point actions,
// timed from the action; the echo's tail is an audible effect, read from the FX return meter.
import { barSeconds, loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge, judgeAll } from "../criterion.ts";
import { playPressTime } from "../deck-controls.ts";
import { TIME_EPSILON } from "../measures.ts";
import { entryTime, exitActionTime, exitTime } from "../mix.ts";
import { downbeatOffsetAt, echoingAt, fxTailEnd, playingRateAt } from "../performance.ts";
import { beatSeconds, playRunStartAt, positionAt } from "../timeline.ts";

/** `fx-off`: Beat FX off at most this long after the echoes die out. */
export const FX_OFF_BARS = 2;

export const echoOut: LessonCheck<TaskOf<"echo-out">> = {
  situations: { transition: true },
  criteria: ["echo-out.echo-cut", "echo-out.echo-entry", "echo-out.fx-off"],
  run(context) {
    const { attempt, window } = context;
    const deckA = loadedDeck(context, "A");
    const deckB = loadedDeck(context, "B");
    const outA = exitTime(attempt, "A", window);
    const cutA = exitActionTime(attempt, "A", window);
    const beat = deckA === null || cutA === null ? null : beatSeconds(deckA.playhead, deckA.grid, cutA);
    const bar = deckA === null || cutA === null ? null : barSeconds(deckA, cutA);

    // `echo-cut`: ECHO takes in A as A goes silent, and the cut starts on a downbeat.
    const cutOff = deckA === null || cutA === null ? null : downbeatOffsetAt(deckA, cutA);
    const echoOff = outA === null ? 1 : echoingAt(attempt, "A", outA - TIME_EPSILON) ? 0 : 1;

    // `echo-entry`: B's Play against A's next phrase start had A kept playing past the cut.
    const heardB = entryTime(attempt, "B", window);
    const runB = deckB === null || heardB === null ? null : playRunStartAt(deckB.playhead, heardB);
    const playB = runB === null ? null : playPressTime(attempt, "B", runB);
    const posAtCut = deckA === null || cutA === null ? null : positionAt(deckA.playhead, cutA);
    const nextMarker = deckA === null || posAtCut === null ? undefined : deckA.phraseMarkers.find((marker) => marker >= posAtCut - TIME_EPSILON);
    const phraseAt = deckA === null || cutA === null || posAtCut === null || nextMarker === undefined ? null : cutA + (nextMarker - posAtCut) / playingRateAt(deckA, cutA);
    const entryBeats = playB === null || phraseAt === null || beat === null ? null : Math.abs(playB - phraseAt) / beat;

    // `fx-off`: the OFF press after the cut, against where the tail dies out (FX return under −50 LUFS).
    const tailEnd = outA === null ? null : fxTailEnd(attempt, outA, window);
    const off = cutA === null ? undefined : attempt.events.find((event) => event.control === "beatFx" && event.value === 0 && event.ctx > cutA && event.ctx < window.to);
    const offBars = off === undefined || tailEnd === null || bar === null ? null : (off.ctx - tailEnd) / bar;

    return {
      criteria: [
        judgeAll(
          {
            id: "echo-out.echo-cut",
            severity: "fail",
            unit: "beats",
            threshold: { op: "<=", value: 1, unit: "beats" },
            measured: cutOff === null ? null : Math.abs(cutOff),
            detail: { echoOn: 1 - echoOff },
            evidence: cutA === null ? [] : [{ from: cutA, to: cutA, label: "A cut" }],
          },
          { id: "echo-out.echo-cut", severity: "fail", unit: "count", threshold: { op: "<=", value: 0, unit: "count" }, measured: echoOff, scale: 1 },
        ),
        judge({
          id: "echo-out.echo-entry",
          severity: "fail",
          unit: "beats",
          threshold: { op: "<=", value: 1, unit: "beats" },
          measured: entryBeats,
          evidence: playB === null ? [] : [{ from: playB, to: playB, label: "B plays" }],
        }),
        judge({
          id: "echo-out.fx-off",
          severity: "fail",
          unit: "bars",
          threshold: { op: "<=", value: FX_OFF_BARS, unit: "bars" },
          measured: offBars,
          evidence: tailEnd === null || outA === null ? [] : [{ from: outA, to: tailEnd, label: "echo tail" }],
        }),
      ],
      metrics: tailEnd === null || outA === null || bar === null ? {} : { echoTailBars: (tailEnd - outA) / bar },
    };
  },
};
