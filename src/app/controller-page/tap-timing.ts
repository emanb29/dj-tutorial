// What counts as a tap on the DDJ-FLX4, and how far a tap landed from a click, for the Controller
// page's Timing check (TimingCheck.tsx). Pure, so tests need no audio.

import type { Flx4Input } from "@midi";

/** The presses that are TAP in an early Lesson: any pad, BEAT ◀ / ▶, the BROWSE press (not SHIFT + BROWSE: Ready). */
export function isTapPress(input: Flx4Input): boolean {
  if (input.kind === "pad") return input.pressed;
  if (input.kind !== "button" || !input.pressed) return false;
  return (input.control === "browse-press" && !input.shift) || input.control === "fx-beat-back" || input.control === "fx-beat-forward";
}

/** Milliseconds from the nearest click to a tap heard at `heardSec` (negative: early). */
export function offsetFromClicks(heardSec: number, firstClickSec: number, beatSec: number): number {
  const beats = (heardSec - firstClickSec) / beatSec;
  return (beats - Math.round(beats)) * beatSec * 1000;
}
