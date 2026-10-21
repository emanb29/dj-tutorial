import { describe, expect, it } from "vitest";
import { Flx4Decoder } from "@midi";
import { buttonForKey, CONTROLLER_KEYS, flx4Command, shortButtonForKey } from "./flx4-keys.ts";

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
    expect(command([0xb6, 0x64, 0x02])).toEqual({ kind: "move", step: 2 });
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
