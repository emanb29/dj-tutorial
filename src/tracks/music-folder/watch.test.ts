import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFolder } from "./test-support.ts";
import { watchFolder, type WatchEnvironment } from "./watch.ts";

function environment(overrides: Partial<WatchEnvironment> = {}) {
  let visible = true;
  const listeners = new Set<() => void>();
  const env: WatchEnvironment = {
    visible: () => visible,
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => Date.now(),
    intervalMs: 30_000,
    ...overrides,
  };
  const setVisible = (now: boolean) => {
    visible = now;
    for (const listener of listeners) listener();
  };
  return { env, setVisible };
}

describe("watchFolder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rescans every 30 s while the page is visible, not while it is hidden", async () => {
    const { env, setVisible } = environment();
    const onChange = vi.fn();

    const watch = await watchFolder(fakeFolder("Music"), onChange, env);
    expect(watch.how).toBe("polling");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    setVisible(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    setVisible(true);
    expect(onChange).toHaveBeenCalledTimes(2);

    watch.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("uses FileSystemObserver where there is one, with one rescan per burst of changes", async () => {
    let fire: () => void = () => undefined;
    const disconnect = vi.fn();
    class Observer {
      constructor(callback: () => void) {
        fire = callback;
      }
      observe() {
        return Promise.resolve();
      }
      disconnect = disconnect;
    }
    const { env } = environment({ Observer });
    const onChange = vi.fn();

    const watch = await watchFolder(fakeFolder("Music"), onChange, env);
    expect(watch.how).toBe("observer");
    fire();
    fire();
    fire();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    watch.stop();
    expect(disconnect).toHaveBeenCalled();
  });

  it("falls back to rescanning when the observer refuses the folder", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    class Observer {
      observe() {
        return Promise.reject(new TypeError("not a FileSystemHandle"));
      }
      disconnect() {
        return undefined;
      }
    }
    const { env } = environment({ Observer });

    const watch = await watchFolder(fakeFolder("Music"), () => undefined, env);

    expect(watch.how).toBe("polling");
    watch.stop();
  });
});
