import type { RuntimeStorage, UnknownRecord } from "./types";

export const RUN_LOGS_STORAGE_KEY = "easy-console.runLogs";
export const DEFAULT_RUN_LOG_LIMIT = 1000;
export const DEFAULT_RUN_LOG_RETENTION_DAYS = 30;

export type RunLogLevel = "info" | "warning" | "error";
export type RunLogResult = "success" | "failure";
export type RunLogChannel = "web" | "tauri" | "cli" | "mcp";
export type RunLogSource =
  | "auth"
  | "task"
  | "scheduled-task"
  | "task-template"
  | "storage"
  | "image"
  | "settings"
  | "system";

export type RunLogEntry = {
  id: string;
  createdAt: string;
  level: RunLogLevel;
  channel: RunLogChannel;
  source: RunLogSource;
  action: string;
  result: RunLogResult;
  title: string;
  targetName?: string;
  targetId?: string | number;
  durationMs?: number;
  userName?: string;
  error?: string;
  metadata?: UnknownRecord;
};

export type RunLogInput = Omit<RunLogEntry, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export type RunLogFilter = {
  source?: RunLogSource | "";
  channel?: RunLogChannel | "";
  result?: RunLogResult | "";
  level?: RunLogLevel | "";
  keyword?: string;
  limit?: number;
};

type RunLogStoreOptions = {
  limit?: number;
  retentionDays?: number;
  now?: () => Date;
};

const SENSITIVE_KEY_PATTERN = /(authorization|bearer|cookie|password|secret|token|passwd|pwd)/i;
const MAX_METADATA_STRING_LENGTH = 1000;
const MAX_METADATA_JSON_LENGTH = 12_000;

function createRunLogId() {
  return globalThis.crypto?.randomUUID?.() ?? `run-log-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

export function sanitizeRunLogValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_METADATA_STRING_LENGTH ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeRunLogValue(item, depth + 1));
  if (!isRecord(value)) return String(value);

  const sanitized: UnknownRecord = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeRunLogValue(item, depth + 1);
  }
  return sanitized;
}

function sanitizeMetadata(metadata: unknown): UnknownRecord | undefined {
  if (!isRecord(metadata)) return undefined;
  const sanitized = sanitizeRunLogValue(metadata);
  if (!isRecord(sanitized)) return undefined;
  const json = JSON.stringify(sanitized);
  if (json.length <= MAX_METADATA_JSON_LENGTH) return sanitized;
  return {
    truncated: true,
    preview: json.slice(0, MAX_METADATA_JSON_LENGTH),
  };
}

export function normalizeRunLogEntry(raw: unknown): RunLogEntry | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  const createdAt = stringValue(raw.createdAt);
  const source = enumValue(raw.source, ["auth", "task", "scheduled-task", "task-template", "storage", "image", "settings", "system"] as const, "system");
  const action = stringValue(raw.action);
  const title = stringValue(raw.title);
  if (!id || !createdAt || !action || !title || Number.isNaN(Date.parse(createdAt))) return null;

  return {
    id,
    createdAt,
    level: enumValue(raw.level, ["info", "warning", "error"] as const, "info"),
    channel: enumValue(raw.channel, ["web", "tauri", "cli", "mcp"] as const, "web"),
    source,
    action,
    result: enumValue(raw.result, ["success", "failure"] as const, "success"),
    title,
    targetName: stringValue(raw.targetName),
    targetId: idValue(raw.targetId),
    durationMs: numberValue(raw.durationMs),
    userName: stringValue(raw.userName),
    error: stringValue(raw.error),
    metadata: sanitizeMetadata(raw.metadata),
  };
}

export function parseRunLogs(raw: string | null): RunLogEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRunLogEntry).filter((item): item is RunLogEntry => Boolean(item));
  } catch {
    return [];
  }
}

export function pruneRunLogs(items: RunLogEntry[], options: RunLogStoreOptions = {}) {
  const limit = options.limit ?? DEFAULT_RUN_LOG_LIMIT;
  const retentionDays = options.retentionDays ?? DEFAULT_RUN_LOG_RETENTION_DAYS;
  const now = options.now?.() ?? new Date();
  const minTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  return [...items]
    .filter((item) => {
      const createdTime = Date.parse(item.createdAt);
      return Number.isFinite(createdTime) && createdTime >= minTime;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit);
}

export function createRunLogEntry(input: RunLogInput, options: RunLogStoreOptions = {}): RunLogEntry {
  const createdAt = input.createdAt ?? (options.now?.() ?? new Date()).toISOString();
  return {
    ...input,
    id: input.id ?? createRunLogId(),
    createdAt,
    metadata: sanitizeMetadata(input.metadata),
  };
}

export async function loadRunLogs(storage: RuntimeStorage, options: RunLogStoreOptions = {}) {
  return pruneRunLogs(parseRunLogs(await storage.get(RUN_LOGS_STORAGE_KEY)), options);
}

export async function saveRunLogs(storage: RuntimeStorage, items: RunLogEntry[], options: RunLogStoreOptions = {}) {
  const pruned = pruneRunLogs(items, options);
  await storage.set(RUN_LOGS_STORAGE_KEY, JSON.stringify(pruned));
  return pruned;
}

export async function appendRunLog(storage: RuntimeStorage, input: RunLogInput, options: RunLogStoreOptions = {}) {
  const current = await loadRunLogs(storage, options);
  const next = pruneRunLogs([createRunLogEntry(input, options), ...current], options);
  await storage.set(RUN_LOGS_STORAGE_KEY, JSON.stringify(next));
  return next[0];
}

export async function clearRunLogs(storage: RuntimeStorage) {
  await storage.set(RUN_LOGS_STORAGE_KEY, JSON.stringify([]));
}

export function filterRunLogs(items: RunLogEntry[], filter: RunLogFilter = {}) {
  const keyword = filter.keyword?.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (filter.source && item.source !== filter.source) return false;
    if (filter.channel && item.channel !== filter.channel) return false;
    if (filter.result && item.result !== filter.result) return false;
    if (filter.level && item.level !== filter.level) return false;
    if (!keyword) return true;
    return [
      item.title,
      item.action,
      item.source,
      item.channel,
      item.result,
      item.targetName,
      item.targetId,
      item.userName,
      item.error,
    ]
      .filter((value) => value !== undefined && value !== null)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
  return typeof filter.limit === "number" && filter.limit > 0 ? filtered.slice(0, filter.limit) : filtered;
}

export function formatRunLogExport(items: RunLogEntry[]) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2);
}
