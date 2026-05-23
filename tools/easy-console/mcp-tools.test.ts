// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EasyConsoleContext } from "./context";
import { createMcpToolDefinitions, invokeMcpToolDefinition, toMcpJsonError, toMcpJsonResult } from "./mcp-tools";

function getTool(name: string) {
  const tool = createMcpToolDefinitions().find((definition) => definition.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function createFakeContext(overrides: Record<string, unknown> = {}) {
  const api = {
    authApi: {
      userInfo: async () => ({ username: "tester" }),
    },
    instanceApi: {
      tasks: async () => ({ items: [{ id: 7, description: "pod-7" }], raw: [] }),
      taskLog: async () => "log text",
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
    client: {},
    config: {
      apiBaseUrl: "http://host/api",
      token: null,
      configPath: "config.json",
      env: { apiBaseUrl: false, token: false },
    },
  } as unknown as EasyConsoleContext;
}

describe("easy-console MCP tools", () => {
  it("validates tool input with zod schemas", async () => {
    await expect(invokeMcpToolDefinition(getTool("easyconsole_task_log"), createFakeContext(), {})).rejects.toThrow();
  });

  it("does not call mutation APIs without confirm=true", async () => {
    let releaseCount = 0;
    const context = createFakeContext({
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
    });

    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_release"), context, { taskId: 7 });

    expect(result).toMatchObject({ dryRun: true, action: "task.release" });
    expect(releaseCount).toBe(0);
  });

  it("executes confirmed mutations", async () => {
    let releaseCount = 0;
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [], raw: [] }),
        taskLog: async () => "",
        createTask: async () => ({}),
        operateTask: async () => {
          releaseCount += 1;
          return { released: true };
        },
        deleteTask: async () => ({}),
      },
    });

    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_release"), context, { taskId: 7, confirm: true });

    expect(result).toMatchObject({ dryRun: false, action: "task.release", result: { released: true } });
    expect(releaseCount).toBe(1);
  });

  it("wraps MCP results as structured JSON text", () => {
    expect(JSON.parse(toMcpJsonResult({ ok: true }).content[0].text)).toEqual({
      ok: true,
      data: { ok: true },
      error: null,
    });
    expect(JSON.parse(toMcpJsonError(new Error("boom")).content[0].text)).toMatchObject({
      ok: false,
      data: null,
      error: { message: "boom" },
    });
  });
});
