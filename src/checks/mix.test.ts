import { describe, expect, it } from "vitest";
import { MUSIC, SILENT, attempt, channel, event, frames, playing } from "./testing/synthetic.ts";
import { audibleSpans, channelGainDb, entryTime, exitTime, isAudible } from "./mix.ts";

const window = { from: 0, to: 40 };

/** Deck A plays from 0, fader open; deck B plays from 10 and its fader opens at `bOpenAt`. */
function twoDecks(bOpenAt: number, aCloseAt: number) {
  return attempt({
    decks: {
      A: { trackId: "track-a", playhead: { segments: playing(0) } },
      B: { trackId: "track-b", playhead: { segments: playing(10) } },
    },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    events: [event(bOpenAt, "channelFader", 1, "B"), event(aCloseAt, "channelFader", 0, "A")],
    meters: {
      master: frames(0, 40, () => MUSIC),
      A: frames(0, 40, () => MUSIC),
      B: frames(0, 40, (t) => (t >= 10 ? MUSIC : SILENT)),
    },
  });
}

describe("channel gain", () => {
  it("is the fader curve plus the crossfader curve", () => {
    const recorded = twoDecks(20, 30);

    expect(channelGainDb(recorded, "A", 5)).toBeCloseTo(0);
    expect(channelGainDb(recorded, "B", 5)).toBe(-120);
    expect(
      channelGainDb(attempt({ initialMixer: { A: channel({ channelFader: 0.5 }), B: channel(), crossfader: 0.5 } }), "A", 0),
    ).toBeCloseTo(-12.04, 2);
  });
});

describe("audibility", () => {
  it("needs the deck playing, its gain above −24 dB and its channel above −40 LUFS", () => {
    const recorded = twoDecks(20, 30);

    expect(isAudible(recorded, "A", 5)).toBe(true);
    expect(isAudible(recorded, "B", 15)).toBe(false); // playing, cued, fader down
    expect(isAudible(recorded, "B", 25)).toBe(true);
    expect(isAudible(recorded, "A", 35)).toBe(false);
  });

  it("does not count a playing deck whose channel is in a silent breakdown", () => {
    const recorded = attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
      meters: { master: frames(0, 10, () => SILENT), A: frames(0, 10, () => SILENT) },
    });

    expect(isAudible(recorded, "A", 5)).toBe(false);
  });

  it("does not reuse a stale meter level across a gap in the meter stream", () => {
    const recorded = attempt({
      decks: { A: { trackId: "track-a", playhead: { segments: playing(0) } } },
      initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
      meters: { master: frames(0, 10, () => MUSIC), A: frames(0, 2, () => MUSIC) },
    });

    expect(isAudible(recorded, "A", 1)).toBe(true);
    expect(isAudible(recorded, "A", 5)).toBe(false);
  });

  it("lists maximal audible spans on the master frame clock", () => {
    const spans = audibleSpans(twoDecks(20, 30), "B", window);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBeCloseTo(20);
    expect(spans[0]?.to).toBeCloseTo(40);
  });
});

describe("entry and exit", () => {
  it("are the first audible frame and the frame the deck stops being audible", () => {
    const recorded = twoDecks(20, 30);

    expect(entryTime(recorded, "B", window)).toBeCloseTo(20);
    expect(exitTime(recorded, "A", window)).toBeCloseTo(30);
  });

  it("time a slow fader drag from its start (10% of travel), not when it becomes audible", () => {
    const drag = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.5, 1].map((value, index) =>
      event(20 + index * 0.1, "channelFader", value, "B"),
    );
    const recorded = { ...twoDecks(99, 30), events: [...drag, event(30, "channelFader", 0, "A")] };

    expect(entryTime(recorded, "B", window)).toBeCloseTo(20.1);
  });

  it("never put the entry before the deck starts playing, even when the fader opened just before Play", () => {
    const recorded = { ...twoDecks(99, 30), events: [event(9.9, "channelFader", 1, "B"), event(30, "channelFader", 0, "A")] };

    expect(entryTime(recorded, "B", window)).toBeCloseTo(10);
  });

  it("are null when the deck never comes in or never leaves", () => {
    const recorded = twoDecks(99, 99);

    expect(entryTime(recorded, "B", window)).toBeNull();
    expect(exitTime(recorded, "A", window)).toBeNull();
  });
});
