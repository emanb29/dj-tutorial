import { describe, expect, it } from "vitest";
import { drillReveals, drillStep, livePhaseMs, startDrill, tempoPercentApart, type DrillAction, type DrillReading, type DrillState } from "./drill.ts";
import type { PracticeDrill } from "./types.ts";

const BAR_MS = 2000;
const HOLD: PracticeDrill = { kind: "hold", offsetsBeats: [0.2, -0.15], apartPercents: [0], holdMs: 15, holdBars: 1, giveUpBars: 8, revealMs: 1500 };
const EAR: PracticeDrill = { kind: "tempo-ear", apartPercents: [1.5, -1.2], matchBpm: 0.1, giveUpBars: 24, revealMs: 2500 };

const reading = (nowMs: number, overrides: Partial<DrillReading> = {}): DrillReading => ({ nowMs, phaseMs: 100, bpmA: 124, bpmB: 125.86, barMs: BAR_MS, ...overrides });

/** Feeds ticks every 25 ms from `fromMs` to `toMs`, with the phase error `phaseAt(t)`; returns every action and the last state. */
function run(drill: PracticeDrill, state: DrillState, fromMs: number, toMs: number, phaseAt: (t: number) => number | null) {
  const actions: DrillAction[] = [];
  let current = state;
  for (let t = fromMs; t <= toMs; t += 25) {
    const step = drillStep(drill, current, { kind: "tick", reading: reading(t, { phaseMs: phaseAt(t) }) });
    current = step.state;
    actions.push(...step.actions);
  }
  return { actions, state: current };
}

const reps = (actions: readonly DrillAction[]) => actions.flatMap((action) => (action.kind === "observe" ? [action.observation] : []));
const rounds = (actions: readonly DrillAction[]) => actions.flatMap((action) => (action.kind === "start-round" ? [action.round] : []));

describe("hold drills (nudge-phase, blend-by-ear)", () => {
  it("starts the first round with B knocked out by the first offset", () => {
    const first = startDrill(HOLD, 0);
    expect(first.actions).toEqual([{ kind: "start-round", round: { offsetBeats: 0.2, apartPercent: 0 } }]);
    expect(first.state.round).toBe(1);
  });

  it("counts a good rep once B stays under the limit for the hold bars, shows it, then starts the next round", () => {
    // Out until 3 s, then in line.
    const { actions, state } = run(HOLD, startDrill(HOLD, 0).state, 0, 3000 + BAR_MS + 50, (t) => (t < 3000 ? 80 : 5));
    expect(reps(actions)).toEqual([{ kind: "phase-rep", held: true }]);
    expect(drillReveals(state)).toBe(true);
    expect(state.line).toBe("✓ Held in line");

    const next = run(HOLD, state, 5100, 5100 + 1600, () => 5);
    expect(rounds(next.actions)).toEqual([{ offsetBeats: -0.15, apartPercent: 0 }]);
    expect(drillReveals(next.state)).toBe(false);
  });

  it("starts the hold over when B drifts out again", () => {
    const { actions } = run(HOLD, startDrill(HOLD, 0).state, 0, 2500, (t) => (t > 1000 && t < 1100 ? 40 : 5));
    expect(reps(actions)).toEqual([]);
  });

  it("is a missed rep after the give-up bars", () => {
    const { actions, state } = run(HOLD, startDrill(HOLD, 0).state, 0, 8 * BAR_MS + 25, () => 60);
    expect(reps(actions)).toEqual([{ kind: "phase-rep", held: false }]);
    expect(state.line).toBe("Missed it: listen for two kicks, then nudge");
  });

  it("says when the drift should be heard, but only a bar into the round", () => {
    const early = run(HOLD, startDrill(HOLD, 0).state, 0, 500, () => 60);
    expect(early.state.line).toBeNull();
    const later = run(HOLD, early.state, 525, BAR_MS + 100, () => 60);
    expect(later.state.line).toBe("Two kicks? Nudge B");
  });
});

