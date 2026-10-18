import { describe, expect, it } from "vitest";
import { LESSON_IDS, type Attempt, type LessonId } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "./run-check.ts";
import { noClipJudgedFrom, standingSeverity } from "./standing.ts";
import {
  BAR,
  BEAT,
  CUT_WINDOW,
  MUSIC,
  SILENT,
  applied,
  attempt,
  cutScenario,
  event,
  frames,
  passedBefore,
  playing,
  spec,
  taps,
  type CutScenario,
} from "./testing/synthetic.ts";

/** A cold re-pass of `cut-on-phrase` by a Learner who has passed everything before `upTo`. */
function coldCut(scenario: CutScenario = {}, upTo: LessonId = "tempo-fader"): CheckResult {
  return graded(
    runCheck(
      spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode: "cold", passedLessons: passedBefore(LESSON_IDS, upTo) }),
      cutScenario(scenario),
    ),
  );
}

function graded(result: ReturnType<typeof runCheck>): CheckResult {
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);
const standingIds = (result: CheckResult) =>
  result.criteria.filter((criterion) => criterion.id.startsWith("standing.")).map((criterion) => criterion.id);

describe("standing criteria timed from a Play press", () => {
  it("on-phrase and cued-first read B's Play at the press, B's position where it starts, whatever the output latency", () => {
    const scenario = cutScenario({ playB: 32.25, closeA: [event(32, "channelFader", 0, "A")], extraEvents: [event(20, "channelFader", 1, "B")] });
    const recorded = { ...scenario, events: [...scenario.events, applied(32, "play", 1, "B", 0.25)].sort((a, b) => a.ctx - b.ctx) };
    const result = graded(
      runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode: "cold", passedLessons: passedBefore(LESSON_IDS, "tempo-fader") }), recorded),
    );

    expect(byId(result, "standing.on-phrase")).toMatchObject({ status: "met" });
    expect(byId(result, "standing.on-phrase")?.measured).toBeCloseTo(0);
    expect(byId(result, "standing.cued-first")?.measured).toBeCloseTo(30);
  });

  it("on-phrase reads a stopped outgoing deck where it would be had it kept playing (an echo out, then A paused)", () => {
    // A cut on bar 15's 1 (28 s), paused a beat later as its echoes ring on; B plays on the phrase start, 32 s.
    const scenario = cutScenario({ playB: 32, closeA: [event(28, "channelFader", 0, "A")] });
    const pausedA = { ...scenario, decks: { ...scenario.decks, A: { trackId: "track-a", playhead: { segments: playing(0, 0, 28.5) } } } };
    const result = graded(
      runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode: "cold", passedLessons: passedBefore(LESSON_IDS, "tempo-fader") }), pausedA),
    );

    expect(byId(result, "standing.on-phrase")).toMatchObject({ status: "met" });
    expect(byId(result, "standing.on-phrase")?.measured).toBeCloseTo(0);
  });
});

describe("standing criteria: which apply", () => {
  it("adds none before their teaching Lesson is passed", () => {
    expect(standingIds(coldCut({}, "gain-staging"))).toEqual([]);
  });

  it("adds no-clip once gain-staging is passed, and the cut-on-phrase ones once it is passed", () => {
    expect(standingIds(coldCut({}, "headphone-cue"))).toEqual(["standing.no-clip"]);
    expect(standingIds(coldCut())).toEqual([
      "standing.no-clip",
      "standing.no-dead-air",
      "standing.on-phrase",
      "standing.level-match",
      "standing.cued-first",
    ]);
  });

  it("applies only to situations the task contains: a tap Check gets no-clip but no transition criteria", () => {
    const tapCheck = graded(
      runCheck(
        spec(
          { lessonId: "beats-and-bars", beatSection: { from: 4, to: 4 + 4 * BAR }, downbeatSection: { from: 12, to: 20 } },
          { from: 0, to: 22 },
          { mode: "warmup", variant: "short", passedLessons: passedBefore(LESSON_IDS, "sync-blend") },
        ),
        attempt({
          decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
          events: taps([...Array.from({ length: 16 }, (_, index) => 4 + index * BEAT), 12, 14, 16, 18]),
          meters: { master: frames(0, 22, () => MUSIC), A: frames(0, 22, () => MUSIC) },
        }),
      ),
    );

    expect(standingIds(tapCheck)).toEqual(["standing.no-clip"]);
    expect(tapCheck.outcome.kind).toBe("passed");
  });

  it("adds trim-still once sync-blend is passed, and no-recue once nudge-phase is", () => {
    expect(standingIds(coldCut({}, "crossfader"))).toContain("standing.trim-still");
    expect(standingIds(coldCut({}, "tempo-by-ear"))).toEqual(expect.arrayContaining(["standing.no-boost", "standing.no-recue"]));
  });
});

