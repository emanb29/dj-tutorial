// The playhead model of one loaded track: piecewise-constant playback rates on the context timeline,
// in the attempt contract's shape (shared/attempt.ts PlayheadModel, check-design §1). Position is
// integrated from the rates the engine schedules, so it is exact rather than polled.
//
// Loops: while a loop is on, the position wraps from its end back to its start, where the audio does.
// The model owns the loop (the deck reads it from here). Each wrap is recorded as a jump back (a segment
// at the loop start), so the contract's model needs no loop concept. A wrap is written into the history
// when a later change is made; until then `segments(untilCtx)` adds the wraps up to the time asked for.

import type { LoopSpan, PlayheadSegment } from "@shared/attempt.ts";
import { fail, OK, type Result } from "./result.ts";
import type { CtxTime } from "./types.ts";

export type { LoopSpan, PlayheadSegment } from "@shared/attempt.ts";

/** Bound on segments per loaded track: about 55 changes a second for an hour. */
export const PLAYHEAD_SEGMENT_LIMIT = 200_000;

export class PlayheadTracker {
  readonly durationSec: number;
  private readonly segmentLimit: number;
  private readonly history: PlayheadSegment[] = [];
  /** The loop on now. It governs the last segment only: earlier wraps are already in the history. */
  private activeLoop: LoopSpan | null = null;

  constructor(options: { durationSec: number; segmentLimit?: number }) {
    this.durationSec = options.durationSec;
    this.segmentLimit = options.segmentLimit ?? PLAYHEAD_SEGMENT_LIMIT;
  }

  /** Track position at context time `ctx`, clamped to the track. Before the first segment the deck is stopped at 0. */
  positionAt(ctx: CtxTime): number {
    const segment = this.segmentAt(ctx);
    if (segment === null) return 0;
    const raw = segment.pos + (ctx - segment.fromCtx) * segment.rate;
    const wrapped = segment === this.history.at(-1) ? this.wrap(raw) : raw;
    return Math.min(this.durationSec, Math.max(0, wrapped));
  }

  rateAt(ctx: CtxTime): number {
    return this.segmentAt(ctx)?.rate ?? 0;
  }

  /** The loop on now, or null. */
  loop(): LoopSpan | null {
    return this.activeLoop;
  }

  setRate(ctx: CtxTime, rate: number): Result {
    const allowed = this.canChangeAt(ctx);
    if (!allowed.ok) return allowed;
    this.recordWrapsUntil(ctx);
    if (this.history.length > 0 && this.rateAt(ctx) === rate) return OK;
    return this.append({ fromCtx: ctx, pos: this.positionAt(ctx), rate });
  }

  /** Moves the playhead. A seek leaves any loop: the deck plays straight on from `positionSec`. */
  seek(ctx: CtxTime, positionSec: number): Result {
    const allowed = this.canChangeAt(ctx);
    if (!allowed.ok) return allowed;
    this.recordWrapsUntil(ctx);
    const appended = this.append({ fromCtx: ctx, pos: positionSec, rate: this.rateAt(ctx) });
    if (appended.ok) this.activeLoop = null;
    return appended;
  }

  /**
   * Turns a loop on (or changes it) from `ctx`, or off with null. A loop whose end is already behind the
   * playhead takes it back at once, to where a wrap at the end would have put it.
   */
  setLoop(ctx: CtxTime, loop: LoopSpan | null): Result {
    if (loop !== null && !(Number.isFinite(loop.start) && Number.isFinite(loop.end) && loop.start >= 0 && loop.end > loop.start && loop.end <= this.durationSec)) {
      return fail({ kind: "value-out-of-range", control: "loop", value: loop.end - loop.start, min: 0, max: this.durationSec });
    }
    const allowed = this.canChangeAt(ctx);
    if (!allowed.ok) return allowed;
    this.recordWrapsUntil(ctx);
    const here = this.positionAt(ctx);
    const pos = loop !== null && here >= loop.end ? loop.start + ((here - loop.end) % (loop.end - loop.start)) : here;
    const appended = this.append({ fromCtx: ctx, pos, rate: this.rateAt(ctx) });
    if (appended.ok) this.activeLoop = loop;
    return appended;
  }

  /** Checks that a change at `ctx` would be accepted, without making it. */
  canChangeAt(ctx: CtxTime): Result {
    const last = this.history.at(-1);
    if (last !== undefined && ctx < last.fromCtx) return fail({ kind: "playhead-out-of-order", atCtx: ctx, lastCtx: last.fromCtx });
    if (this.history.length + this.wrapsUntil(ctx).length >= this.segmentLimit && last?.fromCtx !== ctx) {
      return fail({ kind: "playhead-full", limit: this.segmentLimit });
    }
    return OK;
  }

  /** Context time of the latest change, or null before any. O(1), unlike segments(). */
  lastCtx(): CtxTime | null {
    return this.history.at(-1)?.fromCtx ?? null;
  }

  /** The model so far, plus the wraps of a loop still on up to `untilCtx` (default: none beyond the last change). */
  segments(untilCtx: CtxTime = Number.NEGATIVE_INFINITY): readonly PlayheadSegment[] {
    return [...this.history, ...this.wrapsUntil(untilCtx)];
  }

  /** `raw` folded into the loop once it has reached the loop's end. */
  private wrap(raw: number): number {
    const loop = this.activeLoop;
    if (loop === null || raw < loop.end) return raw;
    return loop.start + ((raw - loop.end) % (loop.end - loop.start));
  }

  /** The wraps the active loop makes after the last segment, up to and including `ctx`. */
  private wrapsUntil(ctx: CtxTime): PlayheadSegment[] {
    const loop = this.activeLoop;
    let segment = this.history.at(-1);
    if (loop === null || segment === undefined || segment.rate <= 0) return [];
    const wraps: PlayheadSegment[] = [];
    for (;;) {
      const at: CtxTime = segment.fromCtx + Math.max(0, loop.end - segment.pos) / segment.rate;
      // A wrap at the segment's own start would never end (only possible for a zero-length loop).
      if (at > ctx || at <= segment.fromCtx || this.history.length + wraps.length >= this.segmentLimit) return wraps;
      segment = { fromCtx: at, pos: loop.start, rate: segment.rate };
      wraps.push(segment);
    }
  }

  private recordWrapsUntil(ctx: CtxTime): void {
    this.history.push(...this.wrapsUntil(ctx));
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
