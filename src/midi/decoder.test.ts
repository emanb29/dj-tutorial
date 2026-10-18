// Fixtures are byte-for-byte from AlphaTheta's "DDJ-FLX4 List of MIDI messages" Ver 1.0
// (docs/research/flx4-midi.md): each test names the row it comes from.

import { describe, expect, it } from "vitest";
import { Flx4Decoder, physicalControlOf } from "./decoder.ts";

const decode = (...messages: number[][]) => {
  const decoder = new Flx4Decoder();
  return messages.map((bytes) => decoder.decode(bytes));
};
const last = (...messages: number[][]) => decode(...messages).at(-1);

describe("deck buttons (1-1 … 1-10, 3-6)", () => {
  it("decodes PLAY/PAUSE press and release on each deck; release is note-on with velocity 0", () => {
    expect(decode([0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00], [0x91, 0x0b, 0x7f])).toEqual([
      { kind: "button", control: "play", deck: "A", shift: false, pressed: true },
      { kind: "button", control: "play", deck: "A", shift: false, pressed: false },
      { kind: "button", control: "play", deck: "B", shift: false, pressed: true },
    ]);
  });

  it("treats a real note-off as a release too", () => {
    expect(last([0x80, 0x0c, 0x40])).toEqual({ kind: "button", control: "cue", deck: "A", shift: false, pressed: false });
  });

  it("decodes the SHIFT layer of PLAY and CUE", () => {
    expect(last([0x91, 0x0e, 0x7f])).toEqual({ kind: "button", control: "play", deck: "B", shift: true, pressed: true });
    expect(last([0x90, 0x48, 0x7f])).toEqual({ kind: "button", control: "cue", deck: "A", shift: true, pressed: true });
  });

  it("decodes SHIFT, BEAT SYNC (and its long press and SHIFT layer) and channel CUE", () => {
    expect(last([0x90, 0x3f, 0x7f])).toMatchObject({ control: "shift", deck: "A", pressed: true });
    expect(last([0x91, 0x58, 0x7f])).toMatchObject({ control: "sync", deck: "B", shift: false });
    expect(last([0x90, 0x5c, 0x7f])).toMatchObject({ control: "sync-long", deck: "A" });
    expect(last([0x90, 0x60, 0x7f])).toMatchObject({ control: "sync", deck: "A", shift: true });
    expect(last([0x91, 0x54, 0x7f])).toMatchObject({ control: "headphone-cue", deck: "B", shift: false });
    expect(last([0x91, 0x68, 0x7f])).toMatchObject({ control: "headphone-cue", deck: "B", shift: true });
  });

  it("decodes the loop and call buttons with their SHIFT layers", () => {
    expect(last([0x90, 0x10, 0x7f])).toMatchObject({ control: "loop-in", shift: false });
    expect(last([0x90, 0x4c, 0x7f])).toMatchObject({ control: "loop-in", shift: true });
    expect(last([0x91, 0x11, 0x7f])).toMatchObject({ control: "loop-out", deck: "B", shift: false });
    expect(last([0x91, 0x4e, 0x7f])).toMatchObject({ control: "loop-out", deck: "B", shift: true });
    expect(last([0x90, 0x4d, 0x7f])).toMatchObject({ control: "loop-exit", shift: false });
    expect(last([0x90, 0x50, 0x7f])).toMatchObject({ control: "loop-exit", shift: true });
    expect(last([0x90, 0x51, 0x7f])).toMatchObject({ control: "call-back", shift: false });
    expect(last([0x90, 0x3e, 0x7f])).toMatchObject({ control: "call-back", shift: true });
    expect(last([0x90, 0x53, 0x7f])).toMatchObject({ control: "call-forward", shift: false });
    expect(last([0x90, 0x3d, 0x7f])).toMatchObject({ control: "call-forward", shift: true });
    // Deck B, on channel 2, and the release (note on, velocity 0).
    expect(last([0x91, 0x51, 0x7f])).toMatchObject({ control: "call-back", deck: "B", shift: false, pressed: true });
    expect(last([0x91, 0x53, 0x00])).toMatchObject({ control: "call-forward", deck: "B", shift: false, pressed: false });
    expect(last([0x91, 0x3e, 0x7f])).toMatchObject({ control: "call-back", deck: "B", shift: true });
  });

  it("decodes the pad-mode buttons; their SHIFT layer is the second mode", () => {
    expect(last([0x90, 0x1b, 0x7f])).toMatchObject({ kind: "button", control: "pad-mode", mode: "hot-cue", deck: "A" });
    expect(last([0x91, 0x69, 0x7f])).toMatchObject({ kind: "button", control: "pad-mode", mode: "keyboard", deck: "B" });
    expect(last([0x90, 0x1e, 0x7f])).toMatchObject({ mode: "pad-fx-1" });
    expect(last([0x90, 0x6b, 0x7f])).toMatchObject({ mode: "pad-fx-2" });
    expect(last([0x90, 0x20, 0x7f])).toMatchObject({ mode: "beat-jump" });
    expect(last([0x90, 0x6d, 0x7f])).toMatchObject({ mode: "beat-loop" });
    expect(last([0x90, 0x22, 0x7f])).toMatchObject({ mode: "sampler" });
    expect(last([0x90, 0x6f, 0x7f])).toMatchObject({ mode: "key-shift" });
  });

  it("names SHIFT + channel fader and crossfader start notes, which the app ignores", () => {
    expect(last([0x90, 0x66, 0x7f])).toMatchObject({ kind: "button", control: "fader-start", deck: "A" });
    expect(last([0x91, 0x52, 0x7f])).toMatchObject({ kind: "button", control: "fader-start", deck: "B" });
  });
});