describe("standing.no-clip (fail)", () => {
  it("fails on a master frame over −0.1 dBFS", () => {
    const result = coldCut({ masterOverride: (t) => (t > 40 && t < 40.05 ? { peak: 0.2, momentary: -14 } : null) });

    expect(byId(result, "standing.no-clip")).toMatchObject({ status: "notMet", severity: "fail" });
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["standing.no-clip"] });
  });

  it("fails on an audible channel clipping", () => {
    expect(byId(coldCut({ bPeak: 0 }), "standing.no-clip")?.status).toBe("notMet");
  });

  it("ignores a clipping channel that is not audible (cued in headphones, fader down)", () => {
    const base = cutScenario();
    const cuedClip: Attempt = {
      ...base,
      decks: { ...base.decks, B: { trackId: "track-b", playhead: { segments: playing(20, 0) } } },
      meters: { ...base.meters, B: frames(0, 48, (t) => (t >= 20 ? (t < 32 ? { peak: 1, momentary: -14 } : MUSIC) : SILENT)) },
    };
    const result = graded(
      runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode: "cold", passedLessons: ["gain-staging"] }), cuedClip),
    );

    expect(byId(result, "standing.no-clip")?.status).toBe("met");
  });
});

describe("standing.no-clip judges only what the Learner is responsible for", () => {
  // cutScenario: A plays from 0 s at 120 BPM (a bar is 2 s); the Learner's first level move is B's fader at 32 s.
  const masterClipAt = (from: number, to: number) => (t: number) => (t >= from && t < to ? { peak: 0.5, momentary: -12 } : null);

  it("forgives a clip in the set-up's first bar, before the Learner has moved anything", () => {
    expect(byId(coldCut({ masterOverride: masterClipAt(0, 1.9) }), "standing.no-clip")).toMatchObject({ status: "met" });
  });

  it("is strict a bar after the audio starts, though the Learner has not moved anything yet", () => {
    expect(byId(coldCut({ masterOverride: masterClipAt(0, 2.1) }), "standing.no-clip")).toMatchObject({ status: "notMet", severity: "fail" });
    expect(byId(coldCut({ masterOverride: masterClipAt(10, 10.1) }), "standing.no-clip")).toMatchObject({ status: "notMet" });
  });

  it("is strict from the Learner's first move, inside the first bar too", () => {
    const moved = coldCut({ masterOverride: masterClipAt(0.5, 0.6), extraEvents: [event(0.4, "trim", 0.2, "A")] });
    expect(byId(moved, "standing.no-clip")).toMatchObject({ status: "notMet" });
    expect(byId(moved, "standing.no-clip")?.evidence).toEqual([expect.objectContaining({ label: "master clip" })]);
  });

  it("times the grace from when the audio starts, not from the window's start", () => {
    const base = cutScenario({ masterOverride: masterClipAt(5, 6.9) });
    const lateStart: Attempt = { ...base, decks: { ...base.decks, A: { trackId: "track-a", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 0 }, ...playing(5)] } } } };
    const result = graded(runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode: "cold", passedLessons: passedBefore(LESSON_IDS, "tempo-fader") }), lateStart));
    expect(byId(result, "standing.no-clip")).toMatchObject({ status: "met" });
  });

  it("starts a channel's judging at a move on that channel, the master's at a move on any", () => {
    const context = (events: Attempt["events"]) => ({
      spec: spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW),
      attempt: cutScenario({ extraEvents: events }),
      window: CUT_WINDOW,
      lessonId: "cut-on-phrase" as const,
    });
    const trimB = context([event(0.5, "trim", -0.2, "B")]);
    expect(noClipJudgedFrom(trimB, "B")).toBeCloseTo(0.5);
    expect(noClipJudgedFrom(trimB)).toBeCloseTo(0.5);
    expect(noClipJudgedFrom(trimB, "A")).toBeCloseTo(BAR);
    // CUE and taps change no level.
    expect(noClipJudgedFrom(context([event(0.5, "cueMonitor", 1, "A"), event(0.6, "tap", 1)]), "A")).toBeCloseTo(BAR);
    expect(noClipJudgedFrom(context([event(0.7, "crossfader", 0.6)]))).toBeCloseTo(0.7);
  });

  it("in gain-staging, judges a meter only once the Learner has brought it out of the deliberate red", () => {
    const hotUntil = 6;
    const gainAttempt = attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } }, B: { trackId: "track-a", playhead: { segments: playing(0) } } },
      events: [event(4, "trim", 0.8, "A"), event(5, "trim", 0.6, "A")],
      meters: {
        master: frames(0, 20, (t) => (t < hotUntil ? { peak: 1, momentary: -10 } : MUSIC)),
        A: frames(0, 20, (t) => (t < hotUntil ? { peak: 3, momentary: -8 } : MUSIC)),
        B: frames(0, 20, () => ({ peak: -15, momentary: -26 })),
      },
    });
    const context = { spec: spec({ lessonId: "gain-staging", decks: ["A", "B"] }, { from: 0, to: 20 }), attempt: gainAttempt, window: { from: 0, to: 20 }, lessonId: "gain-staging" as const };
    // Hot for 6 s, turned down from 4 s: judged from the first frame out of the red, not a bar in.
    expect(noClipJudgedFrom(context, "A")).toBeCloseTo(hotUntil);
    expect(noClipJudgedFrom(context)).toBeCloseTo(hotUntil);
    // B's trim never moved: its set-up level is not judged.
    expect(noClipJudgedFrom(context, "B")).toBeNull();
  });
});

