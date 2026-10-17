// The playhead model of one loaded track: piecewise-constant playback rates on the context timeline,
// in the attempt contract's shape (shared/attempt.ts PlayheadModel, check-design §1). Position is
// integrated from the rates the engine schedules, so it is exact rather than polled.

import type { PlayheadSegment } from "@shared/attempt.ts";
import { fail, OK, type Result } from "./result.ts";
import type { CtxTime } from "./types.ts";

export type { PlayheadSegment } from "@shared/attempt.ts";

/** Bound on segments per loaded track: about 55 changes a second for an hour. */
export const PLAYHEAD_SEGMENT_LIMIT = 200_000;

export class PlayheadTracker {
  readonly durationSec: number;
  private readonly segmentLimit: number;
  private readonly history: PlayheadSegment[] = [];

  constructor(options: { durationSec: number; segmentLimit?: number }) {
    this.durationSec = options.durationSec;
    this.segmentLimit = options.segmentLimit ?? PLAYHEAD_SEGMENT_LIMIT;
  }

  /** Track position at context time `ctx`, clamped to the track. Before the first segment the deck is stopped at 0. */
  positionAt(ctx: CtxTime): number {
    const segment = this.segmentAt(ctx);
    if (segment === null) return 0;
    return Math.min(this.durationSec, Math.max(0, segment.pos + (ctx - segment.fromCtx) * segment.rate));
  }

  rateAt(ctx: CtxTime): number {
    return this.segmentAt(ctx)?.rate ?? 0;
  }

  setRate(ctx: CtxTime, rate: number): Result {
    const allowed = this.canChangeAt(ctx);
    if (!allowed.ok) return allowed;
    if (this.history.length > 0 && this.rateAt(ctx) === rate) return OK;
    return this.append({ fromCtx: ctx, pos: this.positionAt(ctx), rate });
  }

  seek(ctx: CtxTime, positionSec: number): Result {
    return this.append({ fromCtx: ctx, pos: positionSec, rate: this.rateAt(ctx) });
  }

  /** Checks that a change at `ctx` would be accepted, without making it. */
  canChangeAt(ctx: CtxTime): Result {
    const last = this.history.at(-1);
    if (last !== undefined && ctx < last.fromCtx) return fail({ kind: "playhead-out-of-order", atCtx: ctx, lastCtx: last.fromCtx });
    if (this.history.length >= this.segmentLimit && last?.fromCtx !== ctx) return fail({ kind: "playhead-full", limit: this.segmentLimit });
    return OK;
  }

  /** Context time of the latest change, or null before any. O(1), unlike segments(). */
  lastCtx(): CtxTime | null {
    return this.history.at(-1)?.fromCtx ?? null;
  }

  segments(): readonly PlayheadSegment[] {
    return [...this.history];
  }

  private segmentAt(ctx: CtxTime): PlayheadSegment | null {
    return this.history.findLast((segment) => segment.fromCtx <= ctx) ?? null;
  }

  private append(segment: PlayheadSegment): Result {
    const allowed = this.canChangeAt(segment.fromCtx);
    if (!allowed.ok) return allowed;
    if (this.history.at(-1)?.fromCtx === segment.fromCtx) this.history.pop();
    this.history.push(segment);
    return OK;
  }
}
