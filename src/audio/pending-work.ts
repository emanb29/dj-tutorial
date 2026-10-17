// Tracks in-flight messages to AudioWorklets so callers can await them, without unhandled rejections.
// A failure is kept and rethrown from the next settled() so it is never silently lost.

export class PendingWork {
  private readonly inFlight = new Set<Promise<unknown>>();
  private failure: { error: unknown } | null = null;

  track(promise: Promise<unknown>): void {
    this.inFlight.add(promise);
    promise.then(
      () => this.inFlight.delete(promise),
      (error: unknown) => {
        this.inFlight.delete(promise);
        console.error("[audio] a worklet message failed:", error);
        this.failure ??= { error };
      },
    );
  }

  /** Resolves when everything tracked so far has finished; rejects with the first failure since the last call. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    const failure = this.failure;
    this.failure = null;
    if (failure !== null) throw failure.error;
  }
}
