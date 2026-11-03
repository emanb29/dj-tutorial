import { describe, expect, it } from "vitest";
import { testGrid } from "@shared/mix-plan-test-support.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import { secondsAtBeat, type Transition } from "@shared/mix-plan.ts";
import { FILTER_OPEN_LOW_PASS_HZ, KILL_DB, pointValueAt, previewSchedule } from "./preview-schedule.ts";

// The outgoing track at 120 BPM, the incoming one at 125; bar 1 at 0.1 s in both.
const GRIDS = { outgoing: testGrid({ bpm: 120 }), incoming: testGrid({ bpm: 125 }) };
const PLACE = { outgoingAt: { bar: 17, beat: 1 }, incomingAt: { bar: 9, beat: 1 }, tempos: { outgoing: 120, incoming: 125 } } as const;

describe("previewSchedule", () => {
  it("plays from 1 phrase before the Transition to 1 phrase after, at the outgoing track's tempo", () => {
    const schedule = previewSchedule(transitionFromRecipe("crossfade-16", PLACE), GRIDS);
    expect(schedule).toMatchObject({ secPerBeat: 0.5, fromBeat: -32, toBeat: 96 });
    // The outgoing track from bar 9 (a phrase before bar 17), all the way.
    expect(schedule.outgoing.segments).toEqual([{ startBeat: -32, endBeat: 96, offsetSec: secondsAtBeat(GRIDS.outgoing, 32) }]);
    // The incoming one from its bar 9 at beat 0, matched to 120 BPM.
    expect(schedule.incoming.segments).toEqual([{ startBeat: 0, endBeat: 96, offsetSec: secondsAtBeat(GRIDS.incoming, 32) }]);
    expect(schedule.incoming.rate).toEqual([
      { beat: 0, value: 0.96 },
      { beat: 96, value: 0.96 },
    ]);
  });

  it("follows the volume lanes through the fader curve: the crossfade's halves", () => {
    const schedule = previewSchedule(transitionFromRecipe("crossfade-16", PLACE), GRIDS);
    expect(pointValueAt(schedule.outgoing.gain, -10)).toBe(1);
    expect(pointValueAt(schedule.incoming.gain, 0)).toBe(0);
    // Halfway up the fader is a quarter of the amplitude (position²).
    expect(pointValueAt(schedule.incoming.gain, 16)).toBeCloseTo(0.25);
    expect(pointValueAt(schedule.incoming.gain, 40)).toBe(1);
    expect(pointValueAt(schedule.outgoing.gain, 64)).toBe(0);
  });

  it("keeps a jump a jump: the cut on the 1 switches at beat 0", () => {
    const schedule = previewSchedule(transitionFromRecipe("cut-on-the-1", PLACE), GRIDS);
    const at0 = schedule.outgoing.gain.filter((point) => point.beat === 0).map((point) => point.value);
    expect(at0).toEqual([1, 0]);
  });

  it("turns EQ and filter into dB and cutoffs", () => {
    const sweep = previewSchedule(transitionFromRecipe("filter-sweep", PLACE), GRIDS);
    expect(pointValueAt(sweep.incoming.lowDb, 1)).toBe(KILL_DB);
    expect(pointValueAt(sweep.outgoing.highPassHz, -5)).toBe(10);
    expect(pointValueAt(sweep.outgoing.highPassHz, 31)).toBeGreaterThan(5000);
    expect(pointValueAt(sweep.outgoing.lowPassHz, 31)).toBe(FILTER_OPEN_LOW_PASS_HZ);
  });

  it("sends the echo after the fader, with its length in seconds", () => {
    const echo = previewSchedule(transitionFromRecipe("echo-out", PLACE), GRIDS);
    expect(echo.outgoing.echoDelaySec).toBe(0.5);
    expect(pointValueAt(echo.outgoing.echoSend, 1)).toBe(1);
    expect(pointValueAt(echo.outgoing.echoSend, 9)).toBe(0);
    expect(echo.incoming.echoDelaySec).toBeNull();
  });

  it("repeats a loop's bar while it holds, then plays on from where the loop was", () => {
    const transition = transitionFromRecipe("loop-to-extend", PLACE);
    const schedule = previewSchedule(transition, GRIDS);
    const loopStart = secondsAtBeat(GRIDS.outgoing, 64);
    expect(schedule.outgoing.segments.slice(0, 3)).toEqual([
      { startBeat: -32, endBeat: 0, offsetSec: secondsAtBeat(GRIDS.outgoing, 32) },
      { startBeat: 0, endBeat: 4, offsetSec: loopStart },
      { startBeat: 4, endBeat: 8, offsetSec: loopStart },
    ]);
    // 8 repeats of the bar over 32 beats, then on from the bar after the loop's start (32 % 4 = 0: its start).
    expect(schedule.outgoing.segments).toHaveLength(1 + 8 + 1);
    expect(schedule.outgoing.segments.at(-1)).toEqual({ startBeat: 32, endBeat: 64, offsetSec: loopStart });
  });

  it("rides the incoming track's tempo from the tempo lane", () => {
    const ride = previewSchedule(transitionFromRecipe("tempo-ride", PLACE), GRIDS);
    expect(pointValueAt(ride.incoming.rate, 10)).toBeCloseTo(0.96);
    expect(pointValueAt(ride.incoming.rate, 96)).toBeCloseTo(1);
  });

  it("starts no earlier than the outgoing track does", () => {
    const early: Transition = transitionFromRecipe("crossfade-8", { ...PLACE, outgoingAt: { bar: 3, beat: 1 } });
    const schedule = previewSchedule(early, GRIDS);
    expect(schedule.fromBeat).toBe(-8);
    expect(schedule.outgoing.segments[0]?.offsetSec).toBeCloseTo(0.1);
  });
});
