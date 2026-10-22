// The unscored by-ear round before the tempo-fader Check: a mystery clip, On or Off, and a line on each answer.
import { describe, expect, it } from "vitest";
import { EAR_ROUND_START, earGuess, earHeard, mysteryMasterTempo } from "./ear-round.ts";

describe("the Master Tempo ear round", () => {
  it("varies the mystery from round to round, both ways, never three the same in a row", () => {
    const rounds = Array.from({ length: 10 }, (_, round) => mysteryMasterTempo(round));
    expect(new Set(rounds)).toEqual(new Set([true, false]));
    for (let round = 2; round < rounds.length; round += 1) expect(new Set(rounds.slice(round - 2, round + 1)).size).toBe(2);
  });

  it("takes an answer only once the mystery was heard", () => {
    expect(earGuess(EAR_ROUND_START, true)).toBe(EAR_ROUND_START);
    expect(earHeard(EAR_ROUND_START)).toEqual({ ...EAR_ROUND_START, heard: true });
  });

  it("says on each answer what the clip was and how it sounds, then moves to a new mystery", () => {
    const on = mysteryMasterTempo(0);
    const right = earGuess(earHeard(EAR_ROUND_START), on);
    expect(right).toEqual({ round: 1, right: 1, heard: false, line: on ? "Right: On. Faster, same note." : "Right: Off. Faster, and higher." });
    const actual = mysteryMasterTempo(1);
    const wrong = earGuess(earHeard(right), !actual);
    expect(wrong).toEqual({ round: 2, right: 1, heard: false, line: actual ? "That was On: faster, same note." : "That was Off: faster, and higher." });
  });
});
