// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendRunLog, clearRunLogs, loadRunLogs } from "../../src/lib/run-logs";
import { makeAccountScope } from "../../src/lib/account-scope";
import { listExecutionLedger } from "../../src/lib/execution-ledger";
import { createScheduledTask, loadScheduledTasks, saveScheduledTasks } from "../../src/lib/scheduled-tasks";
import { runCli } from "./cli";
import { createEasyConsoleContext } from "./context";

let directory: string;
let sharedPath: string;
let configPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ec-shared-context-"));
  sharedPath = join(directory, "desktop", "runtime-storage.json");
  configPath = join(directory, "sidecar", "config.json");
  await mkdir(dirname(configPath));
  vi.stubEnv("EASY_CONSOLE_LOCAL_DATA_PATH", sharedPath);
  vi.stubEnv("EASY_CONSOLE_TOKEN", "");
  vi.stubEnv("EASY_CONSOLE_RUN_LOG_PATH", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
});

const createContext = () => createEasyConsoleContext({ configPath, apiBaseUrl: "https://console.example.test/api" });

describe("shared sidecar context", () => {
  it("uses shared ordinary data and logs with a separate credential adapter", async () => {
    const first = await createContext();
    const second = await createContext();
    expect(first.runLogStorage).toBe(first.storage);
    await first.storage.set("ordinary", "from-cli");
    expect(await second.storage.get("ordinary")).toBe("from-cli");
    await first.credentialStorage.set("easy-console.token", "test-credential");
    expect(await second.credentialStorage.get("easy-console.token")).toBe("test-credential");
    await expect(second.storage.get("easy-console.token")).rejects.toThrow(/separate credential store/);
    await appendRunLog(first.runLogStorage, {
      action: "shared.test", source: "system", channel: "cli", title: "test", result: "success", level: "info",
    });
    expect(await loadRunLogs(second.storage)).toHaveLength(1);
  });

  it("routes a CLI backup's credentials outside the shared store and exports them only to a file", async () => {
    const context = await createContext();
    const backupPath = join(directory, "backup.json");
    await writeFile(backupPath, JSON.stringify({
      app: "EasyConsole", version: 1, includeSecrets: true, exportedAt: new Date().toISOString(),
      items: { token: "test-backup-token", taskTemplates: [{ id: "template-1", name: "train", taskNamePrefix: "train", cpu: 4, gpu: 1, memory: 16 }] },
    }));
    const imported = await runCli(["--json", "backup", "import", backupPath, "--sections", "taskTemplates,token", "--include-secrets", "--yes"], {
      createContext: async () => context,
    });
    expect(imported.exitCode).toBe(0);
    expect(await context.credentialStorage.get("easy-console.token")).toBe("test-backup-token");
    expect(await context.storage.get("easy-console.taskTemplates")).toContain("template-1");
    const tokenFile = `${createHash("sha256").update("easy-console.token").digest("hex")}.json`;
    await expect(readFile(join(dirname(sharedPath), "runtime-storage.d", tokenFile))).rejects.toMatchObject({ code: "ENOENT" });

    const exportedPath = join(directory, "export.json");
    const exported = await runCli(["--json", "backup", "export", "--include-secrets", "--output", exportedPath], {
      createContext: async () => context,
    });
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).not.toContain("test-backup-token");
    expect(JSON.parse(await readFile(exportedPath, "utf8")).items.token).toBe("test-backup-token");
  });

  it("merges legacy run logs once and never restores them after the user clears the shared log", async () => {
    const legacyLogPath = join(dirname(configPath), "run-logs.json");
    const snapshot = JSON.stringify([
      { id: "old-cli", createdAt: new Date().toISOString(), action: "old", title: "Old CLI entry", channel: "cli" },
    ]);
    await writeFile(legacyLogPath, snapshot);
    const context = await createContext();
    expect((await loadRunLogs(context.storage)).map((entry) => entry.id)).toEqual(["old-cli"]);
    await appendRunLog(context.storage, { action: "new", title: "New entry", source: "system", channel: "mcp", level: "info", result: "success" });
    expect(await loadRunLogs((await createContext()).storage)).toHaveLength(2);
    expect(await readFile(legacyLogPath, "utf8")).toBe(snapshot);
    await clearRunLogs(context.storage);
    expect(await loadRunLogs((await createContext()).storage)).toEqual([]);
  });

  it("honors an explicit separate run-log file", async () => {
    const customLogPath = join(directory, "custom-log.json");
    const context = await createEasyConsoleContext({ configPath, apiBaseUrl: "https://console.example.test/api", runLogPath: customLogPath });
    expect(context.runLogStorage).not.toBe(context.storage);
    await appendRunLog(context.runLogStorage, { action: "custom", title: "Custom entry", source: "system", channel: "cli", level: "info", result: "success" });
    expect(await loadRunLogs(context.runLogStorage)).toHaveLength(1);
    expect(await loadRunLogs(context.storage)).toEqual([]);
  });

  it.each(["same", "foreign", "other-realm", "legacy"])("checks the authenticated account before a confirmed run of a %s-owner plan", async (ownerKind) => {
    const context = await createContext();
    const userInfo = vi.spyOn(context.api.authApi, "userInfo").mockResolvedValue({ username: "bob", name: "Bob" });
    const createTask = vi.spyOn(context.api.instanceApi, "createTask").mockResolvedValue({ id: "local-test-remote" });
    const mismatched = ownerKind === "foreign" || ownerKind === "other-realm";
    const owner = ownerKind === "legacy" ? undefined : makeAccountScope(ownerKind === "foreign" ? "alice" : "bob", ownerKind,
      ownerKind === "other-realm" ? "https://other.example.test/api" : context.config.apiBaseUrl);
    const plan = createScheduledTask({ name: "shared plan", payload: { name: "shared-task" }, scheduleTime: new Date().toISOString(), owner });
    await saveScheduledTasks(context.storage, [plan]);
    const preview = await runCli(["--json", "schedule", "run", plan.id], { createContext: async () => context });
    expect(preview.exitCode).toBe(0);
    expect(userInfo).not.toHaveBeenCalled();

    const result = await runCli(["--json", "schedule", "run", plan.id, "--yes"], { createContext: async () => context });
    expect(result.exitCode).toBe(0);
    expect(userInfo).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledTimes(mismatched ? 0 : 1);
    expect((await loadScheduledTasks(context.storage))[0].status).toBe(mismatched ? "needs_review" : "done");
    if (!mismatched) {
      expect((await listExecutionLedger(context.storage))[0].accountKey).toBe(makeAccountScope("bob", "Bob", context.config.apiBaseUrl).key);
    }
  });

  it("refuses a confirmed run when the token's username cannot be verified", async () => {
    const context = await createContext();
    vi.spyOn(context.api.authApi, "userInfo").mockResolvedValue({});
    const createTask = vi.spyOn(context.api.instanceApi, "createTask");
    const plan = createScheduledTask({ name: "legacy", payload: { name: "local-test" }, scheduleTime: new Date().toISOString() });
    await saveScheduledTasks(context.storage, [plan]);
    const result = await runCli(["--json", "schedule", "run", plan.id, "--yes"], { createContext: async () => context });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("username could not be verified");
    expect(createTask).not.toHaveBeenCalled();
    expect((await loadScheduledTasks(context.storage))[0].status).toBe("pending");
  });
});
