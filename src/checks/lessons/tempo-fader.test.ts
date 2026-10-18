import { describe, expect, it } from "vitest";
import type { ControlEvent, PlayheadSegment } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { runCheck } from "../run-check.ts";
import { BPM, applied, attempt, event, spec } from "../testing/synthetic.ts";

const TARGETS = [122, 118, 125];
const CLIPS = [
  { answerKey: "clip1", masterTempoOn: true },
  { answerKey: "clip2", masterTempoOn: false },
];

/** B plays at each BPM in turn for 10 s; the Learner confirms each at the end of its 10 s. */
function setTo(bpms: readonly number[]): PlayheadSegment[] {
  let pos = 0;
  return bpms.map((bpm, index) => {
    const segment = { fromCtx: index * 10, pos, rate: bpm / BPM };
    pos += 10 * segment.rate;
    return segment;
  });
}

const confirms: ControlEvent[] = [event(9, "ready", 1, "B"), event(19, "ready", 1, "B"), event(29, "done", 1)];

function check(
  segments: readonly PlayheadSegment[],
  options: {
    answers?: Record<string, number>;
    events?: readonly ControlEvent[];
    /** Jog bends, merged with `events`. */
    bends?: readonly ControlEvent[];
    targets?: readonly number[];
    clips?: typeof CLIPS;
  } = {},
): CheckResult {
  const result = runCheck(
    spec({ lessonId: "tempo-fader", targetsBpm: options.targets ?? TARGETS, masterTempoClips: options.clips ?? CLIPS }, { from: 0, to: 30 }),
    attempt({
      decks: { B: { trackId: "track-b", playhead: { segments } } },
      events: [...(options.events ?? confirms), ...(options.bends ?? [])].sort((a, b) => a.ctx - b.ctx),
      answers: options.answers ?? { clip1: 1, clip2: 0 },
    }),
  );
  if (!("criteria" in result)) throw new Error("expected a graded result");
  return result;
}

const byId = (result: CheckResult, id: string) => result.criteria.find((criterion) => criterion.id === id);

describe("tempo-fader", () => {
  it("passes three BPMs set within 0.05 and both Master Tempo clips named", () => {
    const result = check(setTo(TARGETS));

    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["tempo-fader.set-bpm", "tempo-fader.master-tempo-ear"]);
    expect(byId(result, "tempo-fader.set-bpm")?.measured).toBeCloseTo(0);
  });

  // ISS-100: the last Ready ends the attempt, so it can be heard at the attempt's very end (window.to).
  it("counts the Ready that ends the attempt, heard at the window's end", () => {
    const result = check(setTo(TARGETS), { events: [event(9, "ready", 1, "B"), event(19, "ready", 1, "B"), event(30, "ready", 1, "B")] });

    expect(byId(result, "tempo-fader.set-bpm")).toMatchObject({ status: "met" });
  });

  it("allows 0.05 BPM off a target and fails beyond, on any one of the three", () => {
    expect(byId(check(setTo([122.05, 118, 125])), "tempo-fader.set-bpm")?.status).toBe("met");
    expect(byId(check(setTo([122, 117.94, 125])), "tempo-fader.set-bpm")).toMatchObject({ status: "notMet" });
    expect(byId(check(setTo([122, 117.94, 125])), "tempo-fader.set-bpm")?.measured).toBeCloseTo(0.06);
  });

  it("factors out a jog bend held at the confirm press: the tempo fader is what is set", () => {
    const bent = [...setTo(TARGETS).slice(0, 2), { fromCtx: 18.5, pos: 0, rate: (118 / BPM) * 1.05 }];
    // Re-anchor the bent segment's position; only rate matters for BPM.
    const result = check([...bent, ...setTo(TARGETS).slice(2)], {
      bends: [event(18.5, "jogBend", 0.05, "B"), event(19.5, "jogBend", 0, "B")],
    });

    expect(byId(result, "tempo-fader.set-bpm")?.status).toBe("met");
  });

  it("grades a Ready pressed right after the last tempo move by that move, not the rate still heard", () => {
    // The last nudge (117.9 → 118) is heard at 18.9 and takes effect in the playhead at 19.15 (output
    // latency plus the Master Tempo stretch lead); Ready comes at 19.0, while the display reads 118.0.
    const segments = [
      { fromCtx: 0, pos: 0, rate: 122 / BPM },
      { fromCtx: 10, pos: 10 * (122 / BPM), rate: 117.9 / BPM },
      { fromCtx: 19.15, pos: 10 * (122 / BPM) + 9.15 * (117.9 / BPM), rate: 118 / BPM },
      { fromCtx: 20, pos: 10 * (122 / BPM) + 9.15 * (117.9 / BPM) + 0.85 * (118 / BPM), rate: 125 / BPM },
    ];
    const result = check(segments, {
      events: [event(9, "ready", 1, "B"), applied(18.9, "tempo", 118 / BPM, "B", 0.25), event(19, "ready", 1, "B"), event(29, "done", 1)],
    });

    expect(byId(result, "tempo-fader.set-bpm")).toMatchObject({ status: "met" });
  });

  it("leaves the ear part not applicable when no clip was played (Master Tempo could not load)", () => {
    const result = check(setTo(TARGETS), { clips: [], answers: {} });
    expect(byId(result, "tempo-fader.master-tempo-ear")).toMatchObject({ status: "notApplicable", measured: null });
    expect(result.outcome).toEqual({ kind: "passed" });
  });

  it("needs a confirm press per target", () => {
    expect(byId(check(setTo(TARGETS), { events: confirms.slice(0, 2) }), "tempo-fader.set-bpm")).toMatchObject({
      status: "notMet",
      measured: null,
    });
  });

  it("needs every Master Tempo clip right (2 of 2; 1 of 1 in the short form)", () => {
    expect(byId(check(setTo(TARGETS), { answers: { clip1: 1, clip2: 1 } }), "tempo-fader.master-tempo-ear")).toMatchObject({
      status: "notMet",
      measured: 1,
    });
    const short = check(setTo([122]), { targets: [122], clips: CLIPS.slice(0, 1), events: [event(29, "done", 1)], answers: { clip1: 1 } });
    expect(short.outcome).toEqual({ kind: "passed" });
  });
});
