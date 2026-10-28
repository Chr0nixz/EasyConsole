// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ApiClient } from "../../src/lib/api-client";
import { createEasyConsoleApi } from "../../src/lib/api-factory";
import { createNodeRuntime } from "../easy-console/node-runtime";
import { startMockConsole } from "./mock-console";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
async function fixture() {
  const mock = await startMockConsole();
  cleanups.push(mock.close);
  const client = new ApiClient(createNodeRuntime(), mock.baseUrl);
  const api = createEasyConsoleApi(client);
  const login = await api.authApi.login({ username: "local-acceptance", password: "synthetic-only" });
  client.setToken(login.token);
  return { ...mock, client, api };
}

describe("local HTTP acceptance: implemented features", () => {
  it("logs in, reads tasks, extends release safely and reads the result", async () => {
    const { api, requests, task } = await fixture();
    expect(await api.authApi.userInfo()).toMatchObject({ username: "local-acceptance" });
    expect((await api.instanceApi.tasks({ page: 1 })).items[0].id).toBe(42);
    const newTime = new Date(Date.now() + 3_600_000).toISOString();
    await api.instanceApi.updateTask(42, { releace_time: newTime });
    expect((await api.instanceApi.tasks({ page: 1 })).items[0].releace_time).toBe(newTime);
    expect(task.status).toBe(2);
    expect(requests.filter((item) => item.path === "/api/instance/task/42").map((item) => item.method)).toEqual(["PATCH"]);
  });

  it("does not fall back to the destructive PUT route when editing is unsupported", async () => {
    const { api, requests, task, setEditingSupported } = await fixture();
    setEditingSupported(false);
    await expect(api.instanceApi.updateTask(42, { releace_time: "2027-01-01 12:00:00" })).rejects.toThrow(/safe task editing|安全的任务编辑/);
    expect(requests.filter((item) => item.path === "/api/instance/task/42").map((item) => item.method)).toEqual(["PATCH"]);
    expect(task.status).toBe(2);
    // Capability detection is scoped to the endpoint, not another console.
    const second = await fixture();
    await expect(second.api.instanceApi.updateTask(42, { name: "other-console" })).resolves.toMatchObject({ name: "other-console" });
  });

  it("edits and deletes a synthetic image through real HTTP wrappers", async () => {
    const { api, requests } = await fixture();
    await api.imageApi.updateImage(11, { name: "accepted", description: "local only" });
    expect((await api.imageApi.list()).items).toContainEqual(expect.objectContaining({ id: 11, name: "accepted" }));
    await api.imageApi.deleteImage(11);
    expect((await api.imageApi.list()).items).toEqual([]);
    expect(requests.filter((item) => item.path === "/api/image/image/11").map((item) => item.method)).toEqual(["PUT", "DELETE"]);
  });

  it("accepts CLI get/wait and keeps image mutations dry-run until --yes", async () => {
    const mock = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "ec-cli-acceptance-"));
    cleanups.push(async () => {
      const target = resolve(dir);
      if (!target.startsWith(`${resolve(tmpdir())}${sep}ec-cli-acceptance-`)) throw new Error("Unexpected acceptance cleanup target");
      await rm(target, { recursive: true, force: true });
    });
    const run = async (...args: string[]) => {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "tools/easy-console/cli-entry.ts", "--json", "--api-base-url", mock.baseUrl, "--config", join(dir, "config.json"), ...args], {
        cwd: process.cwd(), timeout: 15_000, windowsHide: true,
        env: { ...process.env, EASY_CONSOLE_TOKEN: "local-acceptance-token", EASY_CONSOLE_LOCAL_DATA_PATH: join(dir, "data.json"), EASY_CONSOLE_RUN_LOG_PATH: join(dir, "logs.json"), EASY_CONSOLE_LANG: "en-US" },
      });
      return JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown> };
    };
    expect(await run("task", "get", "42")).toMatchObject({ ok: true, data: { task: { id: 42 }, ssh: { host: "127.0.0.1" } } });
    expect(await run("task", "wait", "42", "--timeout", "0")).toMatchObject({ ok: true, data: { outcome: "target", status: 2 } });
    expect(await run("image", "delete", "11")).toMatchObject({ ok: true, data: { dryRun: true } });
    expect(mock.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(await run("image", "update", "11", "--name", "cli-accepted", "--yes")).toMatchObject({ ok: true, data: { dryRun: false } });
    expect(await run("image", "delete", "11", "--yes")).toMatchObject({ ok: true, data: { dryRun: false } });
  }, 25_000);
});
