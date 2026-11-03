import { describe, expect, it } from "vitest";
import { BEAT_FX_BEATS } from "@audio/beat-fx.ts";
import { ECHO_BEATS } from "@shared/mix-plan.ts";
import { deckOf, matchedTempos } from "./deck-layout.ts";

describe("deckOf", () => {
  it("puts the tracks on decks A and B in turn", () => {
    expect(Array.from({ length: 5 }, (_, index) => deckOf(index))).toEqual(["A", "B", "A", "B", "A"]);
  });
});

describe("matchedTempos", () => {
  it("matches each track to the heard tempo of the one before", () => {
    const tempos = matchedTempos([{ bpm: 120 }, { bpm: 125 }, { bpm: 118 }], 10);

    expect(tempos[0]).toEqual({ rate: 1, heardBpm: 120, fader: 0 });
    expect(tempos[1]?.rate).toBeCloseTo(120 / 125);
    expect(tempos[1]?.fader).toBeCloseTo(-0.4);
    expect(tempos[2]?.rate).toBeCloseTo(120 / 118);
    for (const tempo of tempos) expect(tempo.heardBpm).toBeCloseTo(120);
  });

  it("still matches a track the tempo fader cannot reach, with no fader position", () => {
    const [, far] = matchedTempos([{ bpm: 100 }, { bpm: 140 }], 6);
    expect(far?.rate).toBeCloseTo(100 / 140);
    expect(far?.fader).toBeNull();
  });
});

describe("ECHO_BEATS", () => {
  it("are BEAT ◀/▶'s steps", () => {
    expect(ECHO_BEATS).toEqual([...BEAT_FX_BEATS]);
  });
});
