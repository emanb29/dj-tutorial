import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Writes JSON so a reader sees either the old file or the new one, never half of one: write a
 * temp file in the same directory, flush it to disk, then rename it over the target.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** `undefined` when the file does not exist; any other failure (including bad JSON) throws. */
export async function readJsonIfPresent(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Runs async tasks one at a time, in order, so writes to one file never interleave. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
