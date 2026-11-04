/**
 * One pass at a time per data folder: a lock file holding the owner's PID. A lock whose process is
 * gone (a crash, a reboot) is stale and taken over.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const lockPath = (dataDir: string) => join(dataDir, "run.lock");

export type LockResult = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly holder: number };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function acquireLock(dataDir: string, pid = process.pid, isAlive: (pid: number) => boolean = alive): LockResult {
  mkdirSync(dataDir, { recursive: true });
  const path = lockPath(dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = openSync(path, "wx");
      writeSync(file, `${String(pid)}\n`);
      closeSync(file);
      const release = () => {
        rmSync(path, { force: true });
      };
      return { ok: true, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) return { ok: false, holder };
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take ${path}: another pass keeps taking it. Check for a running pass, then remove the file.`);
}
