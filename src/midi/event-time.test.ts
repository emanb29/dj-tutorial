import { describe, expect, it } from "vitest";
import { MIDI_STAMP_MAX_AGE_MS, midiEventTime } from "./event-time.ts";

// Realistic values: a page open for ten minutes, so performance.now() is about 600 000 ms.
const NOW = 600_123.4;

describe("midiEventTime", () => {
  it("keeps Chrome's stamp when it is the message's arrival, a few ms before the handler", () => {
    expect(midiEventTime(NOW - 3.2, NOW)).toEqual({ kind: "stamped", timeMs: NOW - 3.2 });
  });

  it("keeps a stamp from a long main-thread stall, which is truer than the handler's time", () => {
    expect(midiEventTime(NOW - 400, NOW)).toEqual({ kind: "stamped", timeMs: NOW - 400 });
  });

  it("uses the handler's time for a stamp of 0 (a CoreMIDI packet stamped 'now', or before the time origin)", () => {
    expect(midiEventTime(0, NOW)).toEqual({ kind: "handler-time", timeMs: NOW, offsetMs: -NOW });
  });

  it("uses the handler's time for a stamp on another clock: epoch milliseconds, or NaN", () => {
    const epoch = 1_792_000_000_000;
    expect(midiEventTime(epoch, NOW)).toEqual({ kind: "handler-time", timeMs: NOW, offsetMs: epoch - NOW });
    expect(midiEventTime(Number.NaN, NOW).timeMs).toBe(NOW);
  });

  it("uses the handler's time for a stamp too old or in the future", () => {
    expect(midiEventTime(NOW - MIDI_STAMP_MAX_AGE_MS - 1, NOW).kind).toBe("handler-time");
    expect(midiEventTime(NOW + 50, NOW).kind).toBe("handler-time");
  });
});
