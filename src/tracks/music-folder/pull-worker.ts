// Pull-based workers: up to `concurrency` jobs at once, each asked for (`next()`) only when a slot is
// free. The caller owns what is waiting and its order, so a job wanted now goes ahead of the
// background ones without a second queue; `next()` returning null means nothing to do until `wake()`.

export interface PullWorkerOptions<Job> {
  readonly concurrency: number;
  /** The job to run now, or null when there is none (or none may run, e.g. while paused). */
  readonly next: () => Job | null;
  readonly run: (job: Job) => Promise<void>;
  /** A job that throws is a bug in `run`; it is reported here and the worker goes on. */
  readonly onError?: (job: Job, error: unknown) => void;
}

export interface PullWorker {
  /** There may be new work: fill the free slots. */
  wake(): void;
  /** Starts no more jobs (running ones finish). */
  stop(): void;
  /** Resolves once nothing is running and `next()` has nothing. */
  idle(): Promise<void>;
  readonly running: number;
}

export function createPullWorker<Job>(options: PullWorkerOptions<Job>): PullWorker {
  let running = 0;
  let stopped = false;
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (running > 0) return;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };
  const fill = () => {
    while (!stopped && running < options.concurrency) {
      const job = options.next();
      if (job === null) break;
      running += 1;
      void options
        .run(job)
        .catch((error: unknown) => {
          if (options.onError === undefined) console.warn("tracks.folder.jobFailed", { error });
          else options.onError(job, error);
        })
        .finally(() => {
          running -= 1;
          fill();
          settle();
        });
    }
    settle();
  };
  return {
    wake: fill,
    stop: () => {
      stopped = true;
    },
    idle: () =>
      new Promise((resolve) => {
        waiters.push(resolve);
        settle();
      }),
    get running() {
      return running;
    },
  };
}
