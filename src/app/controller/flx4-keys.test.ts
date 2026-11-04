import { describe, expect, it } from "vitest";
import { CHECKLIST, Flx4Decoder } from "@midi";
import { isControlId } from "./control-ids.ts";
import { buttonForKey, CONTROLLER_KEYS, FLX4_LAYOUT, flx4Command, flx4LayoutControl, shortButtonForKey } from "./flx4-keys.ts";

// AlphaTheta's bytes (docs/research/flx4-midi.md, "Mixer and browse"): BROWSE turn B6 40, press 96 41
// (SHIFT 96 42), LOAD deck 1 96 46 (SHIFT 96 68), LOAD deck 2 96 47 (SHIFT 96 7A).
const command = (bytes: number[]) => {
  const input = new Flx4Decoder().decode(bytes);
  return input === null ? null : flx4Command(input);
};

describe("flx4Command", () => {
  it("BROWSE turn moves the ring, one button per tick, either way", () => {
    expect(command([0xb6, 0x40, 0x01])).toEqual({ kind: "move", step: 1 });
    expect(command([0xb6, 0x40, 0x7f])).toEqual({ kind: "move", step: -1 });
  });

  it("SHIFT + BROWSE turn jumps a library preview (a move where none plays)", () => {
    expect(command([0xb6, 0x64, 0x02])).toEqual({ kind: "jump", step: 2 });
    expect(command([0xb6, 0x64, 0x7f])).toEqual({ kind: "jump", step: -1 });
  });

  it("BROWSE press presses the button with the ring; with SHIFT it is back (Esc)", () => {
    expect(command([0x96, 0x41, 0x7f])).toEqual({ kind: "select" });
    expect(command([0x96, 0x42, 0x7f])).toEqual({ kind: "key", code: "Escape" });
  });

  it("LOAD A is Enter, LOAD B is R (naming their deck, for a page with a library); with SHIFT, P and N", () => {
    expect(command([0x96, 0x46, 0x7f])).toEqual({ kind: "key", code: "Enter", loadDeck: "A" });
    expect(command([0x96, 0x47, 0x7f])).toEqual({ kind: "key", code: "KeyR", loadDeck: "B" });
    expect(command([0x96, 0x68, 0x7f])).toEqual({ kind: "key", code: "KeyP" });
    expect(command([0x96, 0x7a, 0x7f])).toEqual({ kind: "key", code: "KeyN" });
  });

  it("does nothing on a release, or for the decks' own controls", () => {
    expect(command([0x96, 0x46, 0x00])).toBeNull();
    expect(command([0x96, 0x41, 0x00])).toBeNull();
    expect(command([0x90, 0x0b, 0x7f])).toBeNull();
    expect(command([0x97, 0x00, 0x7f])).toBeNull();
    expect(command([0x94, 0x6b, 0x7f])).toBeNull();
  });
});

describe("the names hints give", () => {
  it("name each key's FLX4 button from the one table", () => {
    expect(buttonForKey("Enter")).toBe("LOAD A");
    expect(buttonForKey("R")).toBe("LOAD B");
    expect(buttonForKey("P")).toBe("SHIFT + LOAD A");
    expect(buttonForKey("N")).toBe("SHIFT + LOAD B");
    expect(buttonForKey("Esc")).toBe("SHIFT + BROWSE press");
    expect(buttonForKey("Escape")).toBe("SHIFT + BROWSE press");
    expect(shortButtonForKey("Esc")).toBe("SHIFT + BROWSE");
    expect(buttonForKey("X")).toBeNull();
  });

  it("every key in the table is one the decoder can send, and no press is two keys", () => {
    const presses = CONTROLLER_KEYS.map(({ press }) => `${press.control}:${String(press.deck)}:${String(press.shift)}`);
    expect(new Set(presses).size).toBe(presses.length);
  });
});

describe("FLX4_LAYOUT, the controls a planned move uses", () => {
  it("names each control as captions do, with its deck", () => {
    expect(flx4LayoutControl("B.eq-low").name).toBe("LOW B");
    expect(flx4LayoutControl("A.channel-fader").name).toBe("fader A");
    expect(flx4LayoutControl("B.loop-exit").name).toBe("4 BEAT/EXIT B");
    expect(flx4LayoutControl("crossfader").name).toBe("crossfader");
    expect(flx4LayoutControl("beat-fx-on").name).toBe("BEAT FX ON");
  });

  it("puts deck A's side on the left, deck B's and Beat FX on the right, and the crossfader in the middle", () => {
    for (const control of FLX4_LAYOUT) {
      const expected = control.deck === "A" ? "left" : control.id === "crossfader" ? "centre" : "right";
      expect(control.side, control.id).toBe(expected);
    }
  });

  it("uses only the app's control ids, each once, and only physical controls the MIDI decoder reports", () => {
    const physical = new Set(CHECKLIST.map(({ id }) => id));
    for (const control of FLX4_LAYOUT) {
      expect(isControlId(control.id), control.id).toBe(true);
      for (const id of control.physical) expect(physical.has(id), `${control.id} → ${id}`).toBe(true);
    }
    expect(new Set(FLX4_LAYOUT.map(({ id }) => id)).size).toBe(FLX4_LAYOUT.length);
  });
});
