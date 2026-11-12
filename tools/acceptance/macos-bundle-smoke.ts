import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bundleArgument = process.argv[2];
if (!bundleArgument) throw new Error("Usage: macos-bundle-smoke.ts <macOS-app-bundle>");
const bundle = resolve(bundleArgument);
const binaries = join(bundle, "Contents", "MacOS");
const timeout = 15_000;

// Test the executables after Tauri signs them: a valid signature alone does
// not catch a hardened Node sidecar crashing when V8 starts.
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { timeout, stdio: "inherit" });
const profile = await mkdtemp(join(tmpdir(), "easyconsole-bundle-smoke-"));
const env = {
  EASY_CONSOLE_CONFIG: join(profile, "config.json"),
  EASY_CONSOLE_LOCAL_DATA_PATH: join(profile, "runtime-storage.json"),
  EASY_CONSOLE_RUN_LOG_PATH: join(profile, "run-logs.json"),
  EASY_CONSOLE_API_BASE_URL: "https://acceptance.invalid/api",
  EASY_CONSOLE_TOKEN: "",
  EASY_CONSOLE_LANG: "en-US",
};

const client = new Client({ name: "easyconsole-macos-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: join(binaries, "easy-console-mcp"), cwd: profile, env });
try {
  const output = execFileSync(join(binaries, "easy-console-cli"), ["--json", "template", "list"], {
    encoding: "utf8", cwd: profile, env, timeout,
  });
  assert.deepEqual(JSON.parse(output), { ok: true, data: [], error: null });
  await client.connect(transport, { timeout });
  assert.equal(client.getServerVersion()?.name, "easy-console");
  const { tools } = await client.listTools({}, { timeout });
  assert.ok(tools.some((tool) => tool.name === "easyconsole_task_list"));
  console.log(`Verified macOS bundle, CLI and MCP (${tools.length} tools).`);
} finally {
  await transport.close();
  await rm(profile, { recursive: true, force: true });
}
