import { describe, expect, it } from "vitest";
import type { Attempt, ControlEvent, CtxSpan, LessonId, MeterFrame, PlayheadSegment, SetTrack, TaskSpec } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BAR, BEAT, PHRASE, SILENT, attempt, channel, event, frames, grid, phraseMarkersEvery8Bars, playing, ramp, spec } from "../testing/synthetic.ts";
import { finalMixTransitions } from "./final-mix.ts";

// A three-track set at 120 BPM (a beat is 0.5 s, a bar 2 s, a phrase 16 s):
// - track-1 on A from 0 s; a cut to track-2 on B on A's third phrase start (32 s);
// - track-3 loaded on A at 40 s, blended in from B's phrase start at 64 s over 8 bars (B out at 80 s);
// - the set ends at 120 s.

const EXAM_AIDS = { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: false };
const WINDOW: CtxSpan = { from: 0, to: 120 };
const ROUTE: LessonId[] = [
  "deck-basics",
  "beats-and-bars",
  "phrases",
  "gain-staging",
  "headphone-cue",
  "cue-point",
  "cut-on-phrase",
  "tempo-fader",
  "sync-blend",
  "eq-basics",
  "bass-swap",
  "nudge-phase",
  "tempo-by-ear",
  "blend-by-ear",
];

interface SetScenario {
  /** When B (track-2) starts and the cut happens (default 32 s). */
  readonly cutAt?: number;
  /** When track-3 starts on A (default 64 s) and B's fader closes (default 16 s later). */
  readonly blendAt?: number;
  readonly blendEnd?: number;
  /** track-3's playhead from `blendAt`, replacing a plain run at rate 1 (drift). */
  readonly track3?: readonly PlayheadSegment[];
  readonly bpm3?: number;
  /** track-3's channel short-term loudness offset, dB. */
  readonly track3OffsetDb?: number;
  readonly genres?: readonly string[];
  /** Master momentary loudness at `t` (default −14). */
  readonly masterLufs?: (t: number) => number;
  readonly extraEvents?: readonly ControlEvent[];
  /** Replace the blend's channel-fader events (e.g. a crossfader blend). */
  readonly blendEvents?: readonly ControlEvent[];
  readonly crossfader?: number;
  /** When track-3 is loaded onto A (default 40 s). */
  readonly loadAt?: number;
  /** Leave track-3 out: a two-track set. */
  readonly twoTracks?: boolean;
}

const channelFrames = (on: (t: number) => boolean, offsetDb = 0): MeterFrame[] =>
  frames(0, WINDOW.to, (t) => (on(t) ? { peak: -3, momentary: -14 + offsetDb } : SILENT));

function setAttempt(options: SetScenario = {}): Attempt {
  const { cutAt = 2 * PHRASE, blendAt = 4 * PHRASE, masterLufs = () => -14, extraEvents = [], twoTracks = false } = options;
  const blendEnd = options.blendEnd ?? blendAt + 8 * BAR;
  const track3 = options.track3 ?? playing(blendAt);
  const loadAt = options.loadAt ?? 40;
  const blend = options.blendEvents ?? [event(blendAt, "channelFader", 1, "A"), event(blendEnd, "channelFader", 0, "B")];
  const events = [
    event(2, "cueMonitor", 1, "B"),
    event(cutAt, "channelFader", 1, "B"),
    event(cutAt, "channelFader", 0, "A"),
    ...(twoTracks ? [] : [event(50, "cueMonitor", 1, "A"), ...blend]),
    ...extraEvents,
  ].sort((a, b) => a.ctx - b.ctx);
  const earlierA = { trackId: "track-1", playhead: { segments: playing(0, 0, loadAt) }, loadedCtx: 0 };
  return attempt({
    decks: {
      A: twoTracks
        ? { trackId: "track-1", playhead: { segments: playing(0) }, loadedCtx: 0 }
        : { trackId: "track-3", playhead: { segments: [{ fromCtx: loadAt, pos: 0, rate: 0 }, ...track3] }, loadedCtx: loadAt, earlier: [earlierA] },
      B: { trackId: "track-2", playhead: { segments: [{ fromCtx: 0, pos: 0, rate: 0 }, ...playing(cutAt)] }, loadedCtx: 0 },
    },
    grids: { "track-1": grid(), "track-2": grid(), "track-3": grid({ bpm: options.bpm3 ?? 120 }) },
    phraseMarkers: { "track-1": phraseMarkersEvery8Bars(), "track-2": phraseMarkersEvery8Bars(), "track-3": phraseMarkersEvery8Bars() },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: options.crossfader ?? 0.5 },
    events,
    meters: {
      master: frames(0, WINDOW.to, (t) => ({ peak: -3, momentary: masterLufs(t) })),
      A: twoTracks ? channelFrames(() => true) : channelFrames((t) => t < loadAt || t >= blendAt, options.track3OffsetDb ?? 0),
      // B's short-term loudness fills its 3 s window after B starts, as the meter's does.
      B: frames(0, WINDOW.to, (t) => (t >= cutAt ? { peak: -3, momentary: -14, shortTerm: t < cutAt + 3 ? -20 : -14 } : SILENT)),
    },
  });
}

