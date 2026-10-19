// Lesson 6 (Set a cue point by ear) practice ladder: ±40 → ±30 → ±20 ms, and the lines it shows.
import { describe, expect, it } from "vitest";
import type { CuePlacement } from "@checks";
import {
  CUE_LADDER_START,
  CUE_LADDER_TARGETS_MS,
  cueLadderTargetMs,
  cueMissHint,
  cueRepLine,
  cueTargetLine,
  EARLY_HINT,
  LATE_HINT,
  stepCueLadder,
  type CueLadder,
} from "./cue-ladder.ts";

const onOne = (signedMs: number): CuePlacement => ({ signedMs, beatOfBar: 1, downbeat: true });
const onBeat = (beatOfBar: number, signedMs = 0): CuePlacement => ({ signedMs, beatOfBar, downbeat: beatOfBar === 1 });
const steps = (placements: readonly CuePlacement[], from: CueLadder = CUE_LADDER_START): CueLadder => placements.reduce(stepCueLadder, from);

describe("the cue ladder", () => {
  it("narrows to the Check's ±20 ms", () => {
    expect(CUE_LADDER_TARGETS_MS).toEqual([40, 30, 20]);
    expect(cueLadderTargetMs(CUE_LADDER_START)).toBe(40);
  });

  it("moves down a rung after two hits in a row", () => {
    const one = steps([onOne(39)]);
    expect(one).toMatchObject({ rung: 0, hits: 1, complete: false });
    expect(steps([onOne(-40)], one)).toMatchObject({ rung: 1, hits: 0 });
  });

  it("a miss between hits starts the count again", () => {
    expect(steps([onOne(10), onOne(45), onOne(10)])).toMatchObject({ rung: 0, hits: 1, misses: 0 });
  });

  it("moves back up a rung after two misses in a row, never above ±40", () => {
    const atTwenty = steps([onOne(5), onOne(5), onOne(5), onOne(5)]);
    expect(atTwenty.rung).toBe(2);
    expect(steps([onOne(25)], atTwenty)).toMatchObject({ rung: 2, misses: 1 });
    expect(steps([onOne(25), onOne(-21)], atTwenty)).toMatchObject({ rung: 1, misses: 0, hits: 0 });
    expect(steps([onOne(90), onOne(90), onOne(90), onOne(90)])).toMatchObject({ rung: 0 });
  });

  it("judges at the current rung: 25 ms is a hit at ±30, a miss at ±20", () => {
    const atThirty = steps([onOne(1), onOne(1)]);
    expect(steps([onOne(25)], atThirty).last).toMatchObject({ targetMs: 30, hit: true });
    const atTwenty = steps([onOne(1), onOne(1)], atThirty);
    expect(steps([onOne(25)], atTwenty).last).toMatchObject({ targetMs: 20, hit: false });
  });

  it("±20 is inclusive, as the Check's", () => {
    const atTwenty = steps([onOne(0), onOne(0), onOne(0), onOne(0)]);
    expect(steps([onOne(20)], atTwenty).last?.hit).toBe(true);
    expect(steps([onOne(20.5)], atTwenty).last?.hit).toBe(false);
  });

  it("a cue on another beat is a miss however close", () => {
    expect(steps([onBeat(3, 1)]).last).toMatchObject({ hit: false });
  });

  it("is complete after two hits in a row at ±20, and stays complete", () => {
    const done = steps([onOne(1), onOne(1), onOne(1), onOne(1), onOne(-12), onOne(19)]);
    expect(done).toMatchObject({ rung: 2, complete: true });
    expect(steps([onOne(80), onOne(80)], done).complete).toBe(true);
  });
});

describe("the ladder's lines", () => {
  it("the target and the hits so far", () => {
    expect(cueTargetLine(CUE_LADDER_START)).toBe("Target ±40 ms · 0 of 2");
    expect(cueTargetLine(steps([onOne(1), onOne(1), onOne(1)]))).toBe("Target ±30 ms · 1 of 2");
  });

  it("the last cue, signed, with a tick on a hit", () => {
    const atTwenty = steps([onOne(0), onOne(0), onOne(0), onOne(0)]);
    const line = (placement: CuePlacement) => {
      const { last } = stepCueLadder(atTwenty, placement);
      if (last === null) throw new Error("a step always records the cue");
      return cueRepLine(last);
    };
    expect(line(onOne(34.4))).toBe("Cue: 34 ms late");
    expect(line(onOne(-8.2))).toBe("Cue: 8 ms early ✓");
    expect(line(onBeat(3, 2))).toBe("Cue: on beat 3, not the 1");
    expect(line(onOne(0.2))).toBe("Cue: on the beat ✓");
  });
});

describe("the hint after a miss", () => {
  it("two late misses: scrub slower", () => {
    expect(cueMissHint(steps([onOne(50), onOne(45)]))).toBe(LATE_HINT);
    expect(LATE_HINT).toBe("Late? Scrub slower over the last few ticks; stop just before the thump.");
  });

  it("two early misses: nudge forward", () => {
    expect(cueMissHint(steps([onOne(-50), onOne(-60)]))).toBe(EARLY_HINT);
    expect(EARLY_HINT).toBe("Early? Nudge forward a tick or two.");
  });

  it("the last two misses count, even with a hit between them", () => {
    expect(cueMissHint(steps([onOne(50), onOne(5), onOne(45)]))).toBe(LATE_HINT);
  });

  it("nothing after one miss, mixed misses, a wrong beat, or a hit", () => {
    expect(cueMissHint(steps([onOne(50)]))).toBeNull();
    expect(cueMissHint(steps([onOne(50), onOne(-50)]))).toBeNull();
    expect(cueMissHint(steps([onOne(50), onBeat(2, 50)]))).toBeNull();
    expect(cueMissHint(steps([onOne(50), onOne(50), onOne(5)]))).toBeNull();
    expect(cueMissHint(CUE_LADDER_START)).toBeNull();
  });
});