describe("jog wheel (1-4)", () => {
  it("decodes platter turns as signed ticks from 0x40, in vinyl mode and out of it", () => {
    expect(last([0xb0, 0x22, 0x41])).toEqual({ kind: "jog-turn", deck: "A", surface: "platter", shift: false, ticks: 1 });
    expect(last([0xb1, 0x22, 0x3c])).toEqual({ kind: "jog-turn", deck: "B", surface: "platter", shift: false, ticks: -4 });
    expect(last([0xb0, 0x23, 0x43])).toEqual({ kind: "jog-turn", deck: "A", surface: "platter", shift: false, ticks: 3 });
  });

  it("decodes SHIFT + platter and the wheel side", () => {
    expect(last([0xb0, 0x29, 0x42])).toEqual({ kind: "jog-turn", deck: "A", surface: "platter", shift: true, ticks: 2 });
    expect(last([0xb1, 0x21, 0x3f])).toEqual({ kind: "jog-turn", deck: "B", surface: "side", shift: false, ticks: -1 });
  });

  it("decodes platter touch, with and without SHIFT", () => {
    expect(last([0x90, 0x36, 0x7f])).toEqual({ kind: "jog-touch", deck: "A", shift: false, touched: true });
    expect(last([0x91, 0x67, 0x00])).toEqual({ kind: "jog-touch", deck: "B", shift: true, touched: false });
  });
});

describe("14-bit faders and knobs (MSB, then LSB = cc + 0x20)", () => {
  it("emits nothing for an MSB alone, then the combined value on its LSB", () => {
    expect(decode([0xb0, 0x13, 0x40], [0xb0, 0x33, 0x00])).toEqual([
      null,
      { kind: "continuous", control: "channel-fader", deck: "A", raw: 0x40 << 7, value: (0x40 << 7) / 16383 },
    ]);
  });

  it("reads full scale as exactly 0 and 1", () => {
    expect(last([0xb6, 0x1f, 0x00], [0xb6, 0x3f, 0x00])).toMatchObject({ control: "crossfader", deck: null, value: 0 });
    expect(last([0xb6, 0x1f, 0x7f], [0xb6, 0x3f, 0x7f])).toMatchObject({ control: "crossfader", value: 1 });
  });

  it("keeps the MSB per control, so interleaved controls never mix", () => {
    const decoded = decode([0xb0, 0x04, 0x7f], [0xb1, 0x04, 0x00], [0xb0, 0x24, 0x7f], [0xb1, 0x24, 0x00]);
    expect(decoded[2]).toMatchObject({ control: "trim", deck: "A", value: 1 });
    expect(decoded[3]).toMatchObject({ control: "trim", deck: "B", value: 0 });
  });

  it("refines with the LSB while the MSB stays put (a slow move sends only LSBs)", () => {
    expect(last([0xb0, 0x00, 0x20], [0xb0, 0x20, 0x00], [0xb0, 0x20, 0x10])).toMatchObject({ control: "tempo", raw: (0x20 << 7) + 0x10 });
  });

  it("maps every 14-bit control in the list", () => {
    const pairs: [number, number, string, string | null][] = [
      [0xb0, 0x00, "tempo", "A"],
      [0xb1, 0x04, "trim", "B"],
      [0xb0, 0x07, "eq-high", "A"],
      [0xb0, 0x0b, "eq-mid", "A"],
      [0xb1, 0x0f, "eq-low", "B"],
      [0xb0, 0x13, "channel-fader", "A"],
      [0xb6, 0x08, "master-level", null],
      [0xb6, 0x17, "filter", "A"],
      [0xb6, 0x18, "filter", "B"],
      [0xb6, 0x1f, "crossfader", null],
      [0xb6, 0x05, "mic-level", null],
      [0xb6, 0x0c, "headphone-mix", null],
      [0xb6, 0x0d, "headphone-level", null],
      [0xb4, 0x02, "beat-fx-depth", null],
    ];
    for (const [status, cc, control, deck] of pairs) {
      expect(last([status, cc, 0x10], [status, cc + 0x20, 0x00]), `${status.toString(16)} ${cc.toString(16)}`).toMatchObject({ kind: "continuous", control, deck });
    }
  });
});

