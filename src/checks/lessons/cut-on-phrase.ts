// Lesson 7, `cut-on-phrase`: start B on A's phrase start and cut the faders (check-design §4).
import type { CriterionResult } from "@shared/check-result.ts";
import { loadedDeck, type LessonCheck, type TaskOf } from "../context.ts";
import { judge } from "../criterion.ts";
import { playPressTime } from "../deck-controls.ts";
import { cueOnSeconds, entryActionTime, entryTime, exitActionTime } from "../mix.ts";
import { loudJump, phraseOffsetSeconds } from "../phrasing.ts";
import { beatSeconds, firstPlayStart, playRunStartAt } from "../timeline.ts";
import { pointActionToleranceMs } from "../tolerance.ts";
import { cueOnDownbeat } from "./cue-point.ts";

/** CUE on the incoming deck for this long before it comes in (`cued-before`, `cued-first`). */
export const CUED_BEFORE_S = 2;
/**
 * `loud-jump` (and `crossfader.xf-cut`'s level part), dB, after the mixer's own part is taken off
 * (`loudJump`). It is the master's bar loudness over 4 bars of one track against 4 bars of another,
 * so it holds the music's own change from one phrase to the next as well as the trims' mismatch: the
 * same 3 dB as `loud-steady` allows the master through a blend (a cut is a blend with no overlap). A
 * real mismatch still fails: Placement's B, 6 dB low, or trims 4 dB apart. The trims themselves are
 * graded more finely by `standing.level-match` (2 dB, on the channel meters, where TRIM acts).
 */
export const LOUD_JUMP_DB = 3;

export const cutOnPhrase: LessonCheck<TaskOf<"cut-on-phrase">> = {
  situations: { transition: true },
  criteria: ["cut-on-phrase.cut-start", "cut-on-phrase.cut-tight", "cut-on-phrase.cued-before", "cut-on-phrase.loud-jump"],
  placementCriteria: ["cue-point.cue-on-downbeat"],
  run(context) {
    const { attempt, window, spec } = context;
    const deckA = loadedDeck(context, "A");
    const deckB = loadedDeck(context, "B");
    const inB = entryActionTime(attempt, "B", window);
    const heardB = entryTime(attempt, "B", window);
    // The run that brought B in (not an earlier CUE-hold preview in the headphones), where its audio starts.
    const runB =
      deckB === null ? null : heardB !== null ? playRunStartAt(deckB.playhead, heardB) : firstPlayStart(deckB.playhead, window.from);
    // `t_play(B)`: a point action, timed from the Play press (input leeway), on the same clock as A's beats.
    const playB = runB === null ? null : playPressTime(attempt, "B", runB);
    const outA = exitActionTime(attempt, "A", window);

    const startOffset = deckA === null || playB === null ? null : phraseOffsetSeconds(deckA, playB);
    const tightBeats =
      deckA === null || playB === null || outA === null ? null : Math.abs(outA - playB) / beatSeconds(deckA.playhead, deckA.grid, playB);
    const cuedSeconds = inB === null ? null : cueOnSeconds(attempt, "B", { from: window.from, to: inB });
    // Loudness is about the sound, so it is measured around where B's audio starts.
    const jump = deckA === null || runB === null ? null : loudJump(context, deckA, runB);

    const criteria: CriterionResult[] = [
      judge({
        id: "cut-on-phrase.cut-start",
        severity: "fail",
        unit: "ms",
        threshold: { op: "<=", value: pointActionToleranceMs("cut-on-phrase", context.lessonId), unit: "ms" },
        measured: startOffset === null ? null : Math.abs(startOffset) * 1000,
        ...(startOffset === null ? {} : { detail: { signedMs: startOffset * 1000 } }),
        evidence: playB === null ? [] : [{ from: playB, to: playB, label: "B plays" }],
      }),
      judge({
        id: "cut-on-phrase.cut-tight",
        severity: "fail",
        unit: "beats",
        threshold: { op: "<=", value: 1, unit: "beats" },
        measured: tightBeats,
        evidence: outA === null ? [] : [{ from: outA, to: outA, label: "A out" }],
      }),
      judge({
        id: "cut-on-phrase.cued-before",
        severity: "fail",
        unit: "s",
        threshold: { op: ">=", value: CUED_BEFORE_S, unit: "s" },
        measured: cuedSeconds,
      }),
      judge({
        id: "cut-on-phrase.loud-jump",
        severity: "fail",
        unit: "dB",
        threshold: { op: "<=", value: LOUD_JUMP_DB, unit: "dB" },
        measured: jump,
      }),
    ];
    const deckBTrack = spec.tracks.find((track) => track.deck === "B");
    if (spec.mode === "placement" && deckBTrack !== undefined) criteria.push(cueOnDownbeat(context, [deckBTrack.trackId]));
    return { criteria, metrics: {} };
  },
};
