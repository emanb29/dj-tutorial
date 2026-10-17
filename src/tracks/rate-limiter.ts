// A client-side request spacer: each caller gets the next free slot, at least 1/rate seconds after
// the previous one. The waiting line is bounded; when it is full, acquire() refuses at once.
import { abortedError } from "./load-audio.ts";
import type { Result } from "./types.ts";

export interface RateLimiterOptions {
  readonly requestsPerSecond: number;
  /** Callers allowed to wait at once; more get a `rate-limited` error. */
  readonly maxWaiting: number;
  readonly now?: () => number;
  /** Resolves after `ms`, or rejects with an AbortError when `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RateLimiter {
  acquire(signal?: AbortSignal): Promise<Result<void>>;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
    throw new RangeError(`requestsPerSecond is ${String(options.requestsPerSecond)}; it must be a positive number.`);
  }
  const intervalMs = 1000 / options.requestsPerSecond;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? sleepFor;
  let lastSlotMs = Number.NEGATIVE_INFINITY;
  let waiting = 0;

  return {
    async acquire(signal) {
      if (signal?.aborted === true) return { ok: false, error: abortedError() };
      if (waiting >= options.maxWaiting) {
        return {
          ok: false,
          error: {
            kind: "rate-limited",
            message: `${String(waiting)} requests are already waiting; this app sends at most ${String(options.requestsPerSecond)} a second.`,
            fix: "Wait for the current searches or loads to finish, then try again.",
          },
        };
      }
      const start = now();
      const slot = Math.max(start, lastSlotMs + intervalMs);
      // Claimed even if the caller aborts while waiting: that errs towards fewer requests.
      lastSlotMs = slot;
      waiting += 1;
      try {
        await sleep(slot - start, signal);
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: abortedError() };
      } finally {
        waiting -= 1;
      }
    },
  };
}
