import { ApiClient } from "../../src/lib/api-client";
import { createEasyConsoleApi, type EasyConsoleApi } from "../../src/lib/api-factory";
import type { RuntimeTransport } from "../../src/lib/types";
import { loadEasyConsoleConfig, type EasyConsoleConfig, type EasyConsoleConfigOverrides } from "./config";
import { createNodeRuntime } from "./node-runtime";
import { createFileRunLogStorage, getDefaultRunLogPath } from "./run-log-store";

export type EasyConsoleContext = {
  api: EasyConsoleApi;
  client: ApiClient;
  config: EasyConsoleConfig;
  runLogStorage: RuntimeTransport["storage"];
  runLogPath: string;
};

export type EasyConsoleContextOptions = EasyConsoleConfigOverrides & {
  runtime?: RuntimeTransport;
  runLogPath?: string;
};

export async function createEasyConsoleContext(options: EasyConsoleContextOptions = {}): Promise<EasyConsoleContext> {
  const config = await loadEasyConsoleConfig(options);
  const client = new ApiClient(options.runtime ?? createNodeRuntime(), config.apiBaseUrl);
  client.setToken(config.token);
  return {
    api: createEasyConsoleApi(client),
    client,
    config,
    runLogPath: options.runLogPath ?? getDefaultRunLogPath(config.configPath),
    runLogStorage: createFileRunLogStorage(options.runLogPath ?? getDefaultRunLogPath(config.configPath)),
  };
}
