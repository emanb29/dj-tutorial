import { describe, expect, it } from "vitest";
import { JOG_STILL_MS, JOG_TURN_INTERVAL_MS, JogDriver, TICKS_PER_REVOLUTION, ticksToRadians, type JogTurns } from "./jog.ts";

const TICK = (2 * Math.PI) / TICKS_PER_REVOLUTION;

function harness(options: { refuse?: boolean } = {}) {
  const calls: string[] = [];
  const turns: { angle: number; elapsedMs: number; atMs: number }[] = [];
  let timers: { run: () => void; delayMs: number }[] = [];
  let begun = 0;
  let refused = 0;
  const driver = new JogDriver({
    begin: (): JogTurns | null => {
      if (options.refuse === true) return null;
      begun += 1;
      return {
        turn: (angle, elapsedMs, timing) => {
          turns.push({ angle, elapsedMs, atMs: timing.eventTimeMs });
          calls.push(`turn ${angle.toFixed(4)}`);
        },
        end: (timing) => {
          calls.push(`end @${String(timing.eventTimeMs)}`);
        },
      };
    },
    refused: () => {
      refused += 1;
    },
    schedule: (run, delayMs) => {
      const timer = { run, delayMs };
      timers.push(timer);
      return () => {
        timers = timers.filter((candidate) => candidate !== timer);
      };
    },
  });
  return {
    driver,
    calls,
    turns,
    begun: () => begun,
    refused: () => refused,
    fireTimers: () => {
      const due = timers;
      timers = [];
      for (const timer of due) timer.run();
    },
    pending: () => timers.length,
  };
}

describe("jog ticks", () => {
  it("turns 720 ticks into one revolution", () => {
    expect(ticksToRadians(TICKS_PER_REVOLUTION)).toBeCloseTo(2 * Math.PI);
    expect(ticksToRadians(-1)).toBeCloseTo(-TICK);
  });
});

describe("JogDriver", () => {
  it("opens a jog gesture on the first tick and sends it at once", () => {
    const { driver, turns, begun } = harness();
    driver.ticks(2, 1000);
    expect(begun()).toBe(1);
    expect(turns).toEqual([{ angle: 2 * TICK, elapsedMs: 0, atMs: 1000 }]);
  });

  it("sums ticks that come faster than one turn per frame, never dropping any", () => {
    const { driver, turns } = harness();
    driver.ticks(1, 1000);
    driver.ticks(1, 1004);
    driver.ticks(1, 1008);
    driver.ticks(1, 1000 + JOG_TURN_INTERVAL_MS);
    expect(turns.map((turn) => Math.round(turn.angle / TICK))).toEqual([1, 3]);
    expect(turns[1]).toMatchObject({ elapsedMs: JOG_TURN_INTERVAL_MS, atMs: 1000 + JOG_TURN_INTERVAL_MS });
  });

  it("flushes what is left and ends the gesture once the side of the wheel stops", () => {
    const { driver, calls, turns, fireTimers, pending } = harness();
    driver.ticks(1, 1000);
    driver.ticks(1, 1005);
    fireTimers();
    expect(turns.at(-1)).toMatchObject({ elapsedMs: 5, atMs: 1005 });
    expect(calls.at(-1)).toBe("end @1005");
    expect(pending()).toBe(0);
  });

  it("while the platter is held, stopping only zeroes the bend: the gesture ends at the release", () => {
    const { driver, calls, turns, fireTimers } = harness();
    driver.touch(true, 900);
    driver.ticks(3, 1000);
    fireTimers();
    expect(turns.at(-1)).toEqual({ angle: 0, elapsedMs: JOG_STILL_MS, atMs: 1000 + JOG_STILL_MS });
    expect(calls.filter((call) => call.startsWith("end"))).toEqual([]);
    driver.touch(false, 1300);
    expect(calls.at(-1)).toBe("end @1300");
  });

  it("opens one gesture for a touch and the turns inside it", () => {
    const { driver, begun } = harness();
    driver.touch(true, 900);
    driver.ticks(1, 1000);
    driver.ticks(1, 1100);
    expect(begun()).toBe(1);
  });

  it("reports a locked jog once per gesture, and sends nothing", () => {
    const { driver, refused, turns } = harness({ refuse: true });
    driver.touch(true, 900);
    driver.ticks(1, 1000);
    driver.ticks(1, 1010);
    expect(refused()).toBe(1);
    expect(turns).toEqual([]);
    driver.touch(false, 1100);
    driver.ticks(1, 2000);
    expect(refused()).toBe(2);
  });

  it("release ends an open gesture without a time (a lost device, a page hidden)", () => {
    const { driver, calls, pending } = harness();
    driver.touch(true, 900);
    driver.ticks(1, 1000);
    driver.release();
    expect(calls.at(-1)).toBe("end @1000");
    expect(pending()).toBe(0);
  });
});
