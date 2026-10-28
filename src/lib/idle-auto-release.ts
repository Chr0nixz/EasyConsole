import { updateStorageValue } from "./storage-mutex";
import type { RuntimeStorage, Task } from "./types";

const CLAIMS_KEY = "easy-console.idleReleaseClaims";

/** Persist intent before sending: uncertain outcomes are never auto-retried. */
export async function releaseIdleInstance(options: {
  storage: RuntimeStorage;
  task: Task;
  accountScope: string;
  isCurrent(): boolean;
  release(): Promise<unknown>;
}): Promise<"released" | "skipped"> {
  if (!options.isCurrent()) return "skipped";
  const key = JSON.stringify([options.accountScope, String(options.task.id), options.task.create_time ?? options.task.created_at ?? ""]);
  const claim = `${Date.now()}-${Math.random()}`;
  const saved = await updateStorageValue(options.storage, CLAIMS_KEY, (raw) => {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid idle-release ledger");
    const claims = parsed as Record<string, string>;
    if (Object.hasOwn(claims, key)) return raw;
    return JSON.stringify({ ...claims, [key]: claim });
  });
  const claims = JSON.parse(saved ?? "{}") as Record<string, string>;
  if (claims[key] !== claim || !options.isCurrent()) return "skipped";
  await options.release();
  return "released";
}
