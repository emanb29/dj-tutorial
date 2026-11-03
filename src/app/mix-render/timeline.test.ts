import { describe, expect, it } from "vitest";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import type { MixPlan, PlanGrid } from "@shared/mix-plan.ts";
import { bpmAtBeat, secAtBeat, SET_TAIL_SEC, setTimeline, type SetTimeline } from "./timeline.ts";

function timelineOf(plan: MixPlan, grids: readonly PlanGrid[]): SetTimeline {
  const outcome = setTimeline(plan, grids);
  if (!outcome.ok) throw new Error(outcome.problems.map((each) => each.message).join(" "));
  return outcome.timeline;
}

/** Where a track is heard at a set time, from its pieces. */
function trackSecAt(timeline: SetTimeline, track: number, sec: number): number | null {
  const piece = timeline.tracks[track]?.pieces.find((each) => each.fromSec <= sec && sec < each.toSec);
  return piece === undefined ? null : piece.trackSec + (sec - piece.fromSec) * piece.rate;
}

describe("setTimeline", () => {
  it("plays two tracks at one tempo: the Transition starts where the outgoing track reaches it, and each track stops when it should", () => {
    // 120 BPM, bar 1 at 0.1 s, 5 minutes: a 16-bar crossfade on the last phrase it fits, bar 129 (256.1 s into track 1).
    const { plan } = testPlan(2);
    const timeline = timelineOf(plan, [testGrid(), testGrid()]);
    const [first, second] = timeline.tracks;
    const [transition] = timeline.transitions;

    expect(first).toMatchObject({ index: 0, deck: "A", enterSec: 0 });
    expect(second).toMatchObject({ index: 1, deck: "B" });
    expect(transition?.startSec).toBeCloseTo(256, 9);
    expect(second?.enterSec).toBeCloseTo(256, 9);
    // 64 beats at 120 BPM; the outgoing track is silent by then, so it stops just after.
    expect(transition?.endSec).toBeCloseTo(288, 9);
    expect(first?.stopSec).toBeCloseTo(288.05, 9);
    // The incoming track plays from bar 1 to its end.
    expect(second?.pieces).toEqual([{ fromSec: 256, toSec: expect.closeTo(555.9, 6) as number, trackSec: 0.1, rate: 1 }]);
    expect(timeline.durationSec).toBeCloseTo(555.9 + SET_TAIL_SEC, 6);
    expect(trackSecAt(timeline, 0, 10)).toBeCloseTo(10.1, 9);
  });

  it("matches the incoming track to the outgoing track's heard tempo, and keeps it there afterwards", () => {
    const grids = [testGrid(), testGrid({ bpm: 125 })];
    const { plan } = testPlan(2, { grid: (index) => grids[index] ?? testGrid() });
    const timeline = timelineOf(plan, grids);
    const incoming = timeline.tracks[1];
    expect(incoming?.pieces).toHaveLength(1);
    expect(incoming?.pieces[0]?.rate).toBeCloseTo(120 / 125, 12);
    // Beat for beat: 64 beats of the incoming track take as long as 64 of the outgoing one.
    const transition = timeline.transitions[0];
    expect(transition).toBeDefined();
    if (transition === undefined || incoming === undefined) return;
    const incomingBeatsIn = ((trackSecAt(timeline, 1, transition.endSec - 1e-6) ?? 0) - 0.1) * (125 / 60);
    expect(incomingBeatsIn).toBeCloseTo(64, 4);
  });

  it("rides the incoming track back to its own tempo in a tempo ride, in quarter-beat steps", () => {
    const grids = [testGrid(), testGrid({ bpm: 126 })];
    const { plan } = testPlan(2, { recipe: "tempo-ride", grid: (index) => grids[index] ?? testGrid() });
    const timeline = timelineOf(plan, grids);
    const transition = timeline.transitions[0];
    const incoming = timeline.tracks[1];
    if (transition === undefined || incoming === undefined) throw new Error("expected a Transition and an incoming track");
    // 96 beats at the outgoing track's 120 BPM.
    expect(transition.endSec - transition.startSec).toBeCloseTo(48, 9);
    expect(bpmAtBeat(transition, 10, "incoming")).toBeCloseTo(120, 9);
    expect(bpmAtBeat(transition, 96, "incoming")).toBeGreaterThan(125.9);
    // Matched for the first two thirds, then rising to rate 1 by the end, and staying there.
    expect(incoming.pieces[0]?.rate).toBeCloseTo(120 / 126, 12);
    expect(incoming.pieces.at(-1)?.rate).toBeCloseTo(1, 2);
    const ridePieces = incoming.pieces.filter((piece) => piece.toSec > transition.startSec + 32 && piece.fromSec < transition.endSec);
    expect(ridePieces.length).toBeGreaterThan(100);
    // The pieces join up: no jumps in the track position.
    for (const [index, piece] of incoming.pieces.entries()) {
      const next = incoming.pieces[index + 1];
      if (next !== undefined) expect(next.trackSec).toBeCloseTo(piece.trackSec + (piece.toSec - piece.fromSec) * piece.rate, 9);
    }
  });

  it("holds a 1-bar loop on the outgoing track in a loop to extend, while the set clock runs on", () => {
    const { plan } = testPlan(2, { recipe: "loop-to-extend" });
    const timeline = timelineOf(plan, [testGrid(), testGrid()]);
    const transition = timeline.transitions[0];
    const outgoing = timeline.tracks[0];
    if (transition === undefined || outgoing === undefined) throw new Error("expected a Transition and an outgoing track");
    // 32 beats at 120 BPM is 16 s; the loop is 4 beats (2 s) from the Transition's start.
    expect(transition.endSec - transition.startSec).toBeCloseTo(16, 9);
    const loopStart = trackSecAt(timeline, 0, transition.startSec) ?? Number.NaN;
    for (const sec of [1, 3.5, 7.9, 15.9]) {
      const at = trackSecAt(timeline, 0, transition.startSec + sec) ?? Number.NaN;
      expect(at).toBeGreaterThanOrEqual(loopStart - 1e-9);
      expect(at).toBeLessThan(loopStart + 2);
      expect(at - loopStart).toBeCloseTo(sec % 2, 6);
    }
    // Eight times round: a piece per pass.
    expect(outgoing.pieces.filter((piece) => piece.fromSec >= transition.startSec - 1e-9)).toHaveLength(8);
  });

  it("lays out a 25-track set, alternating decks, each track starting where the one before hands over", () => {
    const { plan } = testPlan(25);
    const grids = Array.from({ length: 25 }, () => testGrid());
    const timeline = timelineOf(plan, grids);
    expect(timeline.tracks).toHaveLength(25);
    expect(timeline.transitions).toHaveLength(24);
    for (const [index, track] of timeline.tracks.entries()) {
      expect(track.deck).toBe(index % 2 === 0 ? "A" : "B");
      expect(track.stopSec).toBeGreaterThan(track.enterSec);
      const before = timeline.tracks[index - 2];
      // A deck is free again before its next track loads.
      if (before !== undefined) expect(before.stopSec).toBeLessThanOrEqual(track.enterSec + 1e-9);
    }
    // 24 hand-overs every 256 s, then the last track's 299.9 s.
    expect(timeline.durationSec).toBeCloseTo(24 * 256 + 299.9 + SET_TAIL_SEC, 6);
  });

  it("says when a track ends before its Transition starts", () => {
    const { plan } = testPlan(2);
    const outcome = setTimeline(plan, [testGrid({ durationSec: 200 }), testGrid()]);
    expect(outcome).toEqual({ ok: false, problems: [{ message: "Track 1 ends before Transition 1 starts.", fix: "Start the Transition earlier." }] });
  });

  it("says when a loop is left on, since the set would never reach the next Transition", () => {
    const { plan } = testPlan(3, { recipe: "crossfade-8" });
    const looped: MixPlan = {
      ...plan,
      transitions: plan.transitions.map((transition, index) =>
        index === 0 ? { ...transition, lanes: [...transition.lanes, { track: "incoming", param: "loop", keyframes: [{ beat: 8, value: 1, curve: "jump" }], loopBeats: 4 }] } : transition,
      ),
    };
    const outcome = setTimeline(looped, [testGrid(), testGrid(), testGrid()]);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? [] : outcome.problems.map((each) => each.message)).toEqual(["Track 2 is still looping when Transition 2 should start, so it never gets there."]);
  });
});

describe("secAtBeat", () => {
  it("is the Transition's start at beat 0 and its end at its length, and carries the tempo on outside it", () => {
    const { plan } = testPlan(2, { recipe: "cut-on-the-1" });
    const timing = timelineOf(plan, [testGrid(), testGrid()]).transitions[0];
    if (timing === undefined) throw new Error("expected a Transition");
    expect(secAtBeat(timing, 0)).toBe(timing.startSec);
    expect(secAtBeat(timing, 4)).toBeCloseTo(timing.endSec, 9);
    expect(secAtBeat(timing, -4)).toBeCloseTo(timing.startSec - 2, 9);
    expect(secAtBeat(timing, 8)).toBeCloseTo(timing.endSec + 2, 9);
    expect(transitionFromRecipe("cut-on-the-1", { outgoingAt: { bar: 1, beat: 1 }, incomingAt: { bar: 1, beat: 1 } }).lengthBeats).toBe(4);
  });
});
