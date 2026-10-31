import { describe, expect, it } from "vitest";
import { createPullWorker } from "./pull-worker.ts";

/** A job that finishes when the test says so. */
function gate() {
  let open: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open };
}

describe("createPullWorker", () => {
  it("pulls jobs one at a time until there are none, then waits to be woken", async () => {
    const jobs = ["a", "b", "c"];
    const ran: string[] = [];
    const worker = createPullWorker<string>({ concurrency: 1, next: () => jobs.shift() ?? null, run: (job) => Promise.resolve(void ran.push(job)) });

    worker.wake();
    await worker.idle();
    expect(ran).toEqual(["a", "b", "c"]);

    jobs.push("d");
    await worker.idle();
    expect(ran).toEqual(["a", "b", "c"]);
    worker.wake();
    await worker.idle();
    expect(ran).toEqual(["a", "b", "c", "d"]);
  });

  it("never runs more than its concurrency at once", async () => {
    const jobs = [1, 2, 3, 4, 5];
    const gates = new Map<number, ReturnType<typeof gate>>();
    let running = 0;
    let most = 0;
    const worker = createPullWorker<number>({
      concurrency: 2,
      next: () => jobs.shift() ?? null,
      run: async (job) => {
        running += 1;
        most = Math.max(most, running);
        const each = gate();
        gates.set(job, each);
        await each.done;
        running -= 1;
      },
    });

    worker.wake();
    await Promise.resolve();
    expect(running).toBe(2);
    for (let job = 1; job <= 5; job += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gates.get(job)?.open();
    }
    await worker.idle();
    expect(most).toBe(2);
  });

  it("asks for the next job only when a slot is free, so a job wanted later still goes first", async () => {
    const queue = ["background-1", "background-2"];
    const ran: string[] = [];
    const first = gate();
    const worker = createPullWorker<string>({
      concurrency: 1,
      next: () => queue.shift() ?? null,
      run: async (job) => {
        ran.push(job);
        if (job === "background-1") await first.done;
      },
    });

    worker.wake();
    queue.unshift("wanted");
    first.open();
    await worker.idle();

    expect(ran).toEqual(["background-1", "wanted", "background-2"]);
  });

  it("keeps going when a job throws, and logs it", async () => {
    const jobs = ["bad", "good"];
    const ran: string[] = [];
    const logged: unknown[] = [];
    const worker = createPullWorker<string>({
      concurrency: 1,
      next: () => jobs.shift() ?? null,
      run: (job) => (job === "bad" ? Promise.reject(new Error("broken")) : Promise.resolve(void ran.push(job))),
      onError: (job, error) => logged.push([job, error]),
    });

    worker.wake();
    await worker.idle();

    expect(ran).toEqual(["good"]);
    expect(logged).toHaveLength(1);
  });

  it("starts nothing after stop", async () => {
    const jobs = ["a"];
    const ran: string[] = [];
    const worker = createPullWorker<string>({ concurrency: 1, next: () => jobs.shift() ?? null, run: (job) => Promise.resolve(void ran.push(job)) });

    worker.stop();
    worker.wake();
    await worker.idle();

    expect(ran).toEqual([]);
  });
});
