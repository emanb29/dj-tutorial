/** A token bucket's shape: up to `burst` calls at once, refilled at `perWindow` calls per `windowMs`. */
export interface BucketRule {
  readonly burst: number;
  readonly perWindow: number;
  readonly windowMs: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

/** In-memory token buckets keyed by a string. Holds at most `maxKeys` buckets, dropping the oldest. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly nowMs: () => number,
    private readonly maxKeys = 1000,
  ) {}

  /** Takes one token if there is one. `false` means the caller is over the limit. */
  tryTake(key: string, rule: BucketRule): boolean {
    const now = this.nowMs();
    const bucket = this.buckets.get(key) ?? { tokens: rule.burst, updatedAtMs: now };
    const refilled = ((now - bucket.updatedAtMs) * rule.perWindow) / rule.windowMs;
    const tokens = Math.min(rule.burst, bucket.tokens + refilled);
    const allowed = tokens >= 1;
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, updatedAtMs: now });
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return allowed;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** coach-design §3: line 30/min with a burst of 5; Curriculum 10/hour; warm 6/hour. */
export const COACH_RATE_RULES = {
  line: { burst: 5, perWindow: 30, windowMs: MINUTE_MS },
  curriculum: { burst: 10, perWindow: 10, windowMs: HOUR_MS },
  warm: { burst: 6, perWindow: 6, windowMs: HOUR_MS },
} as const satisfies Record<string, BucketRule>;
