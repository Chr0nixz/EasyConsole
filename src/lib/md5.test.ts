import { describe, expect, it } from "vitest";

import { md5ArrayBuffer } from "./md5";

describe("md5", () => {
  it("hashes array buffers", () => {
    const buffer = new TextEncoder().encode("abc").buffer;
    expect(md5ArrayBuffer(buffer)).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});
