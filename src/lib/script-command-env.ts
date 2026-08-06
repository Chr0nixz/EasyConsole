/** One shell-style `KEY=VALUE` assignment prefixed to a task-end script command. */
export type ScriptEnvVar = {
  key: string;
  value: string;
};

/** Matches a leading `KEY=VALUE ` assignment (no spaces in key/value). */
const ENV_ASSIGNMENT_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)\s+/;

export function isValidEnvKey(key: string) {
  const trimmed = key.trim();
  if (!trimmed) return true;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
}

export function isValidEnvValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^[^\s]+$/.test(trimmed);
}

/** Normalize rows: trim, drop blanks, keep order. */
export function normalizeScriptEnvVars(env: ScriptEnvVar[]): ScriptEnvVar[] {
  return env
    .map((item) => ({ key: item.key.trim(), value: item.value.trim() }))
    .filter((item) => item.key || item.value);
}

/** Returns validation error keys, or null when valid. Incomplete rows and bad tokens are rejected. */
export function findScriptEnvVarErrors(env: ScriptEnvVar[]): { index: number; messageZh: string; messageEn: string } | null {
  for (let index = 0; index < env.length; index += 1) {
    const key = env[index]?.key.trim() ?? "";
    const value = env[index]?.value.trim() ?? "";
    if (!key && !value) continue;
    if (!key || !value) {
      return {
        index,
        messageZh: "环境变量需要同时填写名称和值",
        messageEn: "Environment variables need both a name and a value",
      };
    }
    if (!isValidEnvKey(key)) {
      return {
        index,
        messageZh: "环境变量名仅允许字母、数字和下划线，且不能以数字开头",
        messageEn: "Env names may only use letters, digits, and underscores, and cannot start with a digit",
      };
    }
    if (!isValidEnvValue(value)) {
      return {
        index,
        messageZh: "环境变量值不能包含空白字符",
        messageEn: "Env values cannot contain whitespace",
      };
    }
  }
  return null;
}

/** Splits leading `KEY=VALUE` assignments from a script command. */
export function parseScriptCommandEnv(command: string): { env: ScriptEnvVar[]; command: string } {
  let rest = command.trim();
  const env: ScriptEnvVar[] = [];
  while (true) {
    const match = rest.match(ENV_ASSIGNMENT_PREFIX);
    if (!match) break;
    env.push({ key: match[1] ?? "", value: match[2] ?? "" });
    rest = rest.slice(match[0].length).trimStart();
  }
  return { env, command: rest };
}

/**
 * Builds `KEY=VALUE KEY2=VALUE2 /path/script.sh`.
 * Existing leading assignments on `command` are stripped first.
 */
export function applyEnvToScriptCommand(command: string, env: ScriptEnvVar[]): string {
  const { command: bare } = parseScriptCommandEnv(command);
  const assignments = normalizeScriptEnvVars(env).filter((item) => item.key && item.value);
  if (assignments.length === 0) return bare;
  return `${assignments.map((item) => `${item.key}=${item.value}`).join(" ")} ${bare}`;
}

/** Preview helper: same as apply, but returns empty string when script path is blank. */
export function previewScriptCommand(scriptPath: string, env: ScriptEnvVar[]): string {
  const path = scriptPath.trim();
  if (!path) return "";
  return applyEnvToScriptCommand(path, env);
}

/** Migrate legacy single experimentId into env rows. */
export function envVarsFromLegacyExperimentId(experimentId?: string | null, parsedEnv: ScriptEnvVar[] = []): ScriptEnvVar[] {
  if (parsedEnv.length > 0) return parsedEnv;
  const id = experimentId?.trim();
  if (!id) return [];
  return [{ key: "EXPERIMENT_ID", value: id }];
}
