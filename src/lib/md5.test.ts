import { describe, expect, it, vi } from "vitest";

import { createMd5Hasher, md5ArrayBuffer, md5Blob, MD5_BLOB_CHUNK_SIZE } from "./md5";

describe("md5", () => {
  it("hashes array buffers", () => {
    const buffer = new TextEncoder().encode("abc").buffer;
    expect(md5ArrayBuffer(buffer)).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("matches chunked hasher updates with full-buffer hash", () => {
    const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    const full = md5ArrayBuffer(bytes.buffer);
    const hasher = createMd5Hasher();
    hasher.update(bytes.slice(0, 10));
    hasher.update(bytes.slice(10));
    expect(hasher.digest()).toBe(full);
  });

  it("hashes blobs without loading the whole file via arrayBuffer", async () => {
    const payload = new Uint8Array(MD5_BLOB_CHUNK_SIZE + 123);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }
    const expected = md5ArrayBuffer(payload.buffer);
    const blob = new Blob([payload]);
    const arrayBufferSpy = vi.spyOn(Blob.prototype, "arrayBuffer");

    const hash = await md5Blob(blob, 64 * 1024);

    expect(hash).toBe(expected);
    expect(arrayBufferSpy).toHaveBeenCalled();
    for (const call of arrayBufferSpy.mock.instances) {
      expect((call as Blob).size).toBeLessThan(blob.size);
    }
    arrayBufferSpy.mockRestore();
  });
});