function setSpec(options: SetScenario = {}, overrides: Partial<TaskSpec> = {}): TaskSpec {
  const ids = options.twoTracks === true ? ["track-1", "track-2"] : ["track-1", "track-2", "track-3"];
  const genres = options.genres ?? ids.map(() => "house");
  const set: SetTrack[] = ids.map((trackId, index) => ({ trackId, genre: genres[index] ?? "house", camelot: null }));
  return spec({ lessonId: "final-mix", set }, WINDOW, {
    tracks: ids.map((trackId, index) => ({ trackId, trackSetId: null, deck: index === 1 ? "B" : "A" })),
    aids: EXAM_AIDS,
    passedLessons: ROUTE,
    ...overrides,
  });
}

function check(options: SetScenario = {}, overrides: Partial<TaskSpec> = {}): CheckResult {
  const result = runCheck(setSpec(options, overrides), setAttempt(options));
  if (!("criteria" in result)) throw new Error(`expected a graded result, got ${JSON.stringify(result.outcome)}`);
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("final-mix", () => {
  it("passes a three-track set with a cut and a blend, on the phrase and in phase, and bands it", () => {
    const result = check();

    expect(result.outcome).toMatchObject({ kind: "passed", bands: { beatSyncing: "distinction", phrasing: "distinction" } });
    // Both basslines ran through the whole blend (no EQ swap): Balance stays at Pass.
    expect(result.outcome).toMatchObject({ bands: { balance: "pass", overall: "pass" } });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      "final-mix.track-count",
      "final-mix.one-genre",
      "final-mix.tempo-range",
      "final-mix.technique",
      "standing.no-clip",
      "standing.no-dead-air",
      "standing.on-phrase",
      "standing.level-match",
      "standing.cued-first",
      "standing.trim-still",
      "standing.no-boost",
      "standing.controls-reset",
      "standing.no-recue",
      "standing.one-bass",
      "standing.drift",
      "standing.overcorrect",
    ]);
    expect(byId(result, "final-mix.track-count")?.measured).toBe(3);
    expect(byId(result, "final-mix.technique")?.detail).toMatchObject({ blends: 1, cuts: 1, unclassified: 0 });
    expect(result.metrics).toMatchObject({ transitions: 2, blends: 1, cuts: 1 });
    // Exam severities: level-match and drift fail the set; on-phrase is measured on every transition.
    expect(byId(result, "standing.level-match")).toMatchObject({ severity: "fail", status: "met" });
    expect(byId(result, "standing.drift")).toMatchObject({ severity: "fail", status: "met", measured: 1 });
    expect(byId(result, "standing.on-phrase")?.detail).toMatchObject({ transitions: 2 });
    expect(byId(result, "standing.one-bass")).toMatchObject({ severity: "warn", status: "notMet" });
  });

  it("reports each transition with its own results", () => {
    const reports = finalMixTransitions(setSpec(), setAttempt());
    expect(reports).toEqual([
      expect.objectContaining({ number: 1, fromTrackId: "track-1", toTrackId: "track-2", kind: "cut", met: true, phaseHold: null }),
      expect.objectContaining({ number: 2, fromTrackId: "track-2", toTrackId: "track-3", kind: "blend", met: true, phaseHold: 1 }),
    ]);
    expect(reports[0]?.at).toBeCloseTo(32);
    expect(reports[1]?.at).toBeCloseTo(64);
    expect(reports[1]?.phraseBeats).toBeCloseTo(0);
  });

  it("fails a transition that starts more than a beat off the phrase, and names it in the evidence", () => {
    // Two beats late: still in phase (on a beat), but off the phrase.
    const late = 4 * PHRASE + 2 * BEAT;
    const result = check({ blendAt: late });
    expect(byId(result, "standing.on-phrase")).toMatchObject({ status: "notMet" });
    expect(byId(result, "standing.on-phrase")?.measured).toBeCloseTo(2);
    expect(byId(result, "standing.on-phrase")?.evidence.map((item) => item.label)).toEqual(["transition 1: B in", "transition 2: B in"]);
    expect(result.outcome).toMatchObject({ kind: "failed", failedCriteria: ["standing.on-phrase"] });
    expect(finalMixTransitions(setSpec({ blendAt: late }), setAttempt({ blendAt: late })).map((report) => report.met)).toEqual([true, false]);
  });

  it("fails a blend that drifts over 60 ms for more than a bar", () => {
    // track-3 runs 10% fast for 0.65 s (65 ms ahead), holds there 4 s, then comes back.
    const drifting: PlayheadSegment[] = [
      { fromCtx: 64, pos: 0, rate: 1 },
      { fromCtx: 66, pos: 2, rate: 1.1 },
      { fromCtx: 66.65, pos: 2.715, rate: 1 },
      { fromCtx: 70.65, pos: 6.715, rate: 0.9 },
      { fromCtx: 71.3, pos: 7.3, rate: 1 },
    ];
    const result = check({ track3: drifting });
    expect(byId(result, "standing.drift")).toMatchObject({ status: "notMet" });
    expect(result.outcome).toMatchObject({ kind: "failed", failedCriteria: ["standing.drift"] });
  });

  it("needs three tracks, each heard for 16 bars", () => {
    const two = check({ twoTracks: true });
    expect(byId(two, "final-mix.track-count")).toMatchObject({ status: "notMet", measured: 2 });
    // The cut at 24 s leaves track-1 on the master for 12 bars only.
    const short = check({ cutAt: 24 + PHRASE / 2 - 4 * BAR - 8 });
    expect(byId(short, "final-mix.track-count")?.measured).toBe(2);
  });

  it("needs a blend and a cut", () => {
    // Track-3 comes in with a cut too: no blend.
    const cuts = check({ blendEvents: [event(64, "channelFader", 1, "A"), event(64, "channelFader", 0, "B")] });
    expect(byId(cuts, "final-mix.technique")).toMatchObject({ status: "notMet", detail: { blends: 0, cuts: 2 } });
  });

  it("needs one genre and tempos within ±2% of the first track", () => {
    expect(byId(check({ genres: ["house", "House ", "bass music"] }), "final-mix.one-genre")).toMatchObject({ status: "notMet", measured: 2 });
    expect(byId(check({ genres: ["house", "House ", "house"] }), "final-mix.one-genre")?.status).toBe("met");
    // 122.4 BPM is 2% from 120: allowed; 122.5 is not. (track-3 is played at its own tempo: only the grid is read.)
    expect(byId(check({ bpm3: 122.4 }), "final-mix.tempo-range")?.status).toBe("met");
    expect(byId(check({ bpm3: 122.5 }), "final-mix.tempo-range")).toMatchObject({ status: "notMet" });
  });

  it("fails dead air between tracks and a handover more than 2 dB apart", () => {
    const gap = check({ masterLufs: (t) => (t >= 70 && t < 71.5 ? -60 : -14) });
    expect(byId(gap, "standing.no-dead-air")).toMatchObject({ status: "notMet" });
    const louder = check({ track3OffsetDb: 3 });
    expect(byId(louder, "standing.level-match")).toMatchObject({ status: "notMet" });
    expect(byId(louder, "standing.level-match")?.measured).toBeCloseTo(3);
  });

  it("measures the handover's levels past an early load of the next track onto the free deck", () => {
    // track-3 goes onto deck A 1 s after the cut: track-2's level is still read 3 s after it came in.
    const result = check({ loadAt: 33 });
    expect(byId(result, "standing.level-match")).toMatchObject({ status: "met" });
    expect(result.outcome).toMatchObject({ kind: "passed" });
  });

  it("grades a crossfader blend from deck B back to deck A (the crossfader mirrors in the view)", () => {
    // Both channel faders open; the crossfader moves from B (1) to A (0) through the blend.
    const crossfaderBlend: SetScenario = {
      crossfader: 0.5,
      blendEvents: [event(63, "crossfader", 1), event(64, "channelFader", 1, "A"), ...ramp("crossfader", undefined, { from: 64, to: 80 }, 1, 0)],
    };
    const result = check(crossfaderBlend);
    const reports = finalMixTransitions(setSpec(crossfaderBlend), setAttempt(crossfaderBlend));
    expect(reports.map((report) => report.kind)).toEqual(["cut", "blend"]);
    expect(byId(result, "final-mix.technique")?.status).toBe("met");
  });

  it("refuses to grade with sync, quantize, the BPM display or the phase meter on", () => {
    for (const aid of ["sync", "quantize", "bpmDisplay", "phaseMeter"] as const) {
      expect(() => check({}, { aids: { ...EXAM_AIDS, [aid]: true } })).toThrow(new RegExp(aid));
    }
  });

  it("voids a set with a track whose grid cannot be trusted", () => {
    const recorded = { ...setAttempt(), grids: { ...setAttempt().grids, "track-2": grid({ rmsResidualMs: 22 }) } };
    expect(runCheck(setSpec(), recorded).outcome).toEqual({ kind: "void", reason: "gridUntrusted" });
  });
});
