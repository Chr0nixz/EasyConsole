import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_API_BASE_URL, normalizeToken } from "../../src/lib/api-client";

export type EasyConsoleConfigFile = {
  apiBaseUrl?: string;
  token?: string | null;
};

export type EasyConsoleConfig = {
  apiBaseUrl: string;
  token: string | null;
  configPath: string;
  env: {
    apiBaseUrl: boolean;
    token: boolean;
  };
};

export type EasyConsoleConfigOverrides = {
  apiBaseUrl?: string;
  token?: string | null;
  configPath?: string;
};

export function getDefaultConfigPath() {
  return join(homedir(), ".easy-console", "config.json");
}

function readEnvironment() {
  return {
    apiBaseUrl: process.env.EASY_CONSOLE_API_BASE_URL,
    token: process.env.EASY_CONSOLE_TOKEN,
    configPath: process.env.EASY_CONSOLE_CONFIG,
  };
}

function normalizeOptionalToken(token?: string | null) {
  if (!token) return null;
  return normalizeToken(token);
}

async function readConfigFile(configPath: string): Promise<EasyConsoleConfigFile> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as EasyConsoleConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function loadEasyConsoleConfig(overrides: EasyConsoleConfigOverrides = {}): Promise<EasyConsoleConfig> {
  const env = readEnvironment();
  const configPath = overrides.configPath ?? env.configPath ?? getDefaultConfigPath();
  const file = await readConfigFile(configPath);
  const apiBaseUrl = overrides.apiBaseUrl ?? env.apiBaseUrl ?? file.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const token = normalizeOptionalToken(overrides.token ?? env.token ?? file.token ?? null);

  return {
    apiBaseUrl,
    token,
    configPath,
    env: {
      apiBaseUrl: Boolean(env.apiBaseUrl),
      token: Boolean(env.token),
    },
  };
}

export async function saveEasyConsoleConfig(config: EasyConsoleConfigFile, configPath = getDefaultConfigPath()) {
  const payload: EasyConsoleConfigFile = {
    ...config,
    token: normalizeOptionalToken(config.token),
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}
