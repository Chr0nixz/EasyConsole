// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EasyConsoleContext } from "./context";
import { runCli } from "./cli";
import type { RuntimeStorage } from "../../src/lib/types";

function memoryStorage(): RuntimeStorage {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

function createFakeContext(overrides: Record<string, unknown> = {}) {
  const api = {
    authApi: {
      userInfo: async () => ({ username: "tester" }),
      login: async () => ({ data: {}, token: "Bearer saved-token" }),
    },
    instanceApi: {
      tasks: async () => ({ items: [{ id: 1, name: "task-1" }], raw: [] }),
      taskLog: async () => "hello log",
      createTask: async () => ({ created: true }),
      operateTask: async () => ({ released: true }),
      deleteTask: async () => ({ deleted: true }),
    },
    storageApi: {
      list: async () => ({ items: [], raw: [] }),
      transmit: async () => new Blob(["hello"]),
      mkdir: async () => ({ created: true }),
      delete: async () => ({ deleted: true }),
    },
    imageApi: {
      list: async () => ({ items: [], raw: [] }),
      system: async () => ({ items: [], raw: [] }),
      setDefault: async () => ({ ok: true }),
    },
    resourceApi: {
      resources: async () => [],
      prices: async () => [],
    },
    ...overrides,
  };
  return {
    api,
    client: {
      setToken() {},
    },
    config: {
      apiBaseUrl: "http://host/api",
      token: null,
      configPath: "config.json",
      env: { apiBaseUrl: false, token: false },
    },
    runLogPath: "run-logs.json",
    runLogStorage: memoryStorage(),
  } as unknown as EasyConsoleContext;
}

describe("easy-console cli", () => {
  it("prints JSON success envelopes", async () => {
    const result = await runCli(["--json", "whoami"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      data: { username: "tester" },
      error: null,
    });
  });

  it("returns dry-run data for mutations without --yes", async () => {
    let releaseCount = 0;
    const result = await runCli(["--json", "task", "release", "42"], {
      createContext: async () =>
        createFakeContext({
          instanceApi: {
            tasks: async () => ({ items: [], raw: [] }),
            taskLog: async () => "",
            createTask: async () => ({}),
            operateTask: async () => {
              releaseCount += 1;
              return {};
            },
            deleteTask: async () => ({}),
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "task.release" });
    expect(releaseCount).toBe(0);
  });

  it("prints JSON error envelopes and non-zero exit codes", async () => {
    const result = await runCli(["--json", "whoami"], {
      createContext: async () => {
        throw new Error("missing token");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      data: null,
      error: { message: "missing token" },
    });
  });

  it("lists local run logs", async () => {
    const context = createFakeContext();
    const result = await runCli(["--json", "whoami"], {
      createContext: async () => context,
    });
    expect(result.exitCode).toBe(0);

    const logs = await runCli(["--json", "run-log", "list", "--limit", "10"], {
      createContext: async () => context,
    });

    expect(logs.exitCode).toBe(0);
    const payload = JSON.parse(logs.stdout) as { data: Array<{ action: string; channel: string }> };
    expect(payload.data[0]).toMatchObject({ action: "whoami", channel: "cli" });
  });
});
