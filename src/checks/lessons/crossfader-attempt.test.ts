// A faithful synthetic copy of a real crossfader Check taken on a DDJ-FLX4 (the stored profile keeps
// only each criterion's last measured value, not the events, so the attempt is rebuilt from the
// Lesson's plan and those values). Its result screen read: blend ✓, level jump at the cut 2.5 dB ✗,
// faders up ✓, levels matched 1.86 dB ✓, cueing in headphones first 0 s ✗, trim 9 ✗.
import { describe, expect, it } from "vitest";
import { crossfaderGainDb, type ControlEvent, type DeckId } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { LESSON_IDS } from "@shared/attempt.ts";
import { describeCriterion } from "../../lessons/coach.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, FRAME, LESSON_AIDS, PHRASE, attempt, channel, deckState, event, frames, passedBefore, playing, ramp, spec } from "../testing/synthetic.ts";

/** Phrase 1 is counted from 0 s; the blend starts on Phrase 2 (16 s), the cut back to A on Phrase 4. */
const BLEND_AT = PHRASE;
const CUT_AT = BLEND_AT + 16 * BAR;
const SPLIT_AT = BLEND_AT + 14 * BAR;
const END = CUT_AT + 4 * BAR + BEAT;
const A_LUFS = -14;
/** B as its trim was set: 1.86 dB louder than A (what "Matching the levels" measured). */
const B_LUFS = A_LUFS + 1.86;
/** B's third phrase (from 32 s) is a little louder than its second. */
const B_LATER_DB = 1.61;

/** Two turns of TRIM B, toward A's level, while both decks are heard: 9 MIDI messages in all. */
const TRIM_TURNS: readonly ControlEvent[] = [
  ...[-0.1, -0.2, -0.3, -0.4, -0.5].map((db, index) => event(22 + index * 0.06, "trim", db, "B")),
  ...[-0.6, -0.7, -0.8, -1].map((db, index) => event(27 + index * 0.06, "trim", db, "B")),
];

interface Options {
  readonly trims?: readonly ControlEvent[];
  /** CUE B on from here (the recording: never; the Lesson's set-up now has it on from the start). */
  readonly cueBAt?: number | null;
  /** CUE A on from here (the recording: bar 11 of the blend, as the caption asks). */
  readonly cueAAt?: number | null;
}

function valueAt(events: readonly ControlEvent[], control: ControlEvent["control"], deck: DeckId | undefined, t: number, initial: number): number {
  return events.filter((each) => each.control === control && each.deck === deck && each.ctx <= t).at(-1)?.value ?? initial;
}

function maintainerAttempt({ trims = TRIM_TURNS, cueBAt = null, cueAAt = BLEND_AT + 11 * BAR }: Options = {}) {
  const crossfader = [
    ...ramp("crossfader", undefined, { from: BLEND_AT, to: BLEND_AT + 10 * BAR }, 0, 1),
    event(CUT_AT, "crossfader", 0.6),
    event(CUT_AT + 0.04, "crossfader", 0.2),
    event(CUT_AT + 0.08, "crossfader", 0),
  ];
  const events = [
    ...crossfader,
    ...trims,
    ...(cueBAt === null ? [] : [event(cueBAt, "cueMonitor", 1, "B")]),
    ...(cueAAt === null ? [] : [event(cueAAt, "cueMonitor", 1, "A")]),
  ].sort((first, second) => first.ctx - second.ctx);
  const channelLufs = (deck: DeckId, t: number) =>
    deck === "A" ? A_LUFS + valueAt(events, "trim", "A", t, 0) : B_LUFS + valueAt(events, "trim", "B", t, 0) + (t >= 2 * PHRASE ? B_LATER_DB : 0);
  const masterLufs = (t: number) => {
    const position = valueAt(events, "crossfader", undefined, t, 0);
    const power = (["A", "B"] as const).reduce((sum, deck) => sum + 10 ** ((channelLufs(deck, t) + crossfaderGainDb(deck, position)) / 10), 0);
    return 10 * Math.log10(power);
  };
  return attempt({
    inputDevice: "midi",
    decks: {
      A: { trackId: "track-a", playhead: { segments: playing(0) } },
      // B plays from the Check's start, synced, phrase on phrase with A: silent behind the crossfader.
      B: { trackId: "track-b", playhead: { segments: playing(0) } },
    },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel({ channelFader: 1 }), crossfader: 0 },
    initialDecks: { A: deckState(), B: deckState({ sync: true }) },
    events,
    meters: {
      master: frames(0, END + FRAME, (t) => ({ peak: -2.1, momentary: masterLufs(t) })),
      A: frames(0, END + FRAME, (t) => ({ peak: -3, momentary: channelLufs("A", t) })),
      B: frames(0, END + FRAME, (t) => ({ peak: -3, momentary: channelLufs("B", t) })),
    },
  });
}

