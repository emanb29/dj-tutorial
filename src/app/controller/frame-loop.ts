// One requestAnimationFrame loop for everything that moves every frame: meters, playheads, the jog
// platter and the phase strip. Drawers write to the DOM through refs; nothing per-frame goes through
// React state (ADR 0001). The loop runs only while something is registered.

import { useEffect, useRef } from "react";

export type Drawer = (nowMs: number) => void;

export class FrameLoop {
  private readonly drawers = new Set<Drawer>();
  private handle: number | null = null;

  add(drawer: Drawer): () => void {
    this.drawers.add(drawer);
    this.handle ??= requestAnimationFrame(this.tick);
    return () => {
      this.drawers.delete(drawer);
      if (this.drawers.size === 0 && this.handle !== null) {
        cancelAnimationFrame(this.handle);
        this.handle = null;
      }
    };
  }

  private readonly tick = (nowMs: number): void => {
    // Clear the handle first: a drawer that adds another during this frame starts at most one new chain.
    this.handle = null;
    for (const drawer of this.drawers) drawer(nowMs);
    if (this.drawers.size > 0) this.handle ??= requestAnimationFrame(this.tick);
  };
}

/** Registers `draw` on the loop for the component's lifetime; the latest `draw` is always the one called. */
export function useFrame(loop: FrameLoop, draw: Drawer): void {
  const latest = useRef(draw);
  useEffect(() => {
    latest.current = draw;
  });
  useEffect(
    () =>
      loop.add((nowMs) => {
        latest.current(nowMs);
      }),
    [loop],
  );
}
