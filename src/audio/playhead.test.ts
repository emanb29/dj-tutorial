import { describe, expect, it } from "vitest";
import { PlayheadTracker } from "./playhead.ts";

// Loops in the playhead model: the position wraps from the loop's end back to its start, exactly where
// the audio does, and the recorded segments stay in the contract's shape (a wrap is a jump back).

function playingFrom(ctx: number, pos: number, rate = 1): PlayheadTracker {
  const tracker = new PlayheadTracker({ durationSec: 60 });
  tracker.seek(ctx, pos);
  tracker.setRate(ctx, rate);
  return tracker;
}

describe("PlayheadTracker loops", () => {
  it("wraps the position from the loop's end to its start, pass after pass", () => {
    const tracker = playingFrom(0, 10);
    expect(tracker.setLoop(1, { start: 10, end: 12 })).toEqual({ ok: true });

    expect(tracker.positionAt(1.5)).toBeCloseTo(11.5, 12);
    expect(tracker.positionAt(2)).toBeCloseTo(10, 12);
    expect(tracker.positionAt(2.5)).toBeCloseTo(10.5, 12);
    expect(tracker.positionAt(9.25)).toBeCloseTo(11.25, 12);
    expect(tracker.loop()).toEqual({ start: 10, end: 12 });
  });

  it("follows the playback rate inside the loop", () => {
    const tracker = playingFrom(0, 10, 2);
    tracker.setLoop(0, { start: 10, end: 12 });
    // At rate 2 a 2 s loop lasts 1 s.
    expect(tracker.positionAt(1)).toBeCloseTo(10, 12);
    expect(tracker.positionAt(1.25)).toBeCloseTo(10.5, 12);
  });

  it("jumps back at once when the loop ends behind the playhead (LOOP OUT heard earlier than applied)", () => {
    const tracker = playingFrom(0, 10);
    // At 2.1 s the deck is at 12.1, past the out point 12: it continues where a wrap at 12 would be.
    tracker.setLoop(2.1, { start: 10, end: 12 });
    expect(tracker.positionAt(2.1)).toBeCloseTo(10.1, 12);
    expect(tracker.positionAt(3.9)).toBeCloseTo(11.9, 12);
    expect(tracker.positionAt(4)).toBeCloseTo(10, 12);
  });

  it("lets the deck play into a loop that starts ahead of it", () => {
    const tracker = playingFrom(0, 9.8);
    tracker.setLoop(0, { start: 10, end: 11 });
    expect(tracker.positionAt(0.1)).toBeCloseTo(9.9, 12);
    expect(tracker.positionAt(1.15)).toBeCloseTo(10.95, 9);
    expect(tracker.positionAt(1.3)).toBeCloseTo(10.1, 9);
  });

  it("plays straight on from where the loop was after it ends", () => {
    const tracker = playingFrom(0, 10);
    tracker.setLoop(0, { start: 10, end: 12 });
    tracker.setLoop(5, null);
    // At 5 s the loop had wrapped twice: 10 + (5 − 4) = 11, then straight on.
    expect(tracker.positionAt(5)).toBeCloseTo(11, 12);
    expect(tracker.positionAt(7)).toBeCloseTo(13, 12);
    expect(tracker.loop()).toBeNull();
  });

  it("records each wrap as a jump back, so the segments are the contract's plain model", () => {
    const tracker = playingFrom(0, 10);
    tracker.setLoop(1, { start: 10, end: 12 });
    tracker.setLoop(5, null);

    expect(tracker.segments()).toEqual([
      { fromCtx: 0, pos: 10, rate: 1 },
      { fromCtx: 1, pos: 11, rate: 1 },
      { fromCtx: 2, pos: 10, rate: 1 },
      { fromCtx: 4, pos: 10, rate: 1 },
      { fromCtx: 5, pos: 11, rate: 1 },
    ]);
  });

  it("adds the wraps of a loop still running up to a time asked for, without changing the model", () => {
    const tracker = playingFrom(0, 10);
    tracker.setLoop(0, { start: 10, end: 12 });

    expect(tracker.segments(5).map((segment) => segment.fromCtx)).toEqual([0, 2, 4]);
    expect(tracker.segments().map((segment) => segment.fromCtx)).toEqual([0]);
    // A change later than those wraps is still accepted, and they become part of the model.
    expect(tracker.setRate(5, 0)).toEqual({ ok: true });
    expect(tracker.segments().map((segment) => [segment.fromCtx, segment.pos])).toEqual([
      [0, 10],
      [2, 10],
      [4, 10],
      [5, 11],
    ]);
  });

  it("keeps the loop while paused, and loops again from where it stopped", () => {
    const tracker = playingFrom(0, 10);
    tracker.setLoop(0, { start: 10, end: 12 });
    tracker.setRate(3, 0);
    expect(tracker.positionAt(10)).toBeCloseTo(11, 12);
    tracker.setRate(10, 1);
    expect(tracker.positionAt(11)).toBeCloseTo(10, 12);
  });

  it("ends the loop when the deck seeks", () => {
    const tracker = playingFrom(0, 10);
    tracker.setLoop(0, { start: 10, end: 12 });
    tracker.seek(3, 30);
    expect(tracker.loop()).toBeNull();
    expect(tracker.positionAt(5)).toBeCloseTo(32, 12);
  });

  it("refuses a loop that is not a span of the track", () => {
    const tracker = playingFrom(0, 10);
    expect(tracker.setLoop(1, { start: 12, end: 12 })).toMatchObject({ ok: false, error: { kind: "value-out-of-range", control: "loop" } });
    expect(tracker.setLoop(1, { start: 59, end: 61 })).toMatchObject({ ok: false, error: { kind: "value-out-of-range", control: "loop" } });
    expect(tracker.loop()).toBeNull();
  });
});
