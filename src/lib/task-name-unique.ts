/**
 * Allocate unique instance names by appending `_1`, `_2`, … when a name is taken.
 * Example: base `XXX` → `XXX_1` when `XXX` already exists.
 */

const MAX_NAME_ATTEMPTS = 10_000;

export function formatNumberedTaskName(baseName: string, number: number) {
  const base = baseName.trim();
  if (!base) return "";
  if (number <= 0) return base;
  return `${base}_${number}`;
}

export function collectExistingTaskNames(
  tasks: Array<{ name?: string | null; task_name?: string | null }>,
): Set<string> {
  const names = new Set<string>();
  for (const task of tasks) {
    for (const value of [task.name, task.task_name]) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) names.add(trimmed);
      }
    }
  }
  return names;
}

/**
 * Interpret `/instance/checkTaskName` payload after envelope unwrap.
 * Returns true when the name can be used.
 *
 * Bare booleans / `data: boolean` are treated as **exists** flags (true = taken),
 * matching common Chinese console APIs named checkTaskName / checkExist.
 * Explicit `available` / `exists` fields still win when present.
 */
export function isTaskNameAvailableResponse(raw: unknown): boolean {
  if (typeof raw === "boolean") return !raw;
  if (typeof raw === "number") {
    // 1 = exists / taken, 0 = free (common convention for check*Exist endpoints).
    if (raw === 0 || raw === 1) return raw === 0;
    return true;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "taken", "exists", "exist", "yes", "unavailable"].includes(normalized)) return false;
    if (["false", "0", "ok", "available", "no"].includes(normalized)) return true;
    return true;
  }
  if (!raw || typeof raw !== "object") return true;

  const record = raw as Record<string, unknown>;
  if (typeof record.available === "boolean") return record.available;
  if (typeof record.isAvailable === "boolean") return record.isAvailable;
  if (typeof record.is_available === "boolean") return record.is_available;
  if (typeof record.exists === "boolean") return !record.exists;
  if (typeof record.exist === "boolean") return !record.exist;
  if (typeof record.isExist === "boolean") return !record.isExist;
  if (typeof record.is_exist === "boolean") return !record.is_exist;
  if (typeof record.taken === "boolean") return !record.taken;
  if (typeof record.data === "boolean") return !record.data;
  if (record.data && typeof record.data === "object") {
    return isTaskNameAvailableResponse(record.data);
  }
  return true;
}

export async function nextUniqueTaskName(
  baseName: string,
  isAvailable: (name: string) => boolean | Promise<boolean>,
  reserved: Set<string> = new Set(),
): Promise<string> {
  const base = baseName.trim();
  if (!base) return base;

  for (let number = 0; number <= MAX_NAME_ATTEMPTS; number += 1) {
    const candidate = formatNumberedTaskName(base, number);
    if (reserved.has(candidate)) continue;
    if (await isAvailable(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }

  throw new Error(`Unable to allocate a unique task name for "${base}"`);
}

export async function allocateUniqueTaskNames(
  baseNames: string[],
  isAvailable: (name: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  const reserved = new Set<string>();
  const result: string[] = [];
  for (const baseName of baseNames) {
    result.push(await nextUniqueTaskName(baseName, isAvailable, reserved));
  }
  return result;
}

export function createTakenNamesAvailabilityChecker(existingNames: Iterable<string>) {
  const taken = new Set(
    [...existingNames]
      .map((name) => name.trim())
      .filter(Boolean),
  );

  return (name: string) => !taken.has(name.trim());
}

export function createTaskNameAvailabilityChecker(checkTaskName: (name: string) => Promise<unknown>) {
  const cache = new Map<string, boolean>();

  return async (name: string) => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const available = isTaskNameAvailableResponse(await checkTaskName(name));
    cache.set(name, available);
    return available;
  };
}

/**
 * Prefer local/remote task-list names; optionally consult checkTaskName as a secondary signal.
 * A name is unavailable if either source says it is taken.
 */
export function createCombinedTaskNameAvailabilityChecker(options: {
  existingNames?: Iterable<string>;
  checkTaskName?: (name: string) => Promise<unknown>;
}) {
  const fromList = createTakenNamesAvailabilityChecker(options.existingNames ?? []);
  const fromApi = options.checkTaskName ? createTaskNameAvailabilityChecker(options.checkTaskName) : null;

  return async (name: string) => {
    if (!fromList(name)) return false;
    if (!fromApi) return true;
    try {
      return await fromApi(name);
    } catch {
      // List already said free; ignore flaky checkTaskName.
      return true;
    }
  };
}

/** When enabled, rewrite payload names so they do not collide with existing instances (or each other). */
export async function maybeAllocateUniqueCreateTaskNames<T extends { name?: string }>(
  payloads: T[],
  options: {
    enabled: boolean;
    existingNames?: Iterable<string>;
    checkTaskName?: (name: string) => Promise<unknown>;
    listExistingNames?: () => Promise<Iterable<string>>;
  },
): Promise<T[]> {
  if (!options.enabled || payloads.length === 0) return payloads;
  const listed = options.listExistingNames ? await options.listExistingNames() : [];
  const existing = [...(options.existingNames ?? []), ...listed];
  const bases = payloads.map((payload) => String(payload.name ?? "").trim());
  const names = await allocateUniqueTaskNames(
    bases,
    createCombinedTaskNameAvailabilityChecker({
      existingNames: existing,
      checkTaskName: options.checkTaskName,
    }),
  );
  return payloads.map((payload, index) => ({ ...payload, name: names[index] ?? payload.name }));
}