describe("mixer and browse buttons (3-2, 3-10, 3-13, 4-1 … 4-3)", () => {
  it("decodes MASTER CUE, SMART CFX, SMART FADER and the MONO/STEREO switch", () => {
    expect(last([0x96, 0x63, 0x7f])).toMatchObject({ control: "master-cue", deck: null, shift: false });
    expect(last([0x96, 0x78, 0x7f])).toMatchObject({ control: "master-cue", shift: true });
    expect(last([0x96, 0x00, 0x7f])).toMatchObject({ control: "smart-cfx", shift: false });
    expect(last([0x96, 0x08, 0x7f])).toMatchObject({ control: "smart-cfx", shift: true });
    expect(last([0x96, 0x01, 0x7f])).toMatchObject({ control: "smart-fader", shift: false });
    expect(last([0x96, 0x09, 0x7f])).toMatchObject({ control: "smart-fader", shift: true });
    expect(last([0x96, 0x6d, 0x7f])).toMatchObject({ control: "mono-stereo" });
  });

  it("decodes BROWSE turns as two's-complement ticks, and its press", () => {
    expect(last([0xb6, 0x40, 0x01])).toEqual({ kind: "browse-turn", shift: false, ticks: 1 });
    expect(last([0xb6, 0x40, 0x7e])).toEqual({ kind: "browse-turn", shift: false, ticks: -2 });
    expect(last([0xb6, 0x64, 0x7f])).toEqual({ kind: "browse-turn", shift: true, ticks: -1 });
    expect(last([0x96, 0x41, 0x7f])).toMatchObject({ control: "browse-press", shift: false });
    expect(last([0x96, 0x42, 0x7f])).toMatchObject({ control: "browse-press", shift: true });
  });

  it("decodes LOAD on each deck, with SHIFT", () => {
    expect(last([0x96, 0x46, 0x7f])).toMatchObject({ control: "load", deck: "A", shift: false });
    expect(last([0x96, 0x68, 0x7f])).toMatchObject({ control: "load", deck: "A", shift: true });
    expect(last([0x96, 0x47, 0x7f])).toMatchObject({ control: "load", deck: "B", shift: false });
    expect(last([0x96, 0x7a, 0x7f])).toMatchObject({ control: "load", deck: "B", shift: true });
  });
});

describe("Beat FX (2-1 … 2-6)", () => {
  it("decodes FX SELECT, BEAT ◁ ▷ and their SHIFT layers", () => {
    expect(last([0x94, 0x63, 0x7f])).toMatchObject({ control: "fx-select", shift: false });
    expect(last([0x94, 0x64, 0x7f])).toMatchObject({ control: "fx-select", shift: true });
    expect(last([0x94, 0x4a, 0x7f])).toMatchObject({ control: "fx-beat-back", shift: false });
    expect(last([0x94, 0x66, 0x7f])).toMatchObject({ control: "fx-beat-back", shift: true });
    expect(last([0x94, 0x4b, 0x7f])).toMatchObject({ control: "fx-beat-forward", shift: false });
    expect(last([0x94, 0x6b, 0x7f])).toMatchObject({ control: "fx-beat-forward", shift: true });
  });

  it("decodes FX ON/OFF from either channel's status byte", () => {
    expect(last([0x94, 0x47, 0x7f])).toMatchObject({ control: "fx-on", shift: false, pressed: true });
    expect(last([0x95, 0x47, 0x7f])).toMatchObject({ control: "fx-on", shift: false });
    expect(last([0x94, 0x43, 0x7f])).toMatchObject({ control: "fx-on", shift: true });
  });

  it("follows the CH SELECT lever through its four notes", () => {
    const toCh1 = [
      [0x94, 0x10, 0x7f],
      [0x94, 0x11, 0x00],
      [0x95, 0x10, 0x00],
      [0x95, 0x11, 0x00],
    ];
    const toCh2 = [
      [0x94, 0x10, 0x00],
      [0x94, 0x11, 0x00],
      [0x95, 0x10, 0x00],
      [0x95, 0x11, 0x7f],
    ];
    const toBoth = [
      [0x94, 0x10, 0x7f],
      [0x94, 0x11, 0x00],
      [0x95, 0x10, 0x00],
      [0x95, 0x11, 0x7f],
    ];
    const decoder = new Flx4Decoder();
    const after = (messages: number[][]) => messages.map((bytes) => decoder.decode(bytes)).filter((input) => input !== null).at(-1);
    expect(after(toCh1)).toEqual({ kind: "fx-channel", channels: "1" });
    expect(after(toBoth)).toEqual({ kind: "fx-channel", channels: "1&2" });
    expect(after(toCh2)).toEqual({ kind: "fx-channel", channels: "2" });
  });
});

