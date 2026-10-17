// Saves the Learner's record, one save at a time. Grading and the Curriculum re-plan both write the
// whole record, so two saves in flight could land out of order and the older one would win. Records
// that pile up while a save is in flight collapse to the newest. A failure is reported (the app shows
// "not saved — retry") and the record is kept for the retry.
import type { LearnerRecord } from "@shared/learner.ts";
import type { Loaded } from "./lesson/api-client.ts";

export type SaveStatus = { readonly kind: "saved" } | { readonly kind: "saving" } | { readonly kind: "failed"; readonly message: string };

export class SaveQueue {
  private inFlight = false;
  private pending: LearnerRecord | null = null;
  /** The last record that failed to save: what a retry saves. */
  private failed: LearnerRecord | null = null;
  /** Waiting for the queue to go idle (`settled`). */
  private waiters: ((saved: boolean) => void)[] = [];

  constructor(
    private readonly saveRecord: (record: LearnerRecord) => Promise<Loaded<LearnerRecord>>,
    private readonly onStatus: (status: SaveStatus) => void,
  ) {}

  save(record: LearnerRecord): void {
    this.failed = null;
    this.pending = record;
    if (!this.inFlight) this.next();
  }

  /**
   * Resolves once every record handed to `save` so far has been saved or has failed: true when the
   * last one saved. For a request that needs the record on the server first (the Coach's Curriculum).
   */
  settled(): Promise<boolean> {
    if (!this.inFlight && this.pending === null) return Promise.resolve(this.failed === null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private idle(saved: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(saved);
  }

  /** Saves the record whose save failed, again. */
  retry(): void {
    if (this.failed !== null) this.save(this.failed);
  }

  private next(): void {
    const record = this.pending;
    if (record === null) return;
    this.pending = null;
    this.inFlight = true;
    this.onStatus({ kind: "saving" });
    // A save that throws (it should return a problem instead) is a failure too, never a stuck queue.
    const attempt = this.saveRecord(record).catch(
      (error: unknown): Loaded<LearnerRecord> => ({ ok: false, problem: { kind: "offline", message: `Saving the profile failed (${String(error)}).` } }),
    );
    void attempt.then((saved) => {
      this.inFlight = false;
      if (this.pending !== null) {
        // A newer record replaces this one, saved or not.
        this.next();
        return;
      }
      if (saved.ok) {
        this.onStatus({ kind: "saved" });
        this.idle(true);
        return;
      }
      console.warn(`[app] ${saved.problem.message}`);
      this.failed = record;
      this.onStatus({ kind: "failed", message: saved.problem.message });
      this.idle(false);
    });
  }
}