describe("the tempo-ear drill (tempo-by-ear)", () => {
  const playing = (gap: number): DrillState => {
    const started = startDrill(EAR, 0).state;
    return drillStep(EAR, started, { kind: "tick", reading: reading(25, { bpmB: 124 + gap }) }).state;
  };

  it("counts the round's first tempo move as a guess: right when it closes the gap", () => {
    const right = drillStep(EAR, playing(1.8), { kind: "tempo-move", deck: "B", reading: reading(100, { bpmB: 125.6 }) });
    expect(reps(right.actions)).toEqual([{ kind: "tempo-guess", right: true }]);
    expect(right.state.line).toBe("Right way. Match it by ear, then R");

    const wrong = drillStep(EAR, playing(1.8), { kind: "tempo-move", deck: "B", reading: reading(100, { bpmB: 126 }) });
    expect(reps(wrong.actions)).toEqual([{ kind: "tempo-guess", right: false }]);
    expect(wrong.state.line).toBe("Other way: B was faster");

    // Moving A towards B is right too, and only the first move counts.
    const viaA = drillStep(EAR, playing(-1.5), { kind: "tempo-move", deck: "A", reading: reading(100, { bpmA: 123.5, bpmB: 122.5 }) });
    expect(reps(viaA.actions)).toEqual([{ kind: "tempo-guess", right: true }]);
    expect(reps(drillStep(EAR, viaA.state, { kind: "tempo-move", deck: "B", reading: reading(120, { bpmB: 130 }) }).actions)).toEqual([]);
  });

  it("scores Ready on the Check's 0.1 BPM, reveals the displays, then a new round with the next offset", () => {
    const guessed = drillStep(EAR, playing(1.8), { kind: "tempo-move", deck: "B", reading: reading(100, { bpmB: 125 }) }).state;
    const matched = drillStep(EAR, guessed, { kind: "ready", reading: reading(5000, { bpmB: 124.04 }) });
    expect(reps(matched.actions)).toEqual([{ kind: "tempo-match", offBpm: expect.closeTo(0.04, 6) as number, good: true }]);
    expect(matched.state.line).toBe("✓ 0.04 BPM apart");
    expect(drillReveals(matched.state)).toBe(true);
    const next = drillStep(EAR, matched.state, { kind: "tick", reading: reading(7600) });
    expect(rounds(next.actions)).toEqual([{ offsetBeats: 0, apartPercent: -1.2 }]);

    const off = drillStep(EAR, guessed, { kind: "ready", reading: reading(5000, { bpmB: 123.4 }) });
    expect(reps(off.actions)).toEqual([{ kind: "tempo-match", offBpm: expect.closeTo(0.6, 6) as number, good: false }]);
    expect(off.state.line).toBe("0.60 BPM apart: B is slower");
  });

  it("starts a new round when nothing happens for the give-up bars", () => {
    const stalled = drillStep(EAR, playing(1), { kind: "tick", reading: reading(24 * BAR_MS + 10) });
    expect(rounds(stalled.actions)).toHaveLength(1);
    expect(reps(stalled.actions)).toEqual([]);
  });
});

describe("live arithmetic", () => {
  it("phase error is A's beat minus B's, wrapped to half a beat, on A's beat length", () => {
    expect(livePhaseMs(10.1, 10, 500)).toBeCloseTo(50);
    expect(livePhaseMs(10, 10.1, 500)).toBeCloseTo(-50);
    expect(livePhaseMs(10.9, 3, 500)).toBeCloseTo(-50);
  });

  it("puts B's tempo fader where B plays a given percent off A", () => {
    // 121 BPM played 1.5% faster than 124: 125.86 BPM.
    expect(121 * (1 + tempoPercentApart(124, 121, 1.5) / 100)).toBeCloseTo(124 * 1.015, 9);
  });
});
