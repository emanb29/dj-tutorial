import { describe, expect, it } from "vitest";
import { PICKUP_TOLERANCE, SoftTakeover } from "./soft-takeover.ts";

describe("soft takeover (pickup)", () => {
  it("passes a move straight through once the hardware starts at the app's value", () => {
    const takeover = new SoftTakeover();
    expect(takeover.move("A.channel-fader", 0.01, 0)).toEqual({ kind: "send", value: 0.01 });
    expect(takeover.move("A.channel-fader", 0.5, 0.01)).toEqual({ kind: "send", value: 0.5 });
  });

  it("waits, without moving the value, while the hardware is away from it", () => {
    const takeover = new SoftTakeover();
    expect(takeover.move("A.channel-fader", 0.9, 0.2)).toEqual({ kind: "waiting", hardware: 0.9 });
    expect(takeover.move("A.channel-fader", 0.7, 0.2)).toEqual({ kind: "waiting", hardware: 0.7 });
  });

  it("catches when the hardware comes within the tolerance", () => {
    const takeover = new SoftTakeover();
    takeover.move("trim", 0.9, 0.5);
    expect(takeover.move("trim", 0.5 + PICKUP_TOLERANCE / 2, 0.5)).toEqual({ kind: "send", value: 0.5 + PICKUP_TOLERANCE / 2 });
  });

  it("catches when a fast move jumps across the value between two messages", () => {
    const takeover = new SoftTakeover();
    takeover.move("crossfader", 0.9, 0.5);
    expect(takeover.move("crossfader", 0.1, 0.5)).toEqual({ kind: "send", value: 0.1 });
  });

  it("lets go again when something else (the screen, a Lesson) moves the value away", () => {
    const takeover = new SoftTakeover();
    takeover.move("A.tempo", 0.5, 0.5);
    expect(takeover.status("A.tempo", 0.5)).toEqual({ caught: true, hardware: 0.5 });
    expect(takeover.status("A.tempo", 0.8)).toEqual({ caught: false, hardware: 0.5 });
    expect(takeover.move("A.tempo", 0.52, 0.8)).toEqual({ kind: "waiting", hardware: 0.52 });
    expect(takeover.move("A.tempo", 0.81, 0.8)).toEqual({ kind: "send", value: 0.81 });
  });

  it("knows nothing about a control the hardware has not moved yet", () => {
    expect(new SoftTakeover().status("trim", 0.5)).toEqual({ caught: false, hardware: null });
  });

  it("keeps each control on its own", () => {
    const takeover = new SoftTakeover();
    takeover.move("A.trim", 0.5, 0.5);
    expect(takeover.move("B.trim", 0.9, 0.5)).toEqual({ kind: "waiting", hardware: 0.9 });
    expect(takeover.move("A.trim", 0.9, 0.5)).toEqual({ kind: "send", value: 0.9 });
  });

  it("forgets everything on reset (a new controller, or a reconnect)", () => {
    const takeover = new SoftTakeover();
    takeover.move("A.trim", 0.5, 0.5);
    takeover.reset();
    expect(takeover.move("A.trim", 0.9, 0.5)).toEqual({ kind: "waiting", hardware: 0.9 });
  });
});
