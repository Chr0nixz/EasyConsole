import { describe, expect, it } from "vitest";

import { resolveUploadResumeOffset, UPLOAD_CHUNK_SIZE } from "./api-factory";

describe("resolveUploadResumeOffset", () => {
  it("uses the first missing chunk index for sparse uploadedChunks", () => {
    expect(resolveUploadResumeOffset([0, 2], UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE * 4)).toBe(UPLOAD_CHUNK_SIZE);
  });

  it("returns file size when all chunks are present", () => {
    expect(resolveUploadResumeOffset([0, 1], UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE * 2)).toBe(UPLOAD_CHUNK_SIZE * 2);
  });

  it("does not treat array length as contiguous offset", () => {
    expect(resolveUploadResumeOffset([5, 6], UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE * 8)).toBe(0);
  });
});
