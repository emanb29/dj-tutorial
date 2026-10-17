import { describe, expect, it } from "vitest";
import { BAR, BEAT, PHRASE, event, grid, playing } from "./testing/synthetic.ts";
import {
  beatPhase,
  beatSeconds,
  controlValueAt,
  faderGestureStart,
  firstPlayStart,
  heardBeats,
  isPlaying,
  positionAt,
} from "./timeline.ts";

describe("playhead model", () => {
  const model = { segments: [...playing(10, 0, 20), { fromCtx: 30, pos: 10, rate: 1.02 }] };

  it("is stopped before its first segment", () => {
    expect(positionAt(model, 5)).toBeNull();
    expect(isPlaying(model, 5)).toBe(false);
  });

  it("integrates the rate from the segment start", () => {
    expect(positionAt(model, 15)).toBeCloseTo(5);
    expect(positionAt(model, 25)).toBeCloseTo(10);
    expect(isPlaying(model, 25)).toBe(false);
    expect(positionAt(model, 40)).toBeCloseTo(10 + 10 * 1.02);
  });

  it("finds the first moment the deck starts playing at or after a time", () => {
    expect(firstPlayStart(model, 0)).toBe(10);
    expect(firstPlayStart(model, 11)).toBe(30);
    expect(firstPlayStart(model, 31)).toBeNull();
  });
});

describe("beats", () => {
  const model = { segments: playing(10, 0) };

  it("gives the beat phase and heard beat length at the deck's tempo", () => {
    expect(beatPhase(model, grid(), 10 + 3.25 * BEAT)).toBeCloseTo(3.25);
    expect(beatSeconds(model, grid(), 12)).toBeCloseTo(BEAT);
    expect(beatSeconds({ segments: playing(0, 0, undefined, 2) }, grid(), 1)).toBeCloseTo(BEAT / 2);
  });

  it("lists the beats heard in a span, with downbeats marked", () => {
    const beats = heardBeats(model, grid({ downbeatIndex: 1 }), { from: 10, to: 10 + BAR });

    expect(beats.map((beat) => beat.ctx)).toEqual([10, 10.5, 11, 11.5]);
    expect(beats.map((beat) => beat.isDownbeat)).toEqual([false, true, false, false]);
  });

  it("lists no beats while paused", () => {
    expect(heardBeats({ segments: playing(10, 0, 11) }, grid(), { from: 10, to: 20 })).toHaveLength(2);
    expect(PHRASE).toBe(16);
  });
});

describe("mixer state from events", () => {
  const events = [event(5, "channelFader", 0.5, "A"), event(6, "channelFader", 1, "A"), event(7, "trim", -3, "A")];

  it("holds the initial value until the first event, then the latest value", () => {
    expect(controlValueAt(events, "channelFader", "A", 4, 0)).toBe(0);
    expect(controlValueAt(events, "channelFader", "A", 5, 0)).toBe(0.5);
    expect(controlValueAt(events, "channelFader", "A", 9, 0)).toBe(1);
    expect(controlValueAt(events, "channelFader", "B", 9, 0.2)).toBe(0.2);
  });
});

describe("fader gesture start (judged on intent)", () => {
  it("times a drag from the moment it crosses 10% of travel", () => {
    const events = [0.05, 0.12, 0.3, 0.6, 1].map((value, index) => event(10 + index * 0.05, "channelFader", value, "B"));

    expect(faderGestureStart(events, "channelFader", "B", 10.2, 0)).toBeCloseTo(10.05);
  });

  it("times a keyboard cut (one snap) from the snap", () => {
    expect(faderGestureStart([event(12, "channelFader", 0, "A")], "channelFader", "A", 12, 1)).toBe(12);
  });

  it("treats a pause of more than 250 ms as the start of a new gesture", () => {
    const events = [event(10, "channelFader", 0.2, "B"), event(11, "channelFader", 0.25, "B"), event(11.05, "channelFader", 0.5, "B")];

    expect(faderGestureStart(events, "channelFader", "B", 11.05, 0)).toBeCloseTo(11.05);
  });

  it("returns null when no fader movement leads up to the time", () => {
    expect(faderGestureStart([], "channelFader", "B", 11, 0)).toBeNull();
    expect(faderGestureStart([event(5, "channelFader", 1, "B")], "channelFader", "B", 11, 0)).toBeNull();
  });
});
