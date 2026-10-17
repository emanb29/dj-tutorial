import { describe, expect, it } from "vitest";
import { emptyLearnerRecord, type LearnerRecord } from "@shared/learner.ts";
import type { Loaded } from "./lesson/api-client.ts";
import { SaveQueue, type SaveStatus } from "./save-queue.ts";

/** A save we resolve by hand, to see what is in flight. */
function manualSaver() {
  const calls: { record: LearnerRecord; finish: (ok: boolean) => void }[] = [];
  const save = (record: LearnerRecord) =>
    new Promise<Loaded<LearnerRecord>>((resolve) => {
      calls.push({
        record,
        finish: (ok) => {
          resolve(ok ? { ok: true, value: record } : { ok: false, problem: { kind: "refused", status: 500, message: "Saving the profile failed with HTTP 500." } });
        },
      });
    });
  return { save, calls };
}

const record = (mission: string): LearnerRecord => ({ ...emptyLearnerRecord("default"), mission });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the profile save queue", () => {
  it("saves one record at a time, and only the newest of those that piled up meanwhile", async () => {
    const saver = manualSaver();
    const statuses: SaveStatus[] = [];
    const queue = new SaveQueue(saver.save, (status) => statuses.push(status));
    queue.save(record("graded"));
    queue.save(record("replanned once"));
    queue.save(record("replanned twice"));
    expect(saver.calls.map((call) => call.record.mission)).toEqual(["graded"]);
    saver.calls[0]?.finish(true);
    await settle();
    expect(saver.calls.map((call) => call.record.mission)).toEqual(["graded", "replanned twice"]);
    saver.calls[1]?.finish(true);
    await settle();
    expect(statuses.at(-1)).toEqual({ kind: "saved" });
  });

  it("reports a failed save, keeps the record, and saves it again on retry", async () => {
    const saver = manualSaver();
    const statuses: SaveStatus[] = [];
    const queue = new SaveQueue(saver.save, (status) => statuses.push(status));
    queue.save(record("passed"));
    expect(statuses.at(-1)).toEqual({ kind: "saving" });
    saver.calls[0]?.finish(false);
    await settle();
    expect(statuses.at(-1)).toEqual({ kind: "failed", message: "Saving the profile failed with HTTP 500." });
    queue.retry();
    expect(saver.calls.map((call) => call.record.mission)).toEqual(["passed", "passed"]);
    saver.calls[1]?.finish(true);
    await settle();
    expect(statuses.at(-1)).toEqual({ kind: "saved" });
  });

  it("treats a save that throws as failed, and keeps saving afterwards", async () => {
    const statuses: SaveStatus[] = [];
    let calls = 0;
    const queue = new SaveQueue(
      (saved) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ ok: true, value: saved });
      },
      (status) => statuses.push(status),
    );
    queue.save(record("first"));
    await settle();
    expect(statuses.at(-1)).toMatchObject({ kind: "failed" });
    queue.save(record("second"));
    await settle();
    expect(statuses.at(-1)).toEqual({ kind: "saved" });
  });

  it("does not report a failure that a newer save already replaced", async () => {
    const saver = manualSaver();
    const statuses: SaveStatus[] = [];
    const queue = new SaveQueue(saver.save, (status) => statuses.push(status));
    queue.save(record("old"));
    queue.save(record("new"));
    saver.calls[0]?.finish(false);
    await settle();
    expect(statuses.some((status) => status.kind === "failed")).toBe(false);
    saver.calls[1]?.finish(true);
    await settle();
    expect(statuses.at(-1)).toEqual({ kind: "saved" });
  });
});
