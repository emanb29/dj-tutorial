// A finger flicking a fader, knob or jog wheel must not swallow the next tap.
//
// These controls have `touch-action: none`, so the page never scrolls under them. Chromium still turns
// a touch that lifts off while moving into a fling, though, and a tap that lands while that fling is
// "running" (about half a second) only stops it: no click. So a Learner who flicks a fader down and
// taps "Start the Check" straight away lost the tap (ISS-103). Cancelling the touchmoves stops
// Chromium making scroll gestures from the touch at all, fling included; pointer events, which the
// controls read, still arrive.

import { useEffect, type RefObject } from "react";

/** Keeps a drag on `node` from becoming a fling. Returns the cleanup. */
export function holdTouchesToControl(node: HTMLElement): () => void {
  const onTouchMove = (event: TouchEvent) => {
    if (event.cancelable) event.preventDefault();
  };
  node.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    node.removeEventListener("touchmove", onTouchMove);
  };
}

/** {@link holdTouchesToControl} on the element in `ref`, for as long as it is mounted. */
export function useHoldTouchesToControl(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    return node === null ? undefined : holdTouchesToControl(node);
  }, [ref]);
}
