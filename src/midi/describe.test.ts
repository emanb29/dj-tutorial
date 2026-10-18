import { describe, expect, it } from "vitest";
import { Flx4Decoder, physicalControlOf } from "./decoder.ts";
import { CHECKLIST, describeInput } from "./describe.ts";

const words = (...messages: number[][]) => {
  const decoder = new Flx4Decoder();
  const decoded = messages.map((bytes) => decoder.decode(bytes)).filter((input) => input !== null);
  const last = decoded.at(-1);
  if (last === undefined) throw new Error("nothing decoded");
  return describeInput(last);
};

describe("describeInput", () => {
  it("names buttons with their deck, SHIFT and state", () => {
    expect(words([0x90, 0x0b, 0x7f])).toBe("Deck A PLAY/PAUSE pressed");
    expect(words([0x91, 0x48, 0x00])).toBe("Deck B SHIFT + CUE released");
    expect(words([0x90, 0x5c, 0x7f])).toBe("Deck A BEAT SYNC (held) pressed");
    expect(words([0x96, 0x63, 0x7f])).toBe("MASTER CUE pressed");
    expect(words([0x91, 0x69, 0x7f])).toBe("Deck B KEYBOARD mode pressed");
    expect(words([0x96, 0x6d, 0x7f])).toBe("MONO/STEREO switch MONO");
  });

  it("names pads with their mode, faders with their position, jog and browse turns with their ticks", () => {
    expect(words([0x98, 0x02, 0x7f])).toBe("Deck A SHIFT + pad 3 (HOT CUE) pressed");
    expect(words([0xb6, 0x1f, 0x40], [0xb6, 0x3f, 0x00])).toBe("crossfader 50%");
    expect(words([0xb1, 0x13, 0x7f], [0xb1, 0x33, 0x7f])).toBe("Deck B channel fader 100%");
    expect(words([0xb0, 0x21, 0x3e])).toBe("Deck A jog side -2");
    expect(words([0xb0, 0x22, 0x43])).toBe("Deck A jog platter +3");
    expect(words([0x91, 0x36, 0x7f])).toBe("Deck B jog touched");
    expect(words([0xb6, 0x40, 0x01])).toBe("BROWSE +1");
    expect(words([0x95, 0x11, 0x7f])).toBe("FX CH SELECT CH2");
  });

  it("shows the bytes of anything not in the list", () => {
    expect(words([0x90, 0x7e, 0x7f])).toBe("Not in the FLX4 list: 90 7E 7F");
  });
});

describe("CHECKLIST", () => {
  it("has each physical control once", () => {
    const ids = CHECKLIST.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ticks every item from some message in the official list", () => {
    const decoder = new Flx4Decoder();
    const fourteen = (status: number, cc: number) => [
      [status, cc, 0x10],
      [status, cc + 0x20, 0],
    ];
    const deckMessages = (n: number) => [
      ...[0x0b, 0x0c, 0x3f, 0x58, 0x36, 0x10, 0x11, 0x4d, 0x51, 0x53, 0x1b, 0x1e, 0x20, 0x22, 0x54].map((note) => [0x90 + n, note, 0x7f]),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((pad) => [0x97 + 2 * n, pad, 0x7f]),
      [0x96, 0x46 + n, 0x7f],
      ...[0x00, 0x04, 0x07, 0x0b, 0x0f, 0x13].flatMap((cc) => fourteen(0xb0 + n, cc)),
      ...fourteen(0xb6, 0x17 + n),
    ];
    const messages = [
      ...deckMessages(0),
      ...deckMessages(1),
      ...[0x08, 0x1f, 0x0c, 0x0d, 0x05].flatMap((cc) => fourteen(0xb6, cc)),
      ...[0x63, 0x00, 0x01, 0x41, 0x6d].map((note) => [0x96, note, 0x7f]),
      ...[0x63, 0x4a, 0x4b, 0x47].map((note) => [0x94, note, 0x7f]),
      ...fourteen(0xb4, 0x02),
      [0x94, 0x10, 0x7f],
    ];
    const seen = new Set(
      messages.flatMap((bytes) => {
        const input = decoder.decode(bytes);
        const id = input === null ? null : physicalControlOf(input);
        return id === null ? [] : [id];
      }),
    );
    expect(CHECKLIST.filter((item) => !seen.has(item.id)).map((item) => item.id)).toEqual([]);
  });
});
