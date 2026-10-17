import { describe, expect, it } from "vitest";
import { matchTaps } from "./measures.ts";

describe("matchTaps", () => {
  it("pairs each tap with the nearest target within the tolerance", () => {
    const result = matchTaps([1.01, 2.0, 2.98], [1, 2, 3], 0.04);

    expect(result.matched).toBe(3);
    expect(result.extras).toBe(0);
    expect(result.offsets.map((o) => Math.round(o * 1000))).toEqual([10, 0, -20]);
  });

  it("matches one-to-one, so spamming taps around a beat scores one match and extras", () => {
    const result = matchTaps([0.99, 1.0, 1.01, 1.02], [1, 2], 0.04);

    expect(result.matched).toBe(1);
    expect(result.extras).toBe(3);
  });

  it("counts a tap exactly on the tolerance edge as matched and one just past it as extra", () => {
    expect(matchTaps([1.04], [1], 0.04).matched).toBe(1);
    expect(matchTaps([1.0401], [1], 0.04)).toMatchObject({ matched: 0, extras: 1 });
  });

  it("gives a contested target to the closer tap and leaves the other free for its own target", () => {
    const result = matchTaps([1.03, 1.06], [1, 1.1], 0.05);

    expect(result.matched).toBe(2);
    expect(result.extras).toBe(0);
  });

  it("reports nothing matched for no taps", () => {
    expect(matchTaps([], [1, 2], 0.04)).toEqual({
      matched: 0,
      extras: 0,
      offsets: [],
      matchedTargets: [],
    });
  });
});
