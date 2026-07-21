import { describe, expect, it } from "vitest";

import {
  assertTransportUrlAllowed,
  classifyTransportUrl,
  describeTransportViolation,
  isInsecureRemoteTransportUrl,
  isLoopbackHostname,
  isTransportUrlAllowed,
  shouldEnforceSecureRemoteTransport,
} from "./transport-security";

describe("transport-security", () => {
  it("detects loopback hostnames case-insensitively", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("116.172.93.164")).toBe(false);
  });

  it("classifies secure, loopback cleartext, remote cleartext, and invalid URLs", () => {
    expect(classifyTransportUrl("https://api.example.com/api")).toBe("secure");
    expect(classifyTransportUrl("wss://api.example.com/ws")).toBe("secure");
    expect(classifyTransportUrl("http://127.0.0.1:28080/api")).toBe("cleartext-loopback");
    expect(classifyTransportUrl("http://localhost:28080/api")).toBe("cleartext-loopback");
    expect(classifyTransportUrl("ws://[::1]:9000/ws")).toBe("cleartext-loopback");
    expect(classifyTransportUrl("http://116.172.93.164:28080/api")).toBe("cleartext-remote");
    expect(classifyTransportUrl("ws://example.com/ws")).toBe("cleartext-remote");
    expect(classifyTransportUrl("ftp://example.com")).toBe("invalid");
    expect(classifyTransportUrl("not-a-url")).toBe("invalid");
    expect(classifyTransportUrl("")).toBe("invalid");
  });

  it("allows https and loopback http even when enforceSecureRemote is on", () => {
    expect(isTransportUrlAllowed("https://api.example.com/api", { enforceSecureRemote: true })).toBe(true);
    expect(isTransportUrlAllowed("http://127.0.0.1:8080/api", { enforceSecureRemote: true })).toBe(true);
    expect(isTransportUrlAllowed("http://localhost/api", { enforceSecureRemote: true })).toBe(true);
  });

  it("rejects remote cleartext when enforceSecureRemote is on", () => {
    expect(isTransportUrlAllowed("http://116.172.93.164:28080/api", { enforceSecureRemote: true })).toBe(false);
    expect(isTransportUrlAllowed("http://example.com/api", { enforceSecureRemote: true })).toBe(false);
    expect(() => assertTransportUrlAllowed("http://example.com/api", { enforceSecureRemote: true })).toThrow(
      /HTTPS|明文|cleartext/i,
    );
  });

  it("allows remote cleartext when enforceSecureRemote is off", () => {
    expect(isTransportUrlAllowed("http://116.172.93.164:28080/api", { enforceSecureRemote: false })).toBe(true);
    expect(() => assertTransportUrlAllowed("http://example.com/api", { enforceSecureRemote: false })).not.toThrow();
  });

  it("rejects invalid URLs regardless of enforce flag", () => {
    expect(isTransportUrlAllowed("ftp://x", { enforceSecureRemote: false })).toBe(false);
    expect(isTransportUrlAllowed("ftp://x", { enforceSecureRemote: true })).toBe(false);
  });

  it("reports insecure remote transport for warnings", () => {
    expect(isInsecureRemoteTransportUrl("http://116.172.93.164:28080/api")).toBe(true);
    expect(isInsecureRemoteTransportUrl("https://api.example.com/api")).toBe(false);
    expect(isInsecureRemoteTransportUrl("http://127.0.0.1/api")).toBe(false);
    expect(describeTransportViolation("http://example.com/api")).toMatch(/HTTPS|明文|cleartext/i);
  });

  it("defaults enforce from Vite PROD when options omit enforceSecureRemote", () => {
    // Vitest / Vite test builds set PROD=false, so remote cleartext is allowed by default.
    expect(shouldEnforceSecureRemoteTransport()).toBe(false);
    expect(isTransportUrlAllowed("http://example.com/api")).toBe(true);
  });
});
