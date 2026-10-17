import { describe, expect, it } from "vitest";
import { CONTENT_HASH_PREFIX_BYTES, hashTrackBytes } from "./track-hash.ts";

describe("hashTrackBytes", () => {
  it("is the SHA-256 of the bytes, a '|' and the duration in ms, as lowercase hex", async () => {
    // Independent value: printf 'abc|duration-ms=1500' | sha256sum
    expect(await hashTrackBytes(new TextEncoder().encode("abc"), 1.5)).toBe(
      "e4dc408e6c8f931ea4e34410aa2f284d4bf4fd49e5b628e2fedc545776b10fc7",
    );
  });

  it("reads only the first 4 MB, so a change after it keeps the key", async () => {
    const bytes = Uint8Array.from({ length: CONTENT_HASH_PREFIX_BYTES + 100 }, (_, index) => index % 251);
    const tailChanged = bytes.slice();
    tailChanged[CONTENT_HASH_PREFIX_BYTES + 5] = 9;
    const headChanged = bytes.slice();
    headChanged[0] = 9;

    const key = await hashTrackBytes(bytes, 300);
    expect(await hashTrackBytes(tailChanged, 300)).toBe(key);
    expect(await hashTrackBytes(headChanged, 300)).not.toBe(key);
    expect(await hashTrackBytes(bytes, 300.002)).not.toBe(key);
  });

  it("accepts an ArrayBuffer or a view into a larger buffer", async () => {
    const whole = new TextEncoder().encode("xxabcxx");
    const view = whole.subarray(2, 5);

    expect(await hashTrackBytes(view, 1.5)).toBe(await hashTrackBytes(new TextEncoder().encode("abc").buffer, 1.5));
  });
});
