import { describe, expect, it } from "vitest";
import type { ControlEvent, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { attempt, BAR, channel, event, frames, MUSIC, playing, SILENT, spec } from "../testing/synthetic.ts";

// 120 BPM: a bar is 2 s, a phrase 16 s. A plays from 0; LOOP IN on its phrase start at 48 s, LOOP OUT
// 4 bars later (56 s): A loops 48–56 s of track. B (fader up, cued) plays on the loop's 1 at 64 s;
// EXIT on the loop's 1 at 72 s; A's fader closes at 76 s.
const WINDOW = { from: 0, to: 90 };

interface Scenario {
  readonly loopEvents?: readonly ControlEvent[];
  readonly aSegments?: readonly PlayheadSegment[];
  readonly playB?: number;
  readonly bStartPos?: number;
  readonly exitAt?: number | null;
  readonly extraEvents?: readonly ControlEvent[];
}

const LOOP_IN: ControlEvent = { ctx: 48, control: "loopIn", deck: "A", value: 1, pos: 48 };
const LOOP: readonly ControlEvent[] = [
  LOOP_IN,
  { ctx: 56, control: "loopOut", deck: "A", value: 4 * BAR, pos: 48 },
];
const LOOPED: readonly PlayheadSegment[] = [
  { fromCtx: 0, pos: 0, rate: 1 },
  { fromCtx: 56, pos: 48, rate: 1 },
  { fromCtx: 64, pos: 48, rate: 1 },
  { fromCtx: 72, pos: 48, rate: 1 },
];

function scenario({ loopEvents = LOOP, aSegments = LOOPED, playB = 64, bStartPos = 0, exitAt = 72, extraEvents = [] }: Scenario = {}) {
  const events = [
    event(30, "cueMonitor", 1, "B"),
    event(40, "channelFader", 1, "B"),
    ...loopEvents,
    { ctx: playB, control: "play", deck: "B", value: 1, appliedCtx: playB } as ControlEvent,
    ...(exitAt === null ? [] : [{ ctx: exitAt, control: "loopExit", deck: "A", value: 1 } as ControlEvent]),
    event(76, "channelFader", 0, "A"),
    ...extraEvents,
  ].sort((a, b) => a.ctx - b.ctx);
  return attempt({
    decks: {
      A: { trackId: "track-a", playhead: { segments: aSegments } },
      B: { trackId: "track-b", playhead: { segments: playing(playB, bStartPos) } },
    },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    events,
    meters: {
      master: frames(0, 90, () => MUSIC),
      A: frames(0, 90, () => MUSIC),
      B: frames(0, 90, (t) => (t >= playB ? MUSIC : SILENT)),
    },
  });
}

function check(recorded = scenario(), passedLessons: readonly ("cut-on-phrase" | "sync-blend")[] = []): CheckResult {
  const result = runCheck(spec({ lessonId: "loop-transition" }, WINDOW, { passedLessons }), recorded);
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("loop-transition", () => {
  it("passes a 4-bar loop from A's phrase start, B in on the loop's 1, EXIT on a 1", () => {
    const result = check();
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "loop-transition.loop-length",
      "loop-transition.loop-in",
      "loop-transition.loop-exit",
      "loop-transition.loop-entry",
      "loop-transition.no-double",
    ]);
    expect(byId(result, "loop-transition.loop-length")).toMatchObject({ measured: 0, detail: { loopBeats: 16 } });
  });

  it("passes the standing phrase rules too: B comes in on A's phrase start, where the loop begins", () => {
    const result = check(scenario(), ["cut-on-phrase", "sync-blend"]);
    expect(byId(result, "standing.on-phrase")).toMatchObject({ status: "met" });
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("measures B's entry a hair before the loop wraps from the loop's start, not its end bars later", () => {
    // B's Play heard 20 ms before the wrap at 64 s: A is at the loop's end (track 55.98 s), which is the loop's 1.
    const result = check(scenario({ playB: 63.98 }), ["cut-on-phrase", "sync-blend"]);
    expect(byId(result, "standing.on-phrase")).toMatchObject({ status: "met" });
    expect(byId(result, "standing.on-phrase")?.measured).toBeCloseTo(0.04, 6);
    expect(byId(result, "loop-transition.loop-entry")).toMatchObject({ status: "met" });
  });

  it("grades a loop closed by hand with the out press's leeway (±120 ms), and an auto loop to 20 ms", () => {
    const byHand = (length: number) => scenario({ loopEvents: [LOOP_IN, { ctx: 56, control: "loopOut", deck: "A", value: length, pos: 48 }] });
    expect(byId(check(byHand(8.12)), "loop-transition.loop-length")?.status).toBe("met");
    expect(byId(check(byHand(8.121)), "loop-transition.loop-length")?.status).toBe("notMet");
    // 4 BEAT, then 2X twice: exact, so held to 20 ms.
    const auto = (finalLength: number) =>
      scenario({
        loopEvents: [
          { ctx: 48, control: "loopAuto", deck: "A", value: 2, pos: 48 },
          { ctx: 48.5, control: "loopDouble", deck: "A", value: 4, pos: 48 },
          { ctx: 49, control: "loopDouble", deck: "A", value: finalLength, pos: 48 },
        ],
      });
    expect(byId(check(auto(8)), "loop-transition.loop-length")).toMatchObject({ status: "met", threshold: { value: 20 } });
    expect(byId(check(auto(8.03)), "loop-transition.loop-length")?.status).toBe("notMet");
    // 8 bars is fine too; 2 bars is not.
    expect(byId(check(auto(16)), "loop-transition.loop-length")?.status).toBe("met");
    expect(byId(check(auto(4)), "loop-transition.loop-length")?.status).toBe("notMet");
  });

  it("needs the loop to start within 1 beat of a downbeat", () => {
    const from = (start: number) => scenario({ loopEvents: [{ ctx: 48, control: "loopIn", deck: "A", value: 1, pos: start }, { ctx: 56, control: "loopOut", deck: "A", value: 8, pos: start }] });
    expect(byId(check(from(48.5)), "loop-transition.loop-in")).toMatchObject({ status: "met", measured: 1 });
    expect(byId(check(from(48.75)), "loop-transition.loop-in")?.status).toBe("notMet");
  });

  it("needs EXIT pressed by the Learner on a downbeat; a hot cue leaving the loop is not an exit", () => {
    expect(byId(check(scenario({ exitAt: 72.4 })), "loop-transition.loop-exit")).toMatchObject({ status: "met", measured: expect.closeTo(0.8, 9) as number });
    expect(byId(check(scenario({ exitAt: 73.2 })), "loop-transition.loop-exit")?.status).toBe("notMet");
    const engineExit = scenario({ exitAt: null, extraEvents: [{ ctx: 72, control: "loopExit", deck: "A", value: 1, byEngine: true }] });
    expect(byId(check(engineExit), "loop-transition.loop-exit")).toMatchObject({ status: "notMet", measured: null });
  });

  it("needs B in on an A downbeat, on one of B's phrase starts, while A loops", () => {
    expect(byId(check(scenario({ playB: 66 })), "loop-transition.loop-entry")?.status).toBe("met");
    expect(byId(check(scenario({ playB: 65 })), "loop-transition.loop-entry")?.status).toBe("notMet");
    expect(byId(check(scenario({ bStartPos: 4 })), "loop-transition.loop-entry")?.status).toBe("notMet");
    // B in before the loop: A is not looping yet.
    expect(byId(check(scenario({ playB: 48 })), "loop-transition.loop-entry")).toMatchObject({ status: "notMet" });
  });

  it("finds a double trigger: loop presses within 2 beats while A is heard", () => {
    const stutter = scenario({ extraEvents: [{ ctx: 40, control: "loopAuto", deck: "A", value: 2, pos: 40 }, { ctx: 40.6, control: "loopExit", deck: "A", value: 1 }] });
    expect(byId(check(stutter), "loop-transition.no-double")).toMatchObject({ status: "notMet", measured: 1 });
    expect(byId(check(), "loop-transition.no-double")).toMatchObject({ status: "met", measured: 0 });
  });

  it("looks only inside the attempt window: a loop from practice before it is not this attempt's", () => {
    const practised = scenario({ loopEvents: [{ ctx: -10, control: "loopAuto", deck: "A", value: 8, pos: 0 }] });
    expect(byId(check(practised), "loop-transition.loop-length")).toMatchObject({ status: "notMet", measured: null });
  });
});
