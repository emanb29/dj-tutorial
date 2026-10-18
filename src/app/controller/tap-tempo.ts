// Beat FX TAP (SHIFT + BEAT ▶ on the FLX4): the echo's tempo from taps. The BPM is 60 000 ms over the
// median of the recent intervals, so one stray tap does not move it; after 2 s without a tap the next
// tap starts a new count. Pure, so it is tested without an engine.

/** Taps needed before a BPM is given (3 intervals). */
export const TAP_MIN_TAPS = 4;
/** A pause this long between taps starts over. */
export const TAP_IDLE_RESET_MS = 2000;
/** The most recent intervals the median is taken over. */
const INTERVALS_KEPT = 8;

export class TapTempo {
  private taps: number[] = [];

  /** Adds a tap at `timeMs` (performance.now() milliseconds); returns the BPM once there are enough taps. */
  tap(timeMs: number): number | null {
    const last = this.taps.at(-1);
    if (last !== undefined && timeMs - last > TAP_IDLE_RESET_MS) this.taps = [];
    if (last !== undefined && timeMs <= last && this.taps.length > 0) return this.bpm();
    this.taps = [...this.taps, timeMs].slice(-(INTERVALS_KEPT + 1));
    return this.bpm();
  }

  reset(): void {
    this.taps = [];
  }

  private bpm(): number | null {
    if (this.taps.length < TAP_MIN_TAPS) return null;
    const intervals = this.taps.slice(1).map((time, index) => time - (this.taps[index] ?? time)).sort((a, b) => a - b);
    const middle = Math.floor(intervals.length / 2);
    const median = intervals.length % 2 === 1 ? (intervals[middle] ?? 0) : ((intervals[middle - 1] ?? 0) + (intervals[middle] ?? 0)) / 2;
    return median > 0 ? 60_000 / median : null;
  }
}
