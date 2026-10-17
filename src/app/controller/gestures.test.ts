import { describe, expect, it } from "vitest";
import {
  commandFor,
  continuousSpec,
  dragValue,
  faderTravelPx,
  FULL_TRAVEL_PX,
  nudgeValue,
  wheelTravelPx,
  wheelValue,
} from "./gestures.ts";

const trim = continuousSpec("A.trim");
const channelFader = continuousSpec("B.channel-fader");
const tempo = continuousSpec("A.tempo");

describe("commandFor", () => {
  it("maps deck knobs and faders to their engine commands", () => {
    expect(commandFor("A.trim", 0.25)).toEqual({ control: "trim", deck: "A", value: 0.25 });
    expect(commandFor("B.eq-low", -1)).toEqual({ control: "eq-low", deck: "B", value: -1 });
    expect(commandFor("B.filter", 0.5)).toEqual({ control: "filter", deck: "B", value: 0.5 });
    expect(commandFor("A.channel-fader", 0)).toEqual({ control: "channel-fader", deck: "A", value: 0 });
    expect(commandFor("B.tempo", -0.4)).toEqual({ control: "tempo", deck: "B", value: -0.4 });
  });

  it("maps mixer-wide controls to their engine commands", () => {
    expect(commandFor("crossfader", 0.5)).toEqual({ control: "crossfader", value: 0.5 });
    expect(commandFor("master-level", 0)).toEqual({ control: "master-level", value: 0 });
    expect(commandFor("cue-mix", 1)).toEqual({ control: "cue-mix", value: 1 });
  });

  it("sends the headphone level to the engine's monitor output", () => {
    expect(commandFor("headphone-level", 0.3)).toEqual({ control: "headphone-level", value: 0.3 });
  });
});

describe("continuousSpec", () => {
  it("gives centred knobs a -1…1 range that resets to the centre", () => {
    expect(trim).toMatchObject({ min: -1, max: 1, resetValue: 0, centreDetent: true });
  });

  it("resets the channel fader fully open and the crossfader to the centre", () => {
    expect(channelFader).toMatchObject({ min: 0, max: 1, resetValue: 1, centreDetent: false });
    expect(continuousSpec("crossfader")).toMatchObject({ min: 0, max: 1, resetValue: 0.5 });
  });

  it("puts the tempo fader's fast end at the bottom, as on the hardware", () => {
    expect(tempo).toMatchObject({ min: -1, max: 1, resetValue: 0, inverted: true });
  });
});

describe("dragValue", () => {
  const knob = { fine: false, fullTravelPx: FULL_TRAVEL_PX };

  it("moves a full range over the full travel", () => {
    expect(dragValue(channelFader, 0, FULL_TRAVEL_PX, knob)).toBe(1);
    expect(dragValue(channelFader, 1, -FULL_TRAVEL_PX / 2, knob)).toBe(0.5);
  });

  it("clamps at the ends", () => {
    expect(dragValue(channelFader, 0.9, FULL_TRAVEL_PX, knob)).toBe(1);
    expect(dragValue(trim, -0.9, -FULL_TRAVEL_PX, knob)).toBe(-1);
  });

  it("moves five times less with fine adjust", () => {
    expect(dragValue(channelFader, 0, FULL_TRAVEL_PX, { ...knob, fine: true })).toBeCloseTo(0.2, 10);
  });

  it("catches a centred knob at the centre when it passes close by", () => {
    expect(dragValue(trim, 0.5, -FULL_TRAVEL_PX * 0.245, knob)).toBe(0);
  });

  it("does not catch at the centre with fine adjust, so tiny offsets stay reachable", () => {
    expect(dragValue(trim, 0, FULL_TRAVEL_PX * 0.025, { ...knob, fine: true })).toBeCloseTo(0.01, 10);
  });

  it("speeds up the tempo fader when dragged down", () => {
    expect(dragValue(tempo, 0, -FULL_TRAVEL_PX / 4, knob)).toBe(0.5);
  });

  describe("over a fader's own track, so the cap stays under the finger", () => {
    // A phone's channel fader: the cap travels 120 px between the ends of its track.
    const track = { fine: false, fullTravelPx: 120 };

    it("sweeps the whole range over the track's length", () => {
      expect(dragValue(channelFader, 0, 120, track)).toBe(1);
      expect(dragValue(channelFader, 1, -120, track)).toBe(0);
    });

    it("moves the value by the fraction of the track the finger travelled", () => {
      expect(dragValue(channelFader, 0, 30, track)).toBeCloseTo(0.25, 10);
      expect(dragValue(continuousSpec("crossfader"), 0, 90, track)).toBeCloseTo(0.75, 10);
    });

    it("moves the tempo fader end to end over its track, faster towards you", () => {
      expect(dragValue(tempo, -1, -120, track)).toBe(1);
      expect(dragValue(tempo, 0, 60, track)).toBe(-1);
    });

    it("keeps Shift as fine adjust, five times slower than the cap", () => {
      expect(dragValue(tempo, 0, -60, { ...track, fine: true })).toBeCloseTo(0.2, 10);
    });
  });
});

