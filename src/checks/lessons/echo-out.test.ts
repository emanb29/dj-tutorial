import { describe, expect, it } from "vitest";
import type { ControlEvent, LessonId } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { attempt, BAR, channel, event, frames, MUSIC, playing, SILENT, spec } from "../testing/synthetic.ts";

// 120 BPM: a bar is 2 s, a phrase 16 s. A plays from 0 with ECHO on A from 20 s; A's fader is cut on
// the downbeat at 46 s (one bar before its phrase start at 48 s); B (fader up, cued) plays at 48 s;
// the echoes die out at 50 s; Beat FX goes off at 52 s.
const WINDOW = { from: 0, to: 64 };

interface Scenario {
  readonly cutAt?: number;
  readonly playB?: number;
  readonly fxOnAt?: number | null;
  readonly fxOffAt?: number | null;
  readonly channelEvent?: ControlEvent;
  readonly tailEnd?: number;
  /** A pauses at the cut instead of playing on with its fader closed. */
  readonly pauseA?: boolean;
}

function scenario({ cutAt = 46, playB = 48, fxOnAt = 20, fxOffAt = 52, channelEvent = event(10, "beatFxChannel", 1, "A"), tailEnd = 50, pauseA = false }: Scenario = {}) {
  const events = [
    channelEvent,
    event(12, "beatFxBeats", 1),
    event(30, "cueMonitor", 1, "B"),
    event(40, "channelFader", 1, "B"),
    ...(fxOnAt === null ? [] : [event(fxOnAt, "beatFx", 1)]),
    event(cutAt, "channelFader", 0, "A"),
    { ctx: playB, control: "play", deck: "B", value: 1, appliedCtx: playB } as ControlEvent,
    ...(fxOffAt === null ? [] : [event(fxOffAt, "beatFx", 0)]),
  ].sort((a, b) => a.ctx - b.ctx);
  return attempt({
    decks: {
      A: { trackId: "track-a", playhead: { segments: playing(0, 0, pauseA ? cutAt : undefined) } },
      B: { trackId: "track-b", playhead: { segments: playing(playB, 0) } },
    },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    events,
    meters: {
      master: frames(0, 64, () => MUSIC),
      A: frames(0, 64, () => MUSIC),
      B: frames(0, 64, (t) => (t >= playB ? MUSIC : SILENT)),
      fxReturn: frames(0, 64, (t) => (fxOnAt !== null && t >= fxOnAt && t < tailEnd ? { peak: -10, momentary: -24 } : SILENT)),
    },
  });
}

function check(recorded = scenario(), passedLessons: readonly LessonId[] = []): CheckResult {
  const result = runCheck(spec({ lessonId: "echo-out" }, WINDOW, { passedLessons }), recorded);
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("echo-out", () => {
  it("passes ECHO on A, a cut on the downbeat, B on the phrase start A would have reached, FX off after the tail", () => {
    const result = check();
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["echo-out.echo-cut", "echo-out.echo-entry", "echo-out.fx-off"]);
    expect(byId(result, "echo-out.fx-off")?.measured).toBeCloseTo((52 - 50) / BAR, 6);
    expect(result.metrics["echoTailBars"]).toBeCloseTo((50 - 46.02) / BAR, 1);
  });

  it("needs the echo on A (or the master) as A goes silent", () => {
    expect(byId(check(scenario({ fxOnAt: null, fxOffAt: null })), "echo-out.echo-cut")).toMatchObject({ status: "notMet", detail: { echoOn: 0 } });
    expect(byId(check(scenario({ channelEvent: event(10, "beatFxChannel", 1, "B") })), "echo-out.echo-cut")?.status).toBe("notMet");
    expect(byId(check(scenario({ channelEvent: event(10, "beatFxChannel", 1) })), "echo-out.echo-cut")?.status).toBe("met");
  });

  it("times the cut from the fader move, within 1 beat of a downbeat", () => {
    expect(byId(check(scenario({ cutAt: 46.5 })), "echo-out.echo-cut")).toMatchObject({ status: "met", measured: expect.closeTo(1, 6) as number });
    expect(byId(check(scenario({ cutAt: 47 })), "echo-out.echo-cut")?.status).toBe("notMet");
  });

  it("times B's Play against A's next phrase start had A kept playing, even when A was paused", () => {
    expect(byId(check(scenario({ playB: 48.5 })), "echo-out.echo-entry")).toMatchObject({ status: "met", measured: expect.closeTo(1, 6) as number });
    expect(byId(check(scenario({ playB: 49 })), "echo-out.echo-entry")?.status).toBe("notMet");
    expect(byId(check(scenario({ pauseA: true })), "echo-out.echo-entry")).toMatchObject({ status: "met", measured: expect.closeTo(0, 6) as number });
  });

  it("needs Beat FX off within 2 bars of the echoes dying out; off early is fine, never off is not", () => {
    expect(byId(check(scenario({ fxOffAt: 54 })), "echo-out.fx-off")?.status).toBe("met");
    expect(byId(check(scenario({ fxOffAt: 54.1 })), "echo-out.fx-off")?.status).toBe("notMet");
    expect(byId(check(scenario({ fxOffAt: 47 })), "echo-out.fx-off")?.status).toBe("met");
    expect(byId(check(scenario({ fxOffAt: null })), "echo-out.fx-off")).toMatchObject({ status: "notMet", measured: null });
  });

  it("counts the tail as sound: no dead air between the cut and B", () => {
    const result = check(scenario(), ["cut-on-phrase", "sync-blend"]);
    expect(byId(result, "standing.no-dead-air")).toMatchObject({ status: "met" });
  });
});

describe("standing.controls-reset, the FX part (once echo-out is passed)", () => {
  const cold = (recorded: ReturnType<typeof scenario>) => byId(check(recorded, ["cut-on-phrase", "sync-blend", "echo-out"]), "standing.controls-reset");

  it("needs Beat FX off before A can be heard again (here: by the end), at any time after the echoes", () => {
    expect(cold(scenario({ fxOffAt: 50 + BAR }))?.status).toBe("met");
    expect(cold(scenario({ fxOffAt: 50 + 3 * BAR }))?.status).toBe("met");
    expect(cold(scenario({ fxOffAt: null }))).toMatchObject({ status: "notMet", measured: null });
  });

  it("does not apply before echo-out is passed", () => {
    expect(byId(check(scenario({ fxOffAt: null }), ["cut-on-phrase", "sync-blend"]), "standing.controls-reset")).toBeUndefined();
  });
});
