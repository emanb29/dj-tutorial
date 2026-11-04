/**
 * The key a track's enrichment is stored under: its content, never its path, so a renamed or moved
 * file keeps what was found for it.
 *
 * The same prefix scheme as the app's track hash (shared/track-hash.ts: SHA-256 of the first 4 MB,
 * then `|` and a suffix), with the file's size in bytes as the suffix instead of the decoded
 * duration, because this tool never decodes audio. The app never reads these keys.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const CONTENT_HASH_PREFIX_BYTES = 4 * 1024 * 1024;

export function contentHashOfBytes(prefix: Uint8Array, sizeBytes: number): string {
  return createHash("sha256").update(prefix.subarray(0, CONTENT_HASH_PREFIX_BYTES)).update(`|size=${String(sizeBytes)}`).digest("hex");
}

export async function contentHashOfFile(path: string): Promise<{ readonly hash: string; readonly size: number }> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const prefix = new Uint8Array(Math.min(size, CONTENT_HASH_PREFIX_BYTES));
    let read = 0;
    while (read < prefix.length) {
      const { bytesRead } = await file.read(prefix, read, prefix.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { hash: contentHashOfBytes(prefix.subarray(0, read), size), size };
  } finally {
    await file.close();
  }
}
