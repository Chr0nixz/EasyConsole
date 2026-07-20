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
