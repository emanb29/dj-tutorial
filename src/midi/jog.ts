// The hardware jog wheel's relative ticks, turned into the controller's jog gestures (a platter turn
// with an angle and the time it took). Ticks arrive far faster than a frame; they are summed, never
// dropped, and sent at most once a frame. Touching the platter holds one gesture open until it is let
// go; turning the wheel's side opens one that ends once the wheel has been still for JOG_STILL_MS.

/** Ticks per platter revolution. From Mixxx's FLX4 script (scratchEnable(…, 720, …)); not in AlphaTheta's list. */
export const TICKS_PER_REVOLUTION = 720;
/** At most one turn per frame (about 60 Hz). */
export const JOG_TURN_INTERVAL_MS = 16;
/** No tick for this long: the wheel has stopped. */
export const JOG_STILL_MS = 50;

export function ticksToRadians(ticks: number): number {
  return (ticks * 2 * Math.PI) / TICKS_PER_REVOLUTION;
}

/** What a jog gesture takes: the shape of the controller session's JogGesture. */
export interface JogTurns {
  turn(angleRad: number, elapsedMs: number, timing: { readonly eventTimeMs: number }): void;
  end(timing: { readonly eventTimeMs: number }): void;
}

export type Schedule = (run: () => void, delayMs: number) => () => void;

export interface JogDriverOptions {
  /** Opens a jog gesture, or returns null when the jog is locked. */
  readonly begin: () => JogTurns | null;
  /** The jog is locked: called once per touch or burst of turns. */
  readonly refused: () => void;
  readonly schedule: Schedule;
}

export class JogDriver {
  private gesture: JogTurns | null = null;
  /** True between a refused begin and the end of that touch or burst, so it is reported once. */
  private refusedNow = false;
  private touched = false;
  private pendingRad = 0;
  private lastTurnMs: number | null = null;
  private lastTickMs = 0;
  private cancelStill: (() => void) | null = null;

  constructor(private readonly options: JogDriverOptions) {}

  touch(touched: boolean, timeMs: number): void {
    this.touched = touched;
    if (touched) {
      this.open();
      return;
    }
    this.flush(timeMs);
    this.finish(timeMs);
  }

  ticks(ticks: number, timeMs: number): void {
    this.lastTickMs = timeMs;
    this.armStill();
    if (!this.open()) return;
    this.pendingRad += ticksToRadians(ticks);
    if (this.lastTurnMs === null || timeMs - this.lastTurnMs >= JOG_TURN_INTERVAL_MS) this.flush(timeMs);
  }

  /** Ends whatever is open, at the last tick: the device went away or the page was hidden. */
  release(): void {
    this.touched = false;
    this.flush(this.lastTickMs);
    this.finish(this.lastTickMs);
  }

  /** Opens a gesture if none is open; false when the jog is locked. */
  private open(): boolean {
    if (this.gesture !== null) return true;
    if (this.refusedNow) return false;
    this.gesture = this.options.begin();
    if (this.gesture === null) {
      this.refusedNow = true;
      this.options.refused();
      return false;
    }
    return true;
  }

  private flush(timeMs: number): void {
    if (this.gesture === null || this.pendingRad === 0) return;
    const elapsedMs = this.lastTurnMs === null ? 0 : timeMs - this.lastTurnMs;
    this.gesture.turn(this.pendingRad, elapsedMs, { eventTimeMs: timeMs });
    this.pendingRad = 0;
    this.lastTurnMs = timeMs;
  }

  private finish(timeMs: number): void {
    this.cancelStill?.();
    this.cancelStill = null;
    this.gesture?.end({ eventTimeMs: timeMs });
    this.gesture = null;
    this.refusedNow = false;
    this.lastTurnMs = null;
    this.pendingRad = 0;
  }

  private armStill(): void {
    this.cancelStill?.();
    this.cancelStill = this.options.schedule(() => {
      this.cancelStill = null;
      this.flush(this.lastTickMs);
      if (this.touched) {
        // Held still: the bend goes back to 0, and the gesture stays open for the next turn.
        this.gesture?.turn(0, JOG_STILL_MS, { eventTimeMs: this.lastTickMs + JOG_STILL_MS });
        this.lastTurnMs = null;
        return;
      }
      this.finish(this.lastTickMs);
    }, JOG_STILL_MS);
  }
}
