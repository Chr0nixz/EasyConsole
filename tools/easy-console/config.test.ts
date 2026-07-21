import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCliApiBaseUrlAllowed, loadEasyConsoleConfig } from "./config";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("easy-console config transport security", () => {
  it("allows https and loopback http without opt-in", () => {
    expect(() => assertCliApiBaseUrlAllowed("https://api.example.com/api", false)).not.toThrow();
    expect(() => assertCliApiBaseUrlAllowed("http://127.0.0.1:28080/api", false)).not.toThrow();
    expect(() => assertCliApiBaseUrlAllowed("http://localhost:28080/api", false)).not.toThrow();
  });

  it("rejects remote cleartext without opt-in", () => {
    expect(() => assertCliApiBaseUrlAllowed("http://116.172.93.164:28080/api", false)).toThrow(/allow-insecure-http|EASY_CONSOLE_ALLOW_INSECURE_HTTP/i);
  });

  it("allows remote cleartext with opt-in", () => {
    expect(() => assertCliApiBaseUrlAllowed("http://116.172.93.164:28080/api", true)).not.toThrow();
  });

  it("loads loopback api base without insecure flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easy-console-config-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ apiBaseUrl: "http://127.0.0.1:28080/api" }), "utf8");
    delete process.env.EASY_CONSOLE_API_BASE_URL;
    delete process.env.EASY_CONSOLE_ALLOW_INSECURE_HTTP;

    const config = await loadEasyConsoleConfig({ configPath });
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:28080/api");
    expect(config.allowInsecureHttp).toBe(false);
  });

  it("rejects remote default without opt-in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easy-console-config-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ apiBaseUrl: "http://116.172.93.164:28080/api" }), "utf8");
    delete process.env.EASY_CONSOLE_API_BASE_URL;
    delete process.env.EASY_CONSOLE_ALLOW_INSECURE_HTTP;

    await expect(loadEasyConsoleConfig({ configPath })).rejects.toThrow(/allow-insecure-http|EASY_CONSOLE_ALLOW_INSECURE_HTTP/i);
  });

  it("allows remote http when override or env opt-in is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easy-console-config-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ apiBaseUrl: "http://example.com/api" }), "utf8");
    delete process.env.EASY_CONSOLE_API_BASE_URL;

    const viaOverride = await loadEasyConsoleConfig({ configPath, allowInsecureHttp: true });
    expect(viaOverride.allowInsecureHttp).toBe(true);

    process.env.EASY_CONSOLE_ALLOW_INSECURE_HTTP = "1";
    const viaEnv = await loadEasyConsoleConfig({ configPath });
    expect(viaEnv.allowInsecureHttp).toBe(true);
  });
});
