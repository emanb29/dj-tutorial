/**
 * The content hash that keys a track's cached analysis: the one implementation. Track sources
 * (src/tracks) compute it when they load a track; the analysis cache (src/analysis/cache.ts)
 * re-exports it and looks results up by it.
 *
 * Format, pinned by track-hash.test.ts: SHA-256, as lowercase hex, of the first 4 MB of the encoded
 * file, then `|duration-ms=` and the decoded duration rounded to the millisecond. Changing it loses
 * every cached analysis, so don't.
 */

/** Enough of the file to tell tracks apart without reading all of a long one. */
export const CONTENT_HASH_PREFIX_BYTES = 4 * 1024 * 1024;

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the first CONTENT_HASH_PREFIX_BYTES of `bytes`, then `|` and `suffix`. */
export function hashPrefixWith(bytes: Uint8Array, suffix: string): Promise<string> {
  const prefix = bytes.subarray(0, CONTENT_HASH_PREFIX_BYTES);
  const tail = new TextEncoder().encode(`|${suffix}`);
  const message = new Uint8Array(prefix.length + tail.length);
  message.set(prefix);
  message.set(tail, prefix.length);
  return sha256Hex(message);
}

/** The key for an encoded file. Prefer it: it does not depend on the rate the file was decoded at. */
export function hashTrackBytes(bytes: ArrayBuffer | ArrayBufferView, durationSec: number): Promise<string> {
  const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return hashPrefixWith(view, `duration-ms=${String(Math.round(durationSec * 1000))}`);
}
