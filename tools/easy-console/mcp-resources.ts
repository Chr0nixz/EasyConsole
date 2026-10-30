import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { loadResourcePresets } from "../../src/lib/resource-presets";
import { loadTaskTemplates } from "../../src/lib/task-templates";
import { getDefaultConfigPath } from "./config";
import { createEasyConsoleLocalStorages } from "./local-data-store";
import type { EasyConsoleMcpDeps } from "./mcp-tools";

/** Read-only local resources: the same store used by the template tools. */
export function registerEasyConsoleResources(server: McpServer, deps: EasyConsoleMcpDeps = {}) {
  // Reading local resources must work without a token or an insecure-HTTP opt-in.
  const storage = async () => deps.createContext
    ? (await deps.createContext()).storage
    : createEasyConsoleLocalStorages(process.env.EASY_CONSOLE_CONFIG ?? getDefaultConfigPath()).storage;
  const collections = [
    { name: "templates", title: "Task templates", load: loadTaskTemplates },
    { name: "resource-presets", title: "Resource presets", load: loadResourcePresets },
  ] as const;

  for (const collection of collections) {
    const baseUri = `easyconsole://local/${collection.name}`;
    const metadata = {
      title: collection.title,
      description: `${collection.title} from the shared EasyConsole local store. Read-only. Scheduled tasks are not automatically executed by the CLI/MCP sidecar.`,
      mimeType: "application/json",
    };
    const load = async () => collection.load(await storage());
    const contents = (uri: URL, value: unknown) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
    });

    server.registerResource(collection.name, baseUri, metadata, async (uri) => contents(uri, await load()));
    server.registerResource(
      `${collection.name}-item`,
      new ResourceTemplate(`${baseUri}/{id}`, {
        list: async () => ({
          resources: (await load()).map((item) => ({
            uri: `${baseUri}/${encodeURIComponent(item.id)}`,
            name: item.name,
            mimeType: "application/json",
          })),
        }),
      }),
      metadata,
      async (uri) => {
        // Decode exactly once; ids may contain slashes, percent signs or CJK.
        const id = decodeURIComponent(uri.pathname.slice(`/${collection.name}/`.length));
        const item = (await load()).find((entry) => entry.id === id);
        if (!item) throw new McpError(ErrorCode.InvalidParams, `Local ${collection.name} item not found.`);
        return contents(uri, item);
      },
    );
  }
}
