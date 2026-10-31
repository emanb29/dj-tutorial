// Noticing new files in the music folder. FileSystemObserver (Chromium 129+ behind a flag, on by
// default since 133) tells us when something changes; elsewhere, or when it refuses the folder, a
// metadata rescan every 30 s while the page is visible, and one on coming back to the page.
import type { DirectoryHandleLike } from "../local-files.ts";

export const POLL_EVERY_MS = 30_000;
/** Changes come in bursts (a copied album): one rescan per burst. */
const OBSERVER_SETTLE_MS = 1_500;

export interface FolderWatch {
  readonly how: "observer" | "polling";
  stop(): void;
}

export type WatchFolder = (root: DirectoryHandleLike, onChange: () => void) => Promise<FolderWatch>;

interface ObserverLike {
  observe(handle: DirectoryHandleLike, options: { recursive: boolean }): Promise<void>;
  disconnect(): void;
}

export interface WatchEnvironment {
  /** The browser's FileSystemObserver, when it has one. */
  readonly Observer?: new (callback: () => void) => ObserverLike;
  readonly visible: () => boolean;
  /** Calls `listener` when the page is shown or hidden; returns the unsubscribe. */
  readonly onVisibilityChange: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly intervalMs?: number;
}

function browserEnvironment(): WatchEnvironment {
  const Observer = (globalThis as { FileSystemObserver?: WatchEnvironment["Observer"] }).FileSystemObserver;
  return {
    ...(Observer === undefined ? {} : { Observer }),
    visible: () => typeof document === "undefined" || document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", listener);
      return () => {
        document.removeEventListener("visibilitychange", listener);
      };
    },
    now: () => performance.now(),
  };
}

function poll(onChange: () => void, environment: WatchEnvironment): FolderWatch {
  const every = environment.intervalMs ?? POLL_EVERY_MS;
  let last = environment.now();
  const tick = () => {
    if (!environment.visible()) return;
    last = environment.now();
    onChange();
  };
  const timer = setInterval(tick, every);
  const unsubscribe = environment.onVisibilityChange(() => {
    if (environment.visible() && environment.now() - last >= every) tick();
  });
  return {
    how: "polling",
    stop: () => {
      clearInterval(timer);
      unsubscribe();
    },
  };
}

/** Watches `root`, calling `onChange` when its files may have changed. */
export async function watchFolder(root: DirectoryHandleLike, onChange: () => void, environment: WatchEnvironment = browserEnvironment()): Promise<FolderWatch> {
  const { Observer } = environment;
  if (Observer !== undefined) {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const observer = new Observer(() => {
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        onChange();
      }, OBSERVER_SETTLE_MS);
    });
    try {
      await observer.observe(root, { recursive: true });
      return {
        how: "observer",
        stop: () => {
          if (settle !== null) clearTimeout(settle);
          observer.disconnect();
        },
      };
    } catch (error) {
      console.warn("tracks.folder.observerRefused", { folder: root.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return poll(onChange, environment);
}
