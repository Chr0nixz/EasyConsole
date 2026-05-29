import { type ApiClient, extractToken, normalizeToken } from "./api-client";
import { sha256Hex } from "./crypto";
import { i18nText } from "./i18n-text";
import { md5Blob } from "./md5";
import type {
  CreateTaskPayload,
  ImageCommitPayload,
  ImageItem,
  ListResult,
  LoginPayload,
  LoginResult,
  ResourceSpec,
  StorageEntry,
  StorageQuery,
  Task,
  TaskQuery,
  UnknownRecord,
  UploadChunkRange,
  UploadProgress,
  UserInfo,
} from "./types";

const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

type DownloadRequestOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
};

export function formatContentRange(range: UploadChunkRange) {
  return `bytes ${range.start}-${range.end}/${range.total}`;
}

function extractUploadId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as UnknownRecord;
  const value = record.upload_id ?? record.uploadId ?? record.id;
  if (value !== undefined && value !== null && value !== "") return String(value);

  for (const nested of [record.data, record.result, record.file]) {
    const nestedUploadId = extractUploadId(nested);
    if (nestedUploadId) return nestedUploadId;
  }
  return null;
}

function assertUploadResponse(raw: unknown) {
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      return assertUploadResponse(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  if (!raw || typeof raw !== "object" || !("code" in raw)) return raw;
  const record = raw as UnknownRecord;
  if (record.code !== 0) {
    throw new Error(String(record.msg ?? record.message ?? i18nText("上传失败", "Upload failed")));
  }
  return record.data ?? record;
}

function isZeroSizeEntry(entry: StorageEntry, filename: string) {
  const size = Number(entry.size ?? entry.file_size ?? entry.filesize ?? entry.fileSize ?? entry.bytes ?? 0);
  return entry.name === filename && Number.isFinite(size) && size === 0;
}

function getMkdirPayload(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  const parent = parts.length ? `/${parts.join("/")}` : "/";
  return { path: parent, name };
}

function extractList<T>(raw: unknown): ListResult<T> {
  if (Array.isArray(raw)) return { items: raw as T[], raw };
  if (!raw || typeof raw !== "object") return { items: [], raw };
  const record = raw as UnknownRecord;
  const candidates = [record.list, record.results, record.items, record.data, record.rows];
  const items = candidates.find(Array.isArray) as T[] | undefined;
  const total = Number(record.total ?? record.count ?? record.total_count);
  return {
    items: items ?? [],
    total: Number.isFinite(total) ? total : undefined,
    raw,
  };
}

export function createEasyConsoleApi(apiClient: ApiClient) {
  const authApi = {
    bootstrapToken() {
      return apiClient.get<unknown>("/token", { auth: false });
    },
    async login(payload: LoginPayload) {
      const data = await apiClient.post<LoginResult>(
        "/user/token",
        {
          username: payload.username.trim(),
          password: await sha256Hex(payload.password),
        },
        { auth: false },
      );
      const token = extractToken(data);
      return { data, token: token ? normalizeToken(token) : null };
    },
    userInfo() {
      return apiClient.get<UserInfo>("/user/userinfo");
    },
    changePassword(payload: UnknownRecord) {
      return apiClient.post<unknown>("/user/user/change_password", payload);
    },
  };

  const instanceApi = {
    console() {
      return apiClient.get<unknown>("/instance/console");
    },
    statics(query?: UnknownRecord) {
      return apiClient.get<unknown>("/instance/statics", { query });
    },
    staticsCost(query?: UnknownRecord) {
      return apiClient.get<unknown>("/instance/statics_cost", { query });
    },
    staticsCostMonth() {
      return apiClient.get<unknown>("/instance/statics_cost/month");
    },
    async tasks(query: TaskQuery) {
      const raw = await apiClient.get<unknown>("/instance/task", { query });
      return extractList<Task>(raw);
    },
    createTask(payload: CreateTaskPayload) {
      return apiClient.post<unknown>("/instance/task", payload);
    },
    checkTaskName(name: string) {
      return apiClient.get<unknown>(`/instance/checkTaskName?name=${encodeURIComponent(name)}`);
    },
    operateTask(id: string | number) {
      return apiClient.put<unknown>(`/instance/task/${id}`);
    },
    deleteTask(id: string | number) {
      return apiClient.delete<unknown>(`/instance/task/${id}`);
    },
    deleteTasks(ids: Array<string | number>) {
      return apiClient.delete<unknown>("/instance/task", { body: ids });
    },
    taskLog(task: Pick<Task, "id" | "task_id">) {
      return apiClient.get<string>("/instance/task_log", {
        query: { task_id: task.task_id ?? task.id },
        responseType: "text",
      });
    },
    monitorIndex(query?: UnknownRecord) {
      return apiClient.get<unknown>("/instance/monitor_index", { query });
    },
    downloadTask(query: UnknownRecord, options?: DownloadRequestOptions) {
      return apiClient.get<Blob>("/instance/task/download", {
        query,
        responseType: "blob",
        signal: options?.signal,
        onDownloadProgress: options?.onProgress,
      });
    },
  };

  const imageApi = {
    async list(query?: UnknownRecord) {
      const raw = await apiClient.get<unknown>("/image/image", { query });
      return extractList<ImageItem>(raw);
    },
    async system(query?: UnknownRecord) {
      const raw = await apiClient.get<unknown>("/image/image_system", { query });
      return extractList<ImageItem>(raw);
    },
    detail(id: string | number) {
      return apiClient.get<ImageItem>(`/image/image/${id}`);
    },
    download(id: string | number, options?: DownloadRequestOptions) {
      return apiClient.get<Blob>(`/image/image/download/${id}`, {
        responseType: "blob",
        signal: options?.signal,
        onDownloadProgress: options?.onProgress,
      });
    },
    commitImage(payload: ImageCommitPayload) {
      return apiClient.post<unknown>("/image/image_commit", payload);
    },
    setDefault(id: string | number) {
      return apiClient.post<unknown>(`/image/default/${id}`);
    },
  };

  const storageApi = {
    async list(query: StorageQuery) {
      const raw = await apiClient.get<unknown>("/storage/ls", { query });
      return extractList<StorageEntry>(raw);
    },
    mkdir(path: string) {
      return apiClient.post<unknown>("/storage/ls", getMkdirPayload(path));
    },
    delete(path: string, isDirectory?: boolean) {
      return apiClient.delete<unknown>("/storage/ls", {
        body: { path, ...(isDirectory === undefined ? {} : { is_directory: isDirectory }) },
      });
    },
    info() {
      return apiClient.get<unknown>("/storage/info");
    },
    transmit(query: UnknownRecord, asBlob = true, options?: DownloadRequestOptions) {
      return apiClient.get<Blob | unknown>("/storage/file_transmit", {
        query,
        responseType: asBlob ? "blob" : "json",
        raw: asBlob,
        signal: options?.signal,
        onDownloadProgress: options?.onProgress,
      });
    },
    async uploadChunk(
      file: File,
      range: UploadChunkRange,
      path: string,
      uploadId?: string,
      onProgress?: (progress: UploadProgress) => void,
      signal?: AbortSignal,
    ) {
      const chunk = file.slice(range.start, range.end + 1);
      const formData = new FormData();
      formData.append("the_file", chunk, file.name);
      formData.append("path", path);
      if (uploadId) {
        formData.append("upload_id", uploadId);
        formData.append("offset", String(range.start));
      }
      const result = await apiClient.post<unknown>("/storage/chunked_upload", formData, {
        headers: {
          "Content-Range": formatContentRange(range),
        },
        timeoutMs: 300_000,
        signal,
        raw: true,
      });
      onProgress?.({
        loaded: range.end + 1,
        total: range.total,
        percent: Math.round(((range.end + 1) / range.total) * 100),
      });
      return assertUploadResponse(result);
    },
    async uploadEmptyFile(file: File, path: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal) {
      const formData = new FormData();
      formData.append("the_file", file.slice(0, 0), file.name);
      formData.append("path", path);
      const result = assertUploadResponse(
        await apiClient.post<unknown>("/storage/chunked_upload", formData, {
          timeoutMs: 300_000,
          signal,
          raw: true,
        }),
      );
      const uploadId = extractUploadId(result);
      if (uploadId) {
        const params = new URLSearchParams();
        params.set("upload_id", uploadId);
        params.set("md5", await md5Blob(file));
        params.set("path", path);
        const completed = await storageApi.uploadComplete(params.toString(), signal);
        onProgress?.({ loaded: 0, total: 0, percent: 100 });
        return completed;
      }

      const list = await storageApi.list({ path });
      if (list.items.some((entry) => isZeroSizeEntry(entry, file.name))) {
        onProgress?.({ loaded: 0, total: 0, percent: 100 });
        return result;
      }
      throw new Error(i18nText("0B 空文件上传后服务端未创建文件", "The server did not create a file after uploading a 0B empty file"));
    },
    async uploadFile(file: File, path: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal) {
      if (file.size === 0) return storageApi.uploadEmptyFile(file, path, onProgress, signal);

      let uploadId: string | null = null;
      for (let start = 0; start < file.size; start += UPLOAD_CHUNK_SIZE) {
        signal?.throwIfAborted();
        const end = Math.min(start + UPLOAD_CHUNK_SIZE, file.size) - 1;
        const result = await storageApi.uploadChunk(file, { start, end, total: file.size }, path, uploadId ?? undefined, onProgress, signal);
        uploadId ??= extractUploadId(result);
      }
      if (!uploadId) throw new Error(i18nText("上传服务未返回 upload_id", "Upload service did not return upload_id"));
      const params = new URLSearchParams();
      params.set("upload_id", uploadId);
      params.set("md5", await md5Blob(file));
      params.set("path", path);
      return storageApi.uploadComplete(params.toString(), signal);
    },
    async uploadComplete(payload: URLSearchParams | string, signal?: AbortSignal) {
      const result = await apiClient.post<unknown>("/storage/chunked_upload_complete", payload, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        responseType: "text",
        signal,
        raw: true,
      });
      return assertUploadResponse(result);
    },
  };

  const resourceApi = {
    resources() {
      return apiClient.get<ResourceSpec[]>("/back_admin/resource");
    },
    prices() {
      return apiClient.get<unknown>("/back_admin/price");
    },
  };

  return { authApi, imageApi, instanceApi, resourceApi, storageApi };
}

export type EasyConsoleApi = ReturnType<typeof createEasyConsoleApi>;
