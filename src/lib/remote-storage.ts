import { storageApi } from "./api";
import type { StorageEntry, StorageQuery, UploadProgress } from "./types";

export type RemoteStoragePickMode = "directory" | "file";

export type RemoteStorageService = {
  list(query: StorageQuery): Promise<{ items: StorageEntry[]; total?: number; raw: unknown }>;
  createDirectory(path: string): Promise<unknown>;
  remove(path: string, isDirectory?: boolean): Promise<unknown>;
  uploadLocalFile(file: File, remoteDirectory: string, onProgress?: (progress: UploadProgress) => void): Promise<unknown>;
  uploadLocalFiles(files: File[], remoteDirectory: string, onProgress?: (progress: UploadProgress) => void): Promise<unknown>;
  getDirectorySize(path: string): Promise<number>;
  downloadRemoteFile(path: string): Promise<Blob>;
  downloadRemotePath(path: string): Promise<Blob>;
  readTextFile(path: string): Promise<string>;
};

function booleanLike(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseStorageSize(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return null;
  const exactNumber = Number(normalized);
  if (Number.isFinite(exactNumber) && exactNumber >= 0) return exactNumber;

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z\u4e00-\u9fa5]+)$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return null;

  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    byte: 1,
    bytes: 1,
    字节: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const multiplier = multipliers[unit];
  return multiplier ? number * multiplier : null;
}

export function isStorageDirectory(entry: StorageEntry, currentPath?: string) {
  const type = String(entry.type ?? entry.file_type ?? entry.kind ?? "").toLowerCase();
  if (type === "file") return false;
  if (type === "dir" || type === "directory" || type === "folder") return true;
  if (
    booleanLike(entry.is_dir) ||
    booleanLike(entry.isdir) ||
    booleanLike(entry.isDir) ||
    booleanLike(entry.is_directory) ||
    booleanLike(entry.directory) ||
    booleanLike(entry.dir)
  ) {
    return true;
  }
  if (typeof entry.path === "string" && entry.path.endsWith("/")) return true;

  const normalizedCurrentPath = normalizeStoragePath(currentPath);
  const hasNoExtension = !entry.name.includes(".");
  return normalizedCurrentPath === "/" && hasNoExtension && (getStorageEntrySize(entry) ?? 0) === 0;
}

export function normalizeStoragePath(path?: string | null) {
  if (!path) return "/";
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!normalized || normalized === ".") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function joinStoragePath(path: string, name: string) {
  const base = normalizeStoragePath(path);
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/$/, "")}/${name}`;
}

export function getLocalFileRelativePath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

export function getStorageEntryPath(entry: StorageEntry, currentPath: string) {
  return normalizeStoragePath(entry.path ?? joinStoragePath(currentPath, entry.name));
}

export function getStorageEntrySize(entry: StorageEntry) {
  const candidates = [
    entry.size,
    entry.file_size,
    entry.filesize,
    entry.fileSize,
    entry.size_bytes,
    entry.sizeBytes,
    entry.size_byte,
    entry.byte_size,
    entry.bytes,
    entry.length,
    entry.total_size,
    entry.totalSize,
    entry.dir_size,
    entry.folder_size,
    entry.storage_size,
  ];
  for (const candidate of candidates) {
    const size = parseStorageSize(candidate);
    if (size !== null) return size;
  }
  return null;
}

function formatTimestamp(value: number) {
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

export function getStorageEntryModified(entry: StorageEntry) {
  const value =
    entry.modified ??
    entry.mtime ??
    entry.update_time ??
    entry.updated_at ??
    entry.last_modified ??
    entry.lastModified ??
    entry.create_time ??
    entry.created_at;
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return formatTimestamp(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return formatTimestamp(Number(value));
  return String(value);
}

export function getStorageEntryModifiedTime(entry: StorageEntry) {
  const value =
    entry.modified ??
    entry.mtime ??
    entry.update_time ??
    entry.updated_at ??
    entry.last_modified ??
    entry.lastModified ??
    entry.create_time ??
    entry.created_at;
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    return number > 10_000_000_000 ? number : number * 1000;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }
  return 0;
}

export function getStorageParentPath(path: string) {
  const normalized = normalizeStoragePath(path);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function getStorageBreadcrumbs(path: string) {
  const parts = normalizeStoragePath(path).split("/").filter(Boolean);
  return [
    { label: "根目录", path: "/" },
    ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` })),
  ];
}

async function calculateDirectorySize(path: string, seen = new Set<string>()): Promise<number> {
  const normalizedPath = normalizeStoragePath(path);
  if (seen.has(normalizedPath)) return 0;
  seen.add(normalizedPath);

  const result = await remoteStorage.list({ path: normalizedPath });
  let total = 0;
  for (const entry of result.items) {
    const entryPath = getStorageEntryPath(entry, normalizedPath);
    if (entry.name === "." || entry.name === ".." || entryPath === normalizedPath) continue;
    if (isStorageDirectory(entry, normalizedPath)) {
      total += await calculateDirectorySize(entryPath, seen);
    } else {
      total += getStorageEntrySize(entry) ?? 0;
    }
  }
  return total;
}

export const remoteStorage: RemoteStorageService = {
  list(query) {
    return storageApi.list({ path: normalizeStoragePath(query.path) });
  },
  createDirectory(path) {
    return storageApi.mkdir(normalizeStoragePath(path));
  },
  remove(path, isDirectory) {
    return storageApi.delete(normalizeStoragePath(path), isDirectory);
  },
  uploadLocalFile(file, remoteDirectory, onProgress) {
    return storageApi.uploadFile(file, normalizeStoragePath(remoteDirectory), onProgress);
  },
  async uploadLocalFiles(files, remoteDirectory, onProgress) {
    const normalizedRemoteDirectory = normalizeStoragePath(remoteDirectory);
    const directories = new Set<string>();
    for (const file of files) {
      const parts = getLocalFileRelativePath(file).split("/").filter(Boolean);
      parts.pop();
      let currentPath = normalizedRemoteDirectory;
      for (const part of parts) {
        currentPath = joinStoragePath(currentPath, part);
        directories.add(currentPath);
      }
    }

    for (const directory of [...directories].sort((left, right) => left.split("/").length - right.split("/").length)) {
      try {
        await remoteStorage.createDirectory(directory);
      } catch {
        // Existing directories can be reused during recursive uploads.
      }
    }

    const total = files.reduce((sum, file) => sum + file.size, 0);
    let uploadedBeforeCurrentFile = 0;
    for (const file of files) {
      const parts = getLocalFileRelativePath(file).split("/").filter(Boolean);
      parts.pop();
      const targetDirectory = parts.reduce((directory, part) => joinStoragePath(directory, part), normalizedRemoteDirectory);
      await remoteStorage.uploadLocalFile(file, targetDirectory, (progress) => {
        const loaded = uploadedBeforeCurrentFile + progress.loaded;
        onProgress?.({ loaded, total, percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 100 });
      });
      uploadedBeforeCurrentFile += file.size;
    }
    return undefined;
  },
  getDirectorySize(path) {
    return calculateDirectorySize(path);
  },
  async downloadRemoteFile(path) {
    const result = await storageApi.transmit({ path: normalizeStoragePath(path) });
    if (result instanceof Blob) return result;
    return new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  },
  downloadRemotePath(path) {
    return remoteStorage.downloadRemoteFile(path);
  },
  async readTextFile(path) {
    const blob = await remoteStorage.downloadRemoteFile(path);
    return blob.text();
  },
};