describe("standing.no-dead-air (fail)", () => {
  const gap = (seconds: number) => (t: number) => (t >= 32 && t < 32 + seconds ? SILENT : null);

  it("fails when the master is under −45 LUFS for 1 s or more after the music starts", () => {
    expect(byId(coldCut({ masterOverride: gap(1) }), "standing.no-dead-air")).toMatchObject({ status: "notMet" });
    expect(byId(coldCut({ masterOverride: gap(0.98) }), "standing.no-dead-air")).toMatchObject({ status: "met" });
  });

  it("fails a master that never plays, and a meter stream that stops early", () => {
    expect(byId(coldCut({ masterOverride: () => SILENT }), "standing.no-dead-air")).toMatchObject({ status: "notMet", measured: null });

    const base = cutScenario();
    const cutShort = { ...base, meters: { ...base.meters, master: base.meters.master.filter((frame) => frame.ctx < 40) } };
    const result = graded(
      runCheck(spec({ lessonId: "cut-on-phrase" }, CUT_WINDOW, { mode: "cold", passedLessons: ["cut-on-phrase"] }), cutShort),
    );
    expect(byId(result, "standing.no-dead-air")?.status).toBe("notMet");
  });

  it("does not count silence before the first audio", () => {
    const lateStart = coldCut({ masterOverride: (t) => (t < 3 ? SILENT : null) });

    expect(byId(lateStart, "standing.no-dead-air")?.status).toBe("met");
  });
});

describe("standing.on-phrase (fail)", () => {
  it("fails a cut where B comes in off A's phrase", () => {
    const offPhrase = coldCut({ playB: 32 + 2 * BAR });

    expect(byId(offPhrase, "standing.on-phrase")).toMatchObject({ status: "notMet", severity: "fail" });
  });

  it("fails when B itself starts off its own phrase marker, even on A's phrase start", () => {
    expect(byId(coldCut({ bStartPos: 2 * BEAT }), "standing.on-phrase")?.status).toBe("notMet");
    expect(byId(coldCut({ bStartPos: BEAT }), "standing.on-phrase")?.status).toBe("met");
  });
});

describe("standing warnings never block the pass", () => {
  it("warns on level-match more than 2 dB apart before final-mix", () => {
    const result = coldCut({ bShortTermOffsetDb: 3 });

    expect(byId(result, "standing.level-match")).toMatchObject({ status: "notMet", severity: "warn" });
    expect(result.outcome.kind).toBe("passed");
    expect(byId(coldCut({ bShortTermOffsetDb: 2 }), "standing.level-match")?.status).toBe("met");
  });

  it("warns on cued-first when B was cued under 2 s", () => {
    const result = coldCut({ cueOnAt: 31 });

    expect(byId(result, "standing.cued-first")).toMatchObject({ status: "notMet", severity: "warn" });
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["cut-on-phrase.cued-before"] });
  });

  it("warns on trim-still when trim moves while both decks are audible", () => {
    const overlapCut = { closeA: [event(34, "channelFader", 0, "A")] };
    const result = coldCut({ ...overlapCut, extraEvents: [event(33, "trim", -2, "B")] }, "crossfader");

    expect(byId(result, "standing.trim-still")).toMatchObject({ status: "notMet", severity: "warn", measured: 1 });
    expect(byId(coldCut({ ...overlapCut, extraEvents: [event(20, "trim", -2, "B")] }, "crossfader"), "standing.trim-still")?.status).toBe(
      "met",
    );
  });

  it("warns on no-recue for 2 CUE presses on the incoming deck during the overlap", () => {
    const presses = [event(32.5, "deckCue", 1, "B"), event(32.6, "deckCue", 0, "B"), event(33, "deckCue", 1, "B")];
    const result = coldCut({ closeA: [event(34, "channelFader", 0, "A")], extraEvents: presses }, "tempo-by-ear");

    expect(byId(result, "standing.no-recue")).toMatchObject({ status: "notMet", measured: 2 });
  });

  it("warns on no-boost for an EQ band over +3 dB for more than a bar", () => {
    const boost = (seconds: number) => [event(10, "eqLow", 4, "A"), event(10 + seconds, "eqLow", 0, "A")];

    expect(byId(coldCut({ extraEvents: boost(BAR + 0.1) }, "bass-swap"), "standing.no-boost")?.status).toBe("notMet");
    expect(byId(coldCut({ extraEvents: boost(BAR) }, "bass-swap"), "standing.no-boost")?.status).toBe("met");
  });
});

describe("standing severities by stage", () => {
  it("makes level-match a fail in final-mix and a warning before it", () => {
    expect(standingSeverity("level-match", "cut-on-phrase")).toBe("warn");
    expect(standingSeverity("level-match", "final-mix")).toBe("fail");
    expect(standingSeverity("no-clip", "cut-on-phrase")).toBe("fail");
    expect(standingSeverity("cued-first", "final-mix")).toBe("warn");
  });
});
