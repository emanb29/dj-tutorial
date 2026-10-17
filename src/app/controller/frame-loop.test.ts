import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameLoop } from "./frame-loop.ts";

/** A manual requestAnimationFrame: `step()` runs the frames queued so far. */
function manualFrames() {
  let next = 1;
  const queued = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = next++;
    queued.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued.delete(id);
  });
  return {
    pending: () => queued.size,
    step(nowMs: number) {
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback(nowMs);
    },
  };
}

describe("FrameLoop", () => {
  let frames: ReturnType<typeof manualFrames>;
  beforeEach(() => {
    frames = manualFrames();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls every drawer each frame and stops when the last one leaves", () => {
    const loop = new FrameLoop();
    const drawn: number[] = [];
    const remove = loop.add((now) => drawn.push(now));
    frames.step(16);
    frames.step(32);
    remove();
    expect(drawn).toEqual([16, 32]);
    expect(frames.pending()).toBe(0);
  });

  it("keeps a single frame chain when a drawer leaves and another joins during a frame (LOW)", () => {
    const loop = new FrameLoop();
    let removeFirst: () => void = () => undefined;
    removeFirst = loop.add(() => {
      removeFirst();
      loop.add(() => undefined);
    });
    frames.step(16);
    expect(frames.pending()).toBe(1);
  });
});
