import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerEasyConsoleTools } from "./mcp-tools";

export function createEasyConsoleMcpServer() {
  const server = new McpServer({
    name: "easy-console",
    version: "0.2.1",
  });
  registerEasyConsoleTools(server);
  return server;
}

export async function runMcpServer() {
  const server = createEasyConsoleMcpServer();
  await server.connect(new StdioServerTransport());
}
