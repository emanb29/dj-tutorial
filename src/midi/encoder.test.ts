import { describe, expect, it } from "vitest";
import { ALL_LEDS, allLedsOff, ledMessages, levelMeterMessage, levelMeterValue, trackLoadedMessage } from "./encoder.ts";

describe("LED messages (MIDI-OUT column of the list)", () => {
  it("lights PLAY and CUE on both layers, so holding SHIFT does not darken them", () => {
    expect(ledMessages("A.play", true)).toEqual([
      [0x90, 0x0b, 0x7f],
      [0x90, 0x0e, 0x7f],
    ]);
    expect(ledMessages("B.cue", false)).toEqual([
      [0x91, 0x0c, 0x00],
      [0x91, 0x48, 0x00],
    ]);
  });

  it("puts BEAT SYNC on its own address and Master Tempo on BEAT SYNC's SHIFT layer", () => {
    expect(ledMessages("A.sync", true)).toEqual([[0x90, 0x58, 0x7f]]);
    expect(ledMessages("B.master-tempo", true)).toEqual([[0x91, 0x60, 0x7f]]);
  });

  it("lights channel CUE, the loop buttons and the HOT CUE mode button", () => {
    expect(ledMessages("B.headphone-cue", true)).toEqual([
      [0x91, 0x54, 0x7f],
      [0x91, 0x68, 0x7f],
    ]);
    expect(ledMessages("A.loop-in", true)).toEqual([
      [0x90, 0x10, 0x7f],
      [0x90, 0x4c, 0x7f],
    ]);
    expect(ledMessages("A.loop-out", false)).toEqual([
      [0x90, 0x11, 0x00],
      [0x90, 0x4e, 0x00],
    ]);
    expect(ledMessages("B.pad-mode-hot-cue", true)).toEqual([[0x91, 0x1b, 0x7f]]);
  });

  it("lights a hot cue pad on its own and its SHIFT channel", () => {
    expect(ledMessages("A.pad-1", true)).toEqual([
      [0x97, 0x00, 0x7f],
      [0x98, 0x00, 0x7f],
    ]);
    expect(ledMessages("B.pad-8", true)).toEqual([
      [0x99, 0x07, 0x7f],
      [0x9a, 0x07, 0x7f],
    ]);
  });

  it("sends Beat FX ON as NOTE ON (blinking) when on and NOTE OFF value (lit) when off", () => {
    expect(ledMessages("fx-on", true)).toEqual([[0x94, 0x47, 0x7f]]);
    expect(ledMessages("fx-on", false)).toEqual([[0x94, 0x47, 0x00]]);
  });

  it("can turn every LED off", () => {
    const off = allLedsOff();
    expect(off.length).toBeGreaterThanOrEqual(ALL_LEDS.length);
    expect(off.every((message) => message[2] === 0)).toBe(true);
    expect(off).toContainEqual([0xb0, 0x02, 0x00]);
    expect(off).toContainEqual([0xb1, 0x02, 0x00]);
  });
});

describe("level meters (Bn 02)", () => {
  it("uses one value per LED step: off, green 1, green 2, orange 1, orange 2, red", () => {
    expect(levelMeterValue(0)).toBe(0);
    expect(levelMeterValue(0.1)).toBe(0x26);
    expect(levelMeterValue(0.35)).toBe(0x41);
    expect(levelMeterValue(0.6)).toBe(0x57);
    expect(levelMeterValue(0.85)).toBe(0x65);
    expect(levelMeterValue(1)).toBe(0x77);
  });

  it("addresses each deck's meter", () => {
    expect(levelMeterMessage("A", 1)).toEqual([0xb0, 0x02, 0x77]);
    expect(levelMeterMessage("B", 0)).toEqual([0xb1, 0x02, 0x00]);
  });
});

describe("track-load illumination", () => {
  it("flashes the jog ring of a deck", () => {
    expect(trackLoadedMessage("A")).toEqual([0x9f, 0x00, 0x7f]);
    expect(trackLoadedMessage("B")).toEqual([0x9f, 0x01, 0x7f]);
  });
});
