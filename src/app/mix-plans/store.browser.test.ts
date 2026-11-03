import { afterEach, describe, expect, it, vi } from "vitest";
import type { MixPlan } from "@shared/mix-plan.ts";
import { testPlan } from "@shared/mix-plan-test-support.ts";
import { createMixPlanStore, MAX_MIX_PLANS, MIX_PLANS_DATABASE, type MixPlanStore } from "./store.ts";

let opened: { store: MixPlanStore; name: string }[] = [];

function freshStore(maxPlans?: number) {
  const name = `dj-tutorial-mix-plans-test-${crypto.randomUUID()}`;
  const store = createMixPlanStore({ databaseName: name, ...(maxPlans === undefined ? {} : { maxPlans }) });
  opened.push({ store, name });
  return { store, name };
}

const named = (plan: MixPlan, id: string, name: string, updatedAt = plan.updatedAt): MixPlan => ({ ...plan, id, name, updatedAt });

afterEach(async () => {
  for (const { store, name } of opened) {
    await store.close();
    indexedDB.deleteDatabase(name);
  }
  opened = [];
  vi.restoreAllMocks();
});

describe("the Mix Plan store (IndexedDB)", () => {
  it("is the dj-tutorial-mix-plans database, holding up to 200 plans", () => {
    expect(MIX_PLANS_DATABASE).toBe("dj-tutorial-mix-plans");
    expect(MAX_MIX_PLANS).toBe(200);
  });

  it("creates, lists newest first, renames and deletes plans", async () => {
    const { store } = freshStore();
    const { plan } = testPlan(3);
    const older = named(plan, "a", "Warm-up", "2026-11-01T10:00:00.000Z");
    const newer = named(plan, "b", "Peak", "2026-11-02T10:00:00.000Z");

    expect(await store.save(older)).toEqual({ ok: true });
    expect(await store.save(newer)).toEqual({ ok: true });
    expect((await store.list()).map((entry) => (entry.ok ? entry.plan.name : null))).toEqual(["Peak", "Warm-up"]);

    expect(await store.save({ ...older, name: "Opening", updatedAt: "2026-11-03T10:00:00.000Z" })).toEqual({ ok: true });
    expect((await store.list()).map((entry) => (entry.ok ? entry.plan.name : null))).toEqual(["Opening", "Peak"]);
    expect(await store.get("a")).toEqual({ ok: true, plan: { ...older, name: "Opening", updatedAt: "2026-11-03T10:00:00.000Z" }, migratedFrom: null });

    await store.delete("b");
    expect(await store.get("b")).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps a 25-track plan whole", async () => {
    const { store } = freshStore();
    const { plan } = testPlan(25);
    await store.save(plan);
    expect(await store.get(plan.id)).toEqual({ ok: true, plan, migratedFrom: null });
  });

  it("refuses a new plan once full, with a message, but still saves changes to one it has", async () => {
    const { store } = freshStore(3);
    const { plan } = testPlan(2);
    for (const id of ["1", "2", "3"]) expect(await store.save(named(plan, id, `Plan ${id}`))).toEqual({ ok: true });

    const refused = await store.save(named(plan, "4", "Plan 4"));

    expect(refused).toEqual({
      ok: false,
      error: {
        kind: "store-full",
        message: "This device already keeps 3 Mix Plans, the most it holds.",
        fix: "Delete a plan you no longer need (download it first to keep a copy), then save again.",
      },
    });
    expect(await store.list()).toHaveLength(3);
    expect(await store.save(named(plan, "2", "Plan 2, renamed"))).toEqual({ ok: true });
    expect(await store.get("2")).toMatchObject({ ok: true, plan: { name: "Plan 2, renamed" } });
  });

  it("lists a plan it cannot read (from a newer version) so it can be deleted", async () => {
    const { store, name } = freshStore();
    const { plan } = testPlan(2);
    await store.save(plan);
    await store.close();
    // Written as a newer app version would.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => {
        const transaction = request.result.transaction("plans", "readwrite");
        transaction.objectStore("plans").put({ ...plan, id: "future", version: 9 });
        transaction.oncomplete = () => {
          request.result.close();
          resolve();
        };
        transaction.onerror = () => {
          reject(transaction.error ?? new Error("write failed"));
        };
      };
      request.onerror = () => {
        reject(request.error ?? new Error("open failed"));
      };
    });

    const listed = await store.list();

    expect(listed).toHaveLength(2);
    expect(listed.find((entry) => !entry.ok)).toMatchObject({ ok: false, id: "future", problems: [{ kind: "newer-version" }] });
    await store.delete("future");
    expect(await store.list()).toHaveLength(1);
  });

  it("never touches the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { store } = freshStore();
    const { plan } = testPlan(3);
    await store.save(plan);
    await store.list();
    await store.get(plan.id);
    await store.delete(plan.id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
