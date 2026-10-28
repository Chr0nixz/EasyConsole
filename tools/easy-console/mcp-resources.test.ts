// @vitest-environment node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { RESOURCE_PRESETS_STORAGE_KEY } from "../../src/lib/resource-presets";
import { TASK_TEMPLATES_STORAGE_KEY } from "../../src/lib/task-templates";
import type { EasyConsoleContext } from "./context";
import { createEasyConsoleMcpServer } from "./mcp-server";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map((fn) => fn())); });

function json(result: ReadResourceResult) {
  const content = result.contents[0];
  if (!("text" in content)) throw new Error("Expected a text resource");
  return JSON.parse(content.text) as unknown;
}

async function connect() {
  const values = new Map<string, string>();
  const storage = {
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async remove(key: string) { values.delete(key); },
  };
  const server = createEasyConsoleMcpServer({
    createContext: async () => ({ storage, runLogStorage: storage }) as EasyConsoleContext,
  });
  const client = new Client({ name: "local-acceptance", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close.push(() => client.close(), () => server.close());
  return { client, storage };
}

describe("MCP resources protocol", () => {
  it("advertises both collections and item URI templates on an empty store", async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.resources).toBeTruthy();
    const list = await client.listResources();
    expect(list.resources.map((item) => item.uri)).toEqual([
      "easyconsole://local/templates", "easyconsole://local/resource-presets",
    ]);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((item) => item.uriTemplate)).toEqual([
      "easyconsole://local/templates/{id}", "easyconsole://local/resource-presets/{id}",
    ]);
    const result = await client.readResource({ uri: "easyconsole://local/templates" });
    expect(json(result)).toEqual([]);
  });

  it("lists, reads and refreshes resource presets without writing or contacting an API", async () => {
    const { client, storage } = await connect();
    // eslint-disable-next-line easy-console/no-bare-cjk -- Unicode id fixture tests URI encoding, not UI copy.
    const preset = { id: "gpu/中文%1", name: "one GPU", cpu: 4, gpu: 1, memory: 16, createdAt: "2026-10-27", updatedAt: "2026-10-27" };
    await storage.set(RESOURCE_PRESETS_STORAGE_KEY, JSON.stringify([preset]));
    const uri = `easyconsole://local/resource-presets/${encodeURIComponent(preset.id)}`;
    expect((await client.listResources()).resources).toContainEqual(expect.objectContaining({ uri, name: preset.name }));
    const result = await client.readResource({ uri });
    expect(json(result)).toEqual(preset);
    await storage.set(RESOURCE_PRESETS_STORAGE_KEY, "[]");
    await expect(client.readResource({ uri })).rejects.toThrow("not found");
  });

  it("uses the template parser and returns a protocol error for missing items", async () => {
    const { client, storage } = await connect();
    await storage.set(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify([
      { id: "t1", name: "train", taskNamePrefix: "train", cpu: 4, gpu: 0, memory: 16, imageId: "1" },
      { broken: true },
    ]));
    const result = await client.readResource({ uri: "easyconsole://local/templates/t1" });
    expect(json(result)).toMatchObject({ id: "t1", name: "train", cpu: 4 });
    await expect(client.readResource({ uri: "easyconsole://local/templates/missing" })).rejects.toThrow("not found");
  });
});
