import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limiter.ts";

/** A clock that only moves when the limiter sleeps. */
function fakeClock() {
  let nowMs = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
  };
}

describe("rate limiter", () => {
  it("spaces requests at least 500 ms apart (2 per second)", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ requestsPerSecond: 2, maxWaiting: 8, now: clock.now, sleep: clock.sleep });

    const results = [await limiter.acquire(), await limiter.acquire(), await limiter.acquire()];

    expect(results.every((result) => result.ok)).toBe(true);
    expect(clock.sleeps).toEqual([0, 500, 500]);
  });

  it("does not wait when the last request was long enough ago", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ requestsPerSecond: 2, maxWaiting: 8, now: clock.now, sleep: clock.sleep });

    await limiter.acquire();
    clock.advance(2_000);
    await limiter.acquire();

    expect(clock.sleeps).toEqual([0, 0]);
  });

  it("refuses with rate-limited once too many callers are waiting", async () => {
    const pending: (() => void)[] = [];
    const limiter = createRateLimiter({
      requestsPerSecond: 2,
      maxWaiting: 2,
      now: () => 0,
      sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
    });

    const first = limiter.acquire();
    const second = limiter.acquire();
    const third = await limiter.acquire();

    expect(third).toMatchObject({ ok: false, error: { kind: "rate-limited" } });
    pending.forEach((resolve) => {
      resolve();
    });
    expect((await first).ok && (await second).ok).toBe(true);
  });

  it("returns aborted when the signal is already aborted", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ requestsPerSecond: 2, maxWaiting: 8, now: clock.now, sleep: clock.sleep });
    const controller = new AbortController();
    controller.abort();

    expect(await limiter.acquire(controller.signal)).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });
});
