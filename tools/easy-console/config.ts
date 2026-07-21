import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_API_BASE_URL, normalizeToken } from "../../src/lib/api-client";
import {
  assertTransportUrlAllowed,
  describeTransportViolation,
  isTransportUrlAllowed,
} from "../../src/lib/transport-security";

export type EasyConsoleConfigFile = {
  apiBaseUrl?: string;
  token?: string | null;
};

export type EasyConsoleConfig = {
  apiBaseUrl: string;
  token: string | null;
  configPath: string;
  allowInsecureHttp: boolean;
  env: {
    apiBaseUrl: boolean;
    token: boolean;
    allowInsecureHttp: boolean;
  };
};

export type EasyConsoleConfigOverrides = {
  apiBaseUrl?: string;
  token?: string | null;
  configPath?: string;
  /** Explicit opt-in for remote cleartext HTTP (lab / legacy). */
  allowInsecureHttp?: boolean;
};

export function getDefaultConfigPath() {
  return join(homedir(), ".easy-console", "config.json");
}

function readEnvironment() {
  return {
    apiBaseUrl: process.env.EASY_CONSOLE_API_BASE_URL,
    token: process.env.EASY_CONSOLE_TOKEN,
    configPath: process.env.EASY_CONSOLE_CONFIG,
    allowInsecureHttp: process.env.EASY_CONSOLE_ALLOW_INSECURE_HTTP,
  };
}

function parseAllowInsecureHttpFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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

export function assertCliApiBaseUrlAllowed(apiBaseUrl: string, allowInsecureHttp: boolean) {
  const enforceSecureRemote = !allowInsecureHttp;
  if (isTransportUrlAllowed(apiBaseUrl, { enforceSecureRemote })) return;
  const detail = describeTransportViolation(apiBaseUrl);
  throw new Error(
    `${detail} Pass --allow-insecure-http or set EASY_CONSOLE_ALLOW_INSECURE_HTTP=1 to opt in for lab use.`,
  );
}

export async function loadEasyConsoleConfig(overrides: EasyConsoleConfigOverrides = {}): Promise<EasyConsoleConfig> {
  const env = readEnvironment();
  const configPath = overrides.configPath ?? env.configPath ?? getDefaultConfigPath();
  const file = await readConfigFile(configPath);
  const apiBaseUrl = overrides.apiBaseUrl ?? env.apiBaseUrl ?? file.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const token = normalizeOptionalToken(overrides.token ?? env.token ?? file.token ?? null);
  const allowInsecureHttp =
    overrides.allowInsecureHttp === true || parseAllowInsecureHttpFlag(env.allowInsecureHttp);

  assertCliApiBaseUrlAllowed(apiBaseUrl, allowInsecureHttp);
  // Keep assertTransportUrlAllowed for invalid schemes even when insecure is allowed.
  assertTransportUrlAllowed(apiBaseUrl, { enforceSecureRemote: !allowInsecureHttp });

  return {
    apiBaseUrl,
    token,
    configPath,
    allowInsecureHttp,
    env: {
      apiBaseUrl: Boolean(env.apiBaseUrl),
      token: Boolean(env.token),
      allowInsecureHttp: parseAllowInsecureHttpFlag(env.allowInsecureHttp),
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
  // Restrict to owner-only read/write on POSIX systems. No-op on Windows.
  if (process.platform !== "win32") {
    await chmod(configPath, 0o600).catch(() => {});
  }
  return payload;
}