function check(options: Options = {}): CheckResult {
  const result = runCheck(
    spec(
      { lessonId: "crossfader", blendSection: { from: 0, to: SPLIT_AT }, cutSection: { span: { from: SPLIT_AT, to: END }, incoming: "A" } },
      { from: 0, to: END },
      { aids: { ...LESSON_AIDS, sync: true }, passedLessons: passedBefore(LESSON_IDS, "crossfader") },
    ),
    maintainerAttempt(options),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => {
  const found = result.criteria.find((criterion) => criterion.id === id);
  if (found === undefined) throw new Error(`${id} was not graded`);
  return found;
};

describe("the maintainer's crossfader attempt", () => {
  it("passes, as recorded: blend and cut clean, TRIM used to keep the level; two warnings left, both true", () => {
    const result = check();
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.filter((criterion) => criterion.status === "notMet").map((criterion) => [criterion.id, criterion.severity])).toEqual([
      ["standing.level-match", "warn"],
      ["standing.cued-first", "warn"],
    ]);
  });

  it("does not fail the cut for 2.5 dB between the tracks: the cut's level is graded at 3 dB, as the blend's is", () => {
    const cut = byId(check(), "crossfader.xf-cut");
    expect(cut.status).toBe("met");
    expect(describeCriterion(cut)).toBe("Crossfader cut to A: on the phrase, cued, level even");
  });

  it("matches the levels on each transition: 1.86 dB at the blend, 2.47 dB at the cut (a warning)", () => {
    const levels = byId(check(), "standing.level-match");
    expect(levels).toMatchObject({ status: "notMet", severity: "warn", detail: { transitions: 2, transition: 2 } });
    expect(levels.measured).toBeCloseTo(2.47, 2);
    expect(describeCriterion(levels)).toBe("Transition 2: Levels 2.5 dB apart at the handover (need 2 or less)");
  });

  it("reads the cut's CUE from deck A, the deck coming in, not from B", () => {
    // CUE B on before the blend: the blend's transition is cued; CUE A, on since bar 11, cues the cut.
    expect(byId(check({ cueBAt: 10 }), "standing.cued-first").status).toBe("met");
    // CUE A never on: the cut is the transition that fails, though CUE B was on.
    const uncuedCut = byId(check({ cueBAt: 10, cueAAt: null }), "standing.cued-first");
    expect(uncuedCut).toMatchObject({ status: "notMet", measured: 0, detail: { transition: 2 } });
    expect(describeCriterion(uncuedCut)).toBe("Transition 2: CUE 🎧 on 0.0 s before it came in (need 2)");
  });

  it("says which transition was not cued: as recorded, CUE B was off until the blend", () => {
    const recorded = byId(check(), "standing.cued-first");
    expect(recorded).toMatchObject({ status: "notMet", measured: 0, detail: { transition: 1 } });
    expect(describeCriterion(recorded)).toBe("Transition 1: CUE 🎧 on 0.0 s before it came in (need 2)");
  });

  it("allows two small TRIM turns toward the other deck's level, and counts turns, not MIDI messages", () => {
    const trim = byId(check(), "standing.trim-still");
    expect(trim).toMatchObject({ status: "met", detail: { gestures: 2, wrongWay: 0 } });
    expect(describeCriterion(trim)).toBe("TRIM: level kept steady (moved 2×)");
  });

  it("still warns when TRIM is used as a fader: more than 6 dB from where it was", () => {
    const turn = (values: readonly number[]) => values.map((db, index) => event(24 + index * 0.1, "trim", db, "B"));
    const trim = byId(check({ trims: turn([-2, -4, -6, -8]) }), "standing.trim-still");
    expect(trim).toMatchObject({ status: "notMet", measured: 8 });
    expect(describeCriterion(trim)).toBe("Transition 1: TRIM: swung 8.0 dB mid-transition (keep it within 6: let the faders fade)");
    expect(byId(check({ trims: turn([-1, -2]) }), "standing.trim-still").status).toBe("met");
  });

  it("still warns on a TRIM turn that takes the levels further apart", () => {
    const louder = [0.5, 1, 1.5].map((db, index) => event(24 + index * 0.1, "trim", db, "B"));
    const trim = byId(check({ trims: louder }), "standing.trim-still");
    expect(trim).toMatchObject({ status: "notMet", detail: { wrongWay: 1 } });
    expect(describeCriterion(trim)).toBe("Transition 1: TRIM: 1 turn took the levels further apart (turn toward the other deck's level)");
  });

  it("does not count TRIM turns before the overlap: setting B's level while it is cued is the point", () => {
    const beforeBlend = [-1, -2, -3, -4, -5, -6, -7].map((db, index) => event(8 + index * 0.1, "trim", db, "B"));
    expect(byId(check({ trims: beforeBlend }), "standing.trim-still")).toMatchObject({ status: "met", detail: { gestures: 0 } });
  });
});

