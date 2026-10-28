import { ApiClient } from "../../src/lib/api-client";
import { makeAccountScope, type AccountScope } from "../../src/lib/account-scope";
import { createEasyConsoleApi, type EasyConsoleApi } from "../../src/lib/api-factory";
import type { RuntimeStorage, RuntimeTransport } from "../../src/lib/types";
import { loadEasyConsoleConfig, type EasyConsoleConfig, type EasyConsoleConfigOverrides } from "./config";
import { createEasyConsoleLocalStorages } from "./local-data-store";
import { createNodeRuntime } from "./node-runtime";
import { createFileRunLogStorage, getDefaultRunLogPath, migrateLegacyRunLogs } from "./run-log-store";

export type EasyConsoleContext = {
  api: EasyConsoleApi;
  client: ApiClient;
  config: EasyConsoleConfig;
  runLogStorage: RuntimeTransport["storage"];
  runLogPath: string;
  storage: RuntimeStorage;
  credentialStorage: RuntimeStorage;
  resolveAccountScope(): Promise<AccountScope>;
};

export type EasyConsoleContextOptions = EasyConsoleConfigOverrides & {
  runtime?: RuntimeTransport;
  runLogPath?: string;
};

export async function createEasyConsoleContext(options: EasyConsoleContextOptions = {}): Promise<EasyConsoleContext> {
  const config = await loadEasyConsoleConfig(options);
  const client = new ApiClient(options.runtime ?? createNodeRuntime(), config.apiBaseUrl);
  client.setToken(config.token);
  const { storage, credentialStorage, storagePath } = createEasyConsoleLocalStorages(config.configPath);
  const runLogPath = options.runLogPath || process.env.EASY_CONSOLE_RUN_LOG_PATH || undefined;
  if (!runLogPath) await migrateLegacyRunLogs(storage, storagePath, getDefaultRunLogPath(config.configPath));
  const api = createEasyConsoleApi(client);
  return {
    api,
    client,
    config,
    runLogPath: runLogPath ?? storagePath,
    runLogStorage: runLogPath ? createFileRunLogStorage(runLogPath) : storage,
    storage,
    credentialStorage,
    async resolveAccountScope() {
      const user = await api.authApi.userInfo();
      if (!user.username?.trim()) throw new Error("The authenticated username could not be verified; the scheduled task was not run.");
      return makeAccountScope(user.username, user.name ?? user.username, client.getBaseUrl());
    },
  };
}
