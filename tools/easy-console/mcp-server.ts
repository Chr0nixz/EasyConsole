import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerEasyConsoleTools } from "./mcp-tools";
import type { EasyConsoleMcpDeps } from "./mcp-tools";
import { registerEasyConsoleResources } from "./mcp-resources";

export function createEasyConsoleMcpServer(deps: EasyConsoleMcpDeps = {}) {
  const server = new McpServer({
    name: "easy-console",
    version: "0.2.1",
  });
  registerEasyConsoleTools(server, deps);
  registerEasyConsoleResources(server, deps);
  return server;
}

export async function runMcpServer() {
  const server = createEasyConsoleMcpServer();
  await server.connect(new StdioServerTransport());
}