describe("performance pads (5-5)", () => {
  it("decodes pad number and mode from the note, and SHIFT from the channel", () => {
    expect(last([0x97, 0x00, 0x7f])).toEqual({ kind: "pad", deck: "A", mode: "hot-cue", pad: 0, shift: false, pressed: true });
    expect(last([0x98, 0x07, 0x7f])).toEqual({ kind: "pad", deck: "A", mode: "hot-cue", pad: 7, shift: true, pressed: true });
    expect(last([0x99, 0x23, 0x00])).toEqual({ kind: "pad", deck: "B", mode: "beat-jump", pad: 3, shift: false, pressed: false });
    expect(last([0x9a, 0x65, 0x7f])).toEqual({ kind: "pad", deck: "B", mode: "beat-loop", pad: 5, shift: true, pressed: true });
    expect(last([0x97, 0x31, 0x7f])).toMatchObject({ mode: "sampler", pad: 1 });
    expect(last([0x97, 0x46, 0x7f])).toMatchObject({ mode: "keyboard", pad: 6 });
    expect(last([0x97, 0x12, 0x7f])).toMatchObject({ mode: "pad-fx-1", pad: 2 });
    expect(last([0x97, 0x54, 0x7f])).toMatchObject({ mode: "pad-fx-2", pad: 4 });
    expect(last([0x97, 0x77, 0x7f])).toMatchObject({ mode: "key-shift", pad: 7 });
  });
});

describe("anything else", () => {
  it("reports unlisted messages as unknown, with their bytes", () => {
    expect(last([0x90, 0x7e, 0x7f])).toEqual({ kind: "unknown", bytes: [0x90, 0x7e, 0x7f] });
    expect(last([0xf0, 0x00, 0x40, 0xf7])).toEqual({ kind: "unknown", bytes: [0xf0, 0x00, 0x40, 0xf7] });
    expect(last([0xb6, 0x7b])).toEqual({ kind: "unknown", bytes: [0xb6, 0x7b] });
  });
});

describe("physical controls", () => {
  it("names each physical control once, whatever its layer or value", () => {
    const decoder = new Flx4Decoder();
    const id = (bytes: number[]) => {
      const input = decoder.decode(bytes);
      return input === null ? null : physicalControlOf(input);
    };
    expect(id([0x90, 0x0b, 0x7f])).toBe("A.play");
    expect(id([0x90, 0x0e, 0x7f])).toBe("A.play");
    expect(id([0x91, 0x5c, 0x7f])).toBe("B.sync");
    expect(id([0xb0, 0x22, 0x41])).toBe("A.jog");
    expect(id([0xb0, 0x21, 0x41])).toBe("A.jog");
    expect(id([0x90, 0x36, 0x7f])).toBe("A.jog");
    expect(id([0x98, 0x03, 0x7f])).toBe("A.pad-4");
    expect(id([0x91, 0x69, 0x7f])).toBe("B.pad-mode-hot-cue");
    expect(id([0xb6, 0x40, 0x01])).toBe("browse");
    expect(id([0x96, 0x41, 0x7f])).toBe("browse");
    expect(id([0xb6, 0x18, 0x00])).toBeNull();
    expect(id([0xb6, 0x38, 0x00])).toBe("B.filter");
    expect(id([0x94, 0x10, 0x7f])).toBe("fx-channel");
    expect(id([0x90, 0x66, 0x7f])).toBeNull();
    expect(id([0x90, 0x7e, 0x7f])).toBeNull();
  });
});
