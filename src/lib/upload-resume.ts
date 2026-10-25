import type { RuntimeStorage } from "./types";
import { updateStorageValue } from "./storage-mutex";

export const UPLOAD_RESUME_STORAGE_KEY = "easy-console.upload-resume";

export type UploadResumeRecord = {
  /** Stable key identifying the file: `${name}-${size}-${lastModified}`. */
  fileKey: string;
  uploadId: string;
  /** Indices of chunks that were successfully uploaded. */
  uploadedChunks: number[];
  md5?: string;
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeRecord(raw: unknown): UploadResumeRecord | null {
  if (!isRecord(raw)) return null;
  const fileKey = String(raw.fileKey ?? "");
  const uploadId = String(raw.uploadId ?? "");
  if (!fileKey || !uploadId) return null;
  return {
    fileKey,
    uploadId,
    uploadedChunks: Array.isArray(raw.uploadedChunks) ? raw.uploadedChunks.filter((n) => typeof n === "number") : [],
    md5: typeof raw.md5 === "string" ? raw.md5 : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

function parseRecordsFromRaw(raw: string | null): Map<string, UploadResumeRecord> {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return new Map();
    const result = new Map<string, UploadResumeRecord>();
    for (const [key, value] of Object.entries(parsed)) {
      const record = normalizeRecord(value);
      if (record) result.set(key, record);
    }
    return result;
  } catch {
    return new Map();
  }
}

function stringifyRecords(records: Map<string, UploadResumeRecord>) {
  const obj: Record<string, UploadResumeRecord> = {};
  for (const [key, value] of records) obj[key] = value;
  return JSON.stringify(obj);
}

export function makeFileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export async function loadUploadResume(storage: RuntimeStorage, fileKey: string): Promise<UploadResumeRecord | null> {
  const raw = await storage.get(UPLOAD_RESUME_STORAGE_KEY);
  return parseRecordsFromRaw(raw).get(fileKey) ?? null;
}

export async function saveUploadResume(storage: RuntimeStorage, record: UploadResumeRecord): Promise<void> {
  await updateStorageValue(storage, UPLOAD_RESUME_STORAGE_KEY, (raw) => {
    const records = parseRecordsFromRaw(raw);
    records.set(record.fileKey, record);
    return stringifyRecords(records);
  });
}

export async function clearUploadResume(storage: RuntimeStorage, fileKey: string): Promise<void> {
  await updateStorageValue(storage, UPLOAD_RESUME_STORAGE_KEY, (raw) => {
    const records = parseRecordsFromRaw(raw);
    if (!records.delete(fileKey)) return raw;
    return stringifyRecords(records);
  });
}

/** Chunk-level progress state reported while a chunked upload runs. */
export type UploadResumeCheckpoint = {
  uploadId: string;
  completedIndices: number[];
};

export type ThrottledCheckpointSaver = {
  /** Persist the checkpoint when the throttle window has elapsed; the first one always lands. */
  save: (checkpoint: UploadResumeCheckpoint) => void;
  /** Persist the latest checkpoint unconditionally (finish / failure paths). */
  flush: () => Promise<void>;
};

/**
 * Throttle upload-resume checkpoint persistence. Every completed chunk used to
 * rewrite the whole resume store; on desktop each write rewrites the
 * runtime-storage file, so a multi-GB upload hammered it thousands of times.
 * The first checkpoint lands immediately (it captures the fresh uploadId);
 * later ones persist at most once per window, always with the newest state;
 * flush() forces the latest state out before the upload ends.
 */
export function createThrottledCheckpointSaver(
  storage: RuntimeStorage,
  options: { fileKey: string; minIntervalMs?: number; now?: () => number },
): ThrottledCheckpointSaver {
  const minIntervalMs = options.minIntervalMs ?? 2000;
  const now = options.now ?? Date.now;
  let latest: UploadResumeCheckpoint | null = null;
  let lastSavedAt = Number.NEGATIVE_INFINITY;

  const persist = async (checkpoint: UploadResumeCheckpoint) => {
    await saveUploadResume(storage, {
      fileKey: options.fileKey,
      uploadId: checkpoint.uploadId,
      uploadedChunks: checkpoint.completedIndices,
      createdAt: new Date().toISOString(),
    });
  };

  return {
    save(checkpoint) {
      latest = checkpoint;
      // Claim the window synchronously: checkpoint callbacks arrive in tight
      // bursts, and a gate armed only after the async write finishes would let
      // the whole burst through.
      if (now() - lastSavedAt < minIntervalMs) return;
      lastSavedAt = now();
      void persist(checkpoint).catch((error) => console.warn("Failed to save the upload checkpoint.", error));
    },
    async flush() {
      if (!latest) return;
      await persist(latest);
    },
  };
}
