import { describe, expect, it, vi } from "vitest";
import { Emitter } from "./events.ts";
import { PendingWork } from "./pending-work.ts";

describe("PendingWork", () => {
  it("resolves settled() once every tracked promise has finished", async () => {
    const work = new PendingWork();
    let finished = false;
    work.track(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          finished = true;
          resolve();
        }, 5);
      }),
    );
    await work.settled();
    expect(finished).toBe(true);
  });

  it("handles a rejection (no unhandled rejection) and rethrows it from settled()", async () => {
    const work = new PendingWork();
    work.track(Promise.reject(new Error("worklet message failed")));
    await expect(work.settled()).rejects.toThrow("worklet message failed");
    // Reported once: the next settled() is clean.
    await expect(work.settled()).resolves.toBeUndefined();
  });
});

describe("Emitter", () => {
  it("still calls later listeners when one throws, then surfaces the error", () => {
    const emitter = new Emitter<{ ping: number }>();
    const reported: unknown[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      try {
        callback();
      } catch (error) {
        reported.push(error);
      }
    });
    const seen: number[] = [];
    emitter.on("ping", () => {
      throw new Error("listener broke");
    });
    emitter.on("ping", (value) => seen.push(value));

    emitter.emit("ping", 7);
    queue.mockRestore();

    expect(seen).toEqual([7]);
    expect(reported).toEqual([new Error("listener broke")]);
  });
});
