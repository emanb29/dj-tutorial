// Lesson 1, `deck-basics`: fade a track in from silence and back out (check-design §4).
import { barSeconds, framesWhere, loadedDeck, maxOf, type LessonCheck } from "../context.ts";
import { judge } from "../criterion.ts";
import { channelFaderAt, entryTime } from "../mix.ts";
import { firstPlayStart } from "../timeline.ts";

/** Clipping: a sample peak over −0.1 dBFS. */
export const CLIP_DBFS = -0.1;

export const deckBasics: LessonCheck = {
  situations: { transition: false },
  criteria: ["deck-basics.fade-in", "deck-basics.fade-out", "deck-basics.no-clip-local"],
  run(context) {
    const { attempt, window } = context;
    const deckA = loadedDeck(context, "A");
    const playAt = deckA === null ? null : firstPlayStart(deckA.playhead, window.from);
    const inAt = entryTime(attempt, "A", window);
    const fadeInBars =
      deckA !== null && playAt !== null && inAt !== null ? Math.max(0, inAt - playAt) / barSeconds(deckA, playAt) : null;
    const masterPeak = maxOf(attempt.meters.master, window, (frame) => frame.samplePeakDb);

    return {
      criteria: [
        judge({
          id: "deck-basics.fade-in",
          severity: "fail",
          unit: "bars",
          threshold: { op: "<=", value: 4, unit: "bars" },
          measured: fadeInBars,
          evidence: playAt !== null && inAt !== null ? [{ from: playAt, to: inAt, label: "Play to audible" }] : [],
        }),
        judge({
          id: "deck-basics.fade-out",
          severity: "fail",
          unit: "position",
          threshold: { op: "<=", value: 0, unit: "position" },
          measured: channelFaderAt(attempt, "A", window.to),
        }),
        judge({
          id: "deck-basics.no-clip-local",
          severity: "fail",
          unit: "dBFS",
          threshold: { op: "<=", value: CLIP_DBFS, unit: "dBFS" },
          measured: masterPeak,
          evidence: framesWhere(attempt.meters.master, window, (frame) => frame.samplePeakDb > CLIP_DBFS, "clip"),
        }),
      ],
      metrics: {},
    };
  },
};
