import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_HASH_PREFIX_BYTES, contentHashOfBytes, contentHashOfFile } from "./content-hash.ts";

describe("contentHash", () => {
  it("is SHA-256 of the first 4 MB, then |size= and the file's size in bytes", () => {
    const bytes = new Uint8Array(CONTENT_HASH_PREFIX_BYTES + 10).map((_, index) => index % 251);
    const expected = createHash("sha256").update(bytes.subarray(0, CONTENT_HASH_PREFIX_BYTES)).update(`|size=${String(bytes.length)}`).digest("hex");
    expect(contentHashOfBytes(bytes.subarray(0, CONTENT_HASH_PREFIX_BYTES), bytes.length)).toBe(expected);
  });

  it("reads only the prefix of a file, and tells files of different sizes apart", async () => {
    const folder = mkdtempSync(join(tmpdir(), "enrich-hash-"));
    const small = join(folder, "a.m4a");
    writeFileSync(small, "same bytes");
    const longer = join(folder, "b.m4a");
    writeFileSync(longer, "same bytes and more");
    const a = await contentHashOfFile(small);
    expect(a).toEqual({ hash: contentHashOfBytes(new TextEncoder().encode("same bytes"), 10), size: 10 });
    expect((await contentHashOfFile(longer)).hash).not.toBe(a.hash);
  });
});