describe("faderTravelPx", () => {
  it("is the length of the track the cap moves along", () => {
    expect(faderTravelPx(120)).toBe(120);
    expect(faderTravelPx(292)).toBe(292);
  });

  it("falls back to the knob travel when the track has no usable length (not laid out yet)", () => {
    expect(faderTravelPx(0)).toBe(FULL_TRAVEL_PX);
    expect(faderTravelPx(Number.NaN)).toBe(FULL_TRAVEL_PX);
    expect(faderTravelPx(4)).toBe(FULL_TRAVEL_PX);
  });
});

describe("wheelTravelPx", () => {
  it("raises a control when the fingers move up with natural scrolling", () => {
    expect(wheelTravelPx({ deltaX: 0, deltaY: 10, deltaMode: 0 }, { natural: true })).toBe(10);
  });

  it("raises a control when a classic mouse wheel rolls up", () => {
    expect(wheelTravelPx({ deltaX: 0, deltaY: -100, deltaMode: 0 }, { natural: false })).toBe(100);
  });

  it("uses the sideways part when it is larger, rightwards meaning up", () => {
    expect(wheelTravelPx({ deltaX: -12, deltaY: 2, deltaMode: 0 }, { natural: true })).toBe(12);
  });

  it("scales line-mode deltas to pixels", () => {
    expect(wheelTravelPx({ deltaX: 0, deltaY: -3, deltaMode: 1 }, { natural: false })).toBe(48);
  });
});

describe("wheelValue", () => {
  it("moves by travel like a drag", () => {
    expect(wheelValue(channelFader, 0.5, FULL_TRAVEL_PX / 4, { fine: false })).toBe(0.75);
  });
});

describe("nudgeValue", () => {
  it("steps a fiftieth of the range per arrow press", () => {
    expect(nudgeValue(channelFader, 0.5, "ArrowUp", { fine: false })).toBeCloseTo(0.52, 10);
    expect(nudgeValue(channelFader, 0.5, "ArrowLeft", { fine: false })).toBeCloseTo(0.48, 10);
  });

  it("steps a five-hundredth with fine adjust", () => {
    expect(nudgeValue(channelFader, 0.5, "ArrowRight", { fine: true })).toBeCloseTo(0.502, 10);
  });

  it("steps a tenth per page key", () => {
    expect(nudgeValue(trim, 0, "PageUp", { fine: false })).toBeCloseTo(0.2, 10);
  });

  it("jumps to the ends with Home and End", () => {
    expect(nudgeValue(trim, 0.3, "Home", { fine: false })).toBe(-1);
    expect(nudgeValue(trim, 0.3, "End", { fine: false })).toBe(1);
  });

  it("moves the tempo fader the way the arrow points", () => {
    expect(nudgeValue(tempo, 0, "ArrowDown", { fine: false })).toBeCloseTo(0.04, 10);
  });

  it("ignores other keys", () => {
    expect(nudgeValue(trim, 0, "KeyA", { fine: false })).toBeNull();
  });
});
