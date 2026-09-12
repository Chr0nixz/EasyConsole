#!/usr/bin/env tsx

import { initToolLocale } from "./locale";
import { runMcpServer } from "./mcp-server";

initToolLocale();

await runMcpServer();
