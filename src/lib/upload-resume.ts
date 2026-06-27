import type { RuntimeStorage } from "./types";

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

export function makeFileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

async function loadAllRecords(storage: RuntimeStorage): Promise<Map<string, UploadResumeRecord>> {
  const raw = await storage.get(UPLOAD_RESUME_STORAGE_KEY);
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

async function saveAllRecords(storage: RuntimeStorage, records: Map<string, UploadResumeRecord>) {
  const obj: Record<string, UploadResumeRecord> = {};
  for (const [key, value] of records) obj[key] = value;
  await storage.set(UPLOAD_RESUME_STORAGE_KEY, JSON.stringify(obj));
}

export async function loadUploadResume(storage: RuntimeStorage, fileKey: string): Promise<UploadResumeRecord | null> {
  const records = await loadAllRecords(storage);
  return records.get(fileKey) ?? null;
}

export async function saveUploadResume(storage: RuntimeStorage, record: UploadResumeRecord): Promise<void> {
  const records = await loadAllRecords(storage);
  records.set(record.fileKey, record);
  await saveAllRecords(storage, records);
}

export async function clearUploadResume(storage: RuntimeStorage, fileKey: string): Promise<void> {
  const records = await loadAllRecords(storage);
  if (records.delete(fileKey)) {
    await saveAllRecords(storage, records);
  }
}
