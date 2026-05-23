import { describe, expect, it } from "vitest";

import { sha256Hex } from "./crypto";

describe("crypto helpers", () => {
  it("hashes passwords as sha256 hex", async () => {
    expect(await sha256Hex("password")).toBe("5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8");
  });
});
