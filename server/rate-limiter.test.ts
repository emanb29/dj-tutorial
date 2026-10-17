import { describe, expect, it } from "vitest";
import { COACH_RATE_RULES, RateLimiter } from "./rate-limiter.ts";

describe("RateLimiter", () => {
  it("allows a burst of 5 lines, then one more every 2 seconds", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const take = () => limiter.tryTake("line:default", COACH_RATE_RULES.line);

    expect([take(), take(), take(), take(), take(), take()]).toEqual([true, true, true, true, true, false]);
    now = 1_999;
    expect(take()).toBe(false);
    now = 4_000;
    expect(take()).toBe(true);
  });

  it("keeps separate buckets per key", () => {
    const limiter = new RateLimiter(() => 0);
    for (let call = 0; call < 10; call += 1) limiter.tryTake("curriculum:a", COACH_RATE_RULES.curriculum);

    expect(limiter.tryTake("curriculum:a", COACH_RATE_RULES.curriculum)).toBe(false);
    expect(limiter.tryTake("curriculum:b", COACH_RATE_RULES.curriculum)).toBe(true);
  });

  it("holds a bounded number of buckets", () => {
    const limiter = new RateLimiter(() => 0, 2);
    limiter.tryTake("a", { burst: 1, perWindow: 1, windowMs: 1000 });
    limiter.tryTake("b", { burst: 1, perWindow: 1, windowMs: 1000 });
    limiter.tryTake("c", { burst: 1, perWindow: 1, windowMs: 1000 });

    // "a" was dropped, so it starts with a full bucket again.
    expect(limiter.tryTake("a", { burst: 1, perWindow: 1, windowMs: 1000 })).toBe(true);
  });
});
