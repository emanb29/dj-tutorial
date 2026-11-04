import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, lockPath } from "./lock.ts";

describe("acquireLock", () => {
  it("lets one pass in, refuses a second while the first is alive, and frees the lock on release", () => {
    const data = mkdtempSync(join(tmpdir(), "enrich-lock-"));
    const first = acquireLock(data, 111, () => true);
    expect(first.ok).toBe(true);
    expect(acquireLock(data, 222, () => true)).toEqual({ ok: false, holder: 111 });
    if (first.ok) first.release();
    expect(existsSync(lockPath(data))).toBe(false);
    expect(acquireLock(data, 222, () => true).ok).toBe(true);
  });

  it("takes over a stale lock whose process is gone", () => {
    const data = mkdtempSync(join(tmpdir(), "enrich-lock-"));
    writeFileSync(lockPath(data), "999999\n");
    expect(acquireLock(data, 333, () => false).ok).toBe(true);
  });
});
