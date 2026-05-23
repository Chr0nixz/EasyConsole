import { ApiClient, extractToken, normalizeToken } from "./api-client";
import { sha256Hex } from "./crypto";
import { browserRuntime } from "./runtime";
import type {
  CreateTaskPayload,
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

export const apiClient = new ApiClient(browserRuntime);
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

export function formatContentRange(range: UploadChunkRange) {
  return `bytes ${range.start}-${range.end}/${range.total}`;
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

export const authApi = {
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

export const instanceApi = {
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
  taskLog(taskId: string | number) {
    return apiClient.get<unknown>(`/instance/task_log?task_id=${encodeURIComponent(String(taskId))}`);
  },
  monitorIndex(query?: UnknownRecord) {
    return apiClient.get<unknown>("/instance/monitor_index", { query });
  },
  downloadTask(query: UnknownRecord) {
    return apiClient.get<Blob>("/instance/task/download", { query, responseType: "blob" });
  },
};

export const imageApi = {
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
  download(id: string | number) {
    return apiClient.get<Blob>(`/image/image/download/${id}`, { responseType: "blob" });
  },
  setDefault(id: string | number) {
    return apiClient.post<unknown>(`/image/default/${id}`);
  },
};

export const storageApi = {
  async list(query: StorageQuery) {
    const raw = await apiClient.get<unknown>("/storage/ls", { query });
    return extractList<StorageEntry>(raw);
  },
  mkdir(path: string) {
    return apiClient.post<unknown>("/storage/ls", { path });
  },
  delete(path: string) {
    return apiClient.delete<unknown>("/storage/ls", { body: { path } });
  },
  info() {
    return apiClient.get<unknown>("/storage/info");
  },
  transmit(query: UnknownRecord, asBlob = true) {
    return apiClient.get<Blob | unknown>("/storage/file_transmit", {
      query,
      responseType: asBlob ? "blob" : "json",
      raw: asBlob,
    });
  },
  async uploadChunk(file: File, range: UploadChunkRange, onProgress?: (progress: UploadProgress) => void) {
    const chunk = file.slice(range.start, range.end + 1);
    const formData = new FormData();
    formData.append("file", chunk, file.name);
    formData.append("filename", file.name);
    const result = await apiClient.post<unknown>("/storage/chunked_upload", formData, {
      headers: {
        "Content-Range": formatContentRange(range),
      },
      timeoutMs: 0,
    });
    onProgress?.({ loaded: range.end + 1, total: range.total, percent: Math.round(((range.end + 1) / range.total) * 100) });
    return result;
  },
  async uploadFile(file: File, path: string, onProgress?: (progress: UploadProgress) => void) {
    for (let start = 0; start < file.size; start += UPLOAD_CHUNK_SIZE) {
      const end = Math.min(start + UPLOAD_CHUNK_SIZE, file.size) - 1;
      await storageApi.uploadChunk(file, { start, end, total: file.size }, onProgress);
    }
    const params = new URLSearchParams();
    params.set("filename", file.name);
    params.set("path", path);
    return storageApi.uploadComplete(params);
  },
  uploadComplete(payload: URLSearchParams) {
    return apiClient.post<unknown>("/storage/chunked_upload_complete", payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },
};

export const resourceApi = {
  resources() {
    return apiClient.get<ResourceSpec[]>("/back_admin/resource");
  },
  prices() {
    return apiClient.get<unknown>("/back_admin/price");
  },
};
