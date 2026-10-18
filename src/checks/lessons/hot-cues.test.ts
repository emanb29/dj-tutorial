import { describe, expect, it } from "vitest";
import type { ControlEvent, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { attempt, channel, frames, MUSIC, spec } from "../testing/synthetic.ts";

// 120 BPM: phrase markers every 16 s of track. Placement on a paused A in [0, 20); from 20 s A plays
// from track 8 s, so it reaches its phrase start at 16 s at heard 28 s; each pad jumps it to another
// phrase start, heard 16 s later on the next.
const WINDOW = { from: 0, to: 80 };
const TASK = { lessonId: "hot-cues", placeSection: { from: 0, to: 20 }, triggerSection: { from: 20, to: 80 }, slots: [1, 2, 3] } as const;
const PADS: Readonly<Record<number, number>> = { 1: 48, 2: 16, 3: 64 };

interface Scenario {
  /** Hot cue positions as set (default exactly on PADS). */
  readonly placed?: Readonly<Record<number, number | null>>;
  /** Press offsets from each phrase start, seconds (default on time); null = pad not pressed. */
  readonly pressOffsets?: readonly (number | null)[];
  readonly latencySec?: number;
  readonly extraEvents?: readonly ControlEvent[];
}

function scenario({ placed = PADS, pressOffsets = [0, 0, 0], latencySec = 0.05, extraEvents = [] }: Scenario = {}) {
  const events: ControlEvent[] = [];
  [1, 2, 3].forEach((slot, index) => {
    const pos = placed[slot];
    if (pos != null) events.push({ ctx: 2 + index * 5, control: "hotCueSet", deck: "A", value: slot, pos });
  });
  // A plays from 20 s at track 8 s. Each press lands `offset` from the heard phrase start; the jump applies a latency later.
  const segments: PlayheadSegment[] = [{ fromCtx: 0, pos: 0, rate: 0 }, { fromCtx: 20, pos: 8, rate: 1 }];
  let phraseAt = 28;
  pressOffsets.forEach((offset, index) => {
    const slot = index + 1;
    if (offset === null) return;
    const ctx = phraseAt + offset;
    events.push({ ctx, control: "hotCue", deck: "A", value: slot, pos: PADS[slot] ?? 0, appliedCtx: ctx + latencySec });
    segments.push({ fromCtx: ctx + latencySec, pos: PADS[slot] ?? 0, rate: 1 });
    // The next phrase start is 16 s after the jumped-to one, which sat `offset + latency` later than the press.
    phraseAt = ctx + latencySec + 16;
  });
  return attempt({
    decks: { A: { trackId: "track-a", playhead: { segments } } },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    events: [...events, ...extraEvents].sort((a, b) => a.ctx - b.ctx),
    meters: { master: frames(0, 80, () => MUSIC), A: frames(0, 80, () => MUSIC) },
  });
}

function check(recorded = scenario(), task: typeof TASK | { readonly lessonId: "hot-cues"; readonly placeSection: { from: number; to: number }; readonly triggerSection: { from: number; to: number }; readonly slots: readonly number[] } = TASK): CheckResult {
  const result = runCheck(spec(task, WINDOW, { tracks: [{ trackId: "track-a", trackSetId: "set-1", deck: "A" }] }), recorded);
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("hot-cues", () => {
  it("passes three hot cues on phrase starts, each triggered on A's phrase start", () => {
    const result = check();
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["hot-cues.hc-place", "hot-cues.hc-trigger"]);
    expect(byId(result, "hot-cues.hc-trigger")?.measured).toBeCloseTo(0);
  });

  it("places hot cues within ±20 ms of a phrase start: they are set on a paused deck", () => {
    expect(byId(check(scenario({ placed: { ...PADS, 2: 16.02 } })), "hot-cues.hc-place")?.status).toBe("met");
    expect(byId(check(scenario({ placed: { ...PADS, 2: 16.021 } })), "hot-cues.hc-place")).toMatchObject({ status: "notMet", measured: expect.closeTo(21, 6) as number });
    expect(byId(check(scenario({ placed: { ...PADS, 3: null } })), "hot-cues.hc-place")).toMatchObject({ status: "notMet", detail: { notSet: 1, pads: 3 } });
  });

  it("times each trigger from the press, ±120 ms in this Lesson (input leeway), whatever the latency before the jump", () => {
    expect(byId(check(scenario({ pressOffsets: [0.12, -0.12, 0], latencySec: 0.3 })), "hot-cues.hc-trigger")?.status).toBe("met");
    expect(byId(check(scenario({ pressOffsets: [0, 0.121, 0] })), "hot-cues.hc-trigger")).toMatchObject({ status: "notMet", measured: expect.closeTo(121, 6) as number });
  });

  it("needs every pad triggered", () => {
    expect(byId(check(scenario({ pressOffsets: [0, 0, null] })), "hot-cues.hc-trigger")).toMatchObject({ status: "notMet", detail: { untriggered: 1 } });
  });

  it("grades only this attempt's own sections: hot cues set or triggered elsewhere do not count", () => {
    // A set in the trigger section (by the playing deck) is not a placement; a trigger in the placement section is not graded.
    const recorded = scenario({
      placed: { 1: 48, 2: 16, 3: null },
      extraEvents: [
        { ctx: 30, control: "hotCueSet", deck: "A", value: 3, pos: 64 },
        { ctx: 10, control: "hotCue", deck: "A", value: 1, pos: 48, appliedCtx: 10.05 },
      ],
    });
    expect(byId(check(recorded), "hot-cues.hc-place")).toMatchObject({ status: "notMet", detail: { notSet: 1 } });
    expect(byId(check(recorded), "hot-cues.hc-trigger")).toMatchObject({ status: "met", detail: { triggers: 3 } });
  });

  it("counts a pad set where it took effect: a press heard just before the Check's cue reached the output is this attempt's", () => {
    const early = scenario({ placed: { 2: 16, 3: 64 }, extraEvents: [{ ctx: -0.02, control: "hotCueSet", deck: "A", value: 1, pos: 48, appliedCtx: 0.06 }] });
    expect(byId(check(early), "hot-cues.hc-place")).toMatchObject({ status: "met", detail: { notSet: 0 } });
    // The last pad takes effect with the Ready that cues A to play: at the placement's very end.
    const last = scenario({ placed: { 1: 48, 2: 16 }, extraEvents: [{ ctx: 19.9, control: "hotCueSet", deck: "A", value: 3, pos: 64, appliedCtx: 20 }] });
    expect(byId(check(last), "hot-cues.hc-place")).toMatchObject({ status: "met", detail: { notSet: 0 } });
  });

  it("grades one pad in the short form", () => {
    const short = { ...TASK, slots: [1] };
    expect(check(scenario({ placed: { 1: 48 }, pressOffsets: [0] }), short).outcome).toEqual({ kind: "passed" });
  });

  it("states the introducing Lesson's ±120 ms tier as its threshold", () => {
    expect(byId(check(scenario({ pressOffsets: [0.1, 0, 0] })), "hot-cues.hc-trigger")?.threshold).toEqual({ op: "<=", value: 120, unit: "ms" });
  });
});
