export type ApiEnvelope<T> = {
  code: number;
  msg?: string;
  message?: string;
  data: T;
};

export type ApiErrorKind = "http" | "business" | "network" | "parse";

export class ApiError extends Error {
  code?: number;
  status?: number;
  kind: ApiErrorKind;

  constructor(message: string, options: { code?: number; status?: number; kind: ApiErrorKind }) {
    super(message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.kind = options.kind;
  }
}

export type UnknownRecord = Record<string, unknown>;

export type UserInfo = UnknownRecord & {
  id?: string | number;
  username?: string;
  name?: string;
  role?: string;
};

export type TaskStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | number;

export type Task = UnknownRecord & {
  id: string | number;
  task_id?: string | number;
  name?: string;
  task_name?: string;
  description?: string;
  status?: TaskStatus;
  cpu?: number;
  gpu?: number;
  memory?: number;
  ip?: string;
  host?: string;
  hostname?: string;
  port?: string | number;
  ssh_host?: string;
  ssh_port?: string | number;
  ssh_username?: string;
  ssh_user?: string;
  ssh_password?: string;
  password?: string;
  login_user?: string;
  node_name?: string;
  user_group?: string;
  user_group_name?: string;
  group_name?: string;
  user?: UnknownRecord & {
    username?: string;
    name?: string;
    user_group?: string;
    group_name?: string;
  };
  image_id?: string | number;
  img?: string | number;
  image_name?: string;
  username?: string;
  create_time?: string;
  created_at?: string;
  start_time?: string | null;
  releace_time?: string | null;
  update_time?: string;
  releace_conditions?: number;
  release_condition?: number;
  use_time?: number;
  cost?: number;
  is_delete?: boolean;
  storage_path?: string;
  mount_path?: string;
  work_directory?: string;
  script_path?: string;
};

export type ConsoleSummary = UnknownRecord & {
  run_task_count?: number;
  pending_task_count?: number;
  run_time?: {
    month?: number;
    week?: number;
    day?: number;
  };
  cost_map?: {
    month?: number;
    week?: number;
    day?: number;
  };
};

export type ImageItem = UnknownRecord & {
  id: string | number;
  name?: string;
  image_name?: string;
  tag?: string;
  create_time?: string;
  created_at?: string;
  update_time?: string;
  is_default?: boolean;
  description?: string;
};

export type ImageCommitPayload = UnknownRecord & {
  user: UnknownRecord | string;
  pod_name: string;
};

export type StorageEntry = UnknownRecord & {
  name: string;
  path?: string;
  size?: number;
  type?: "file" | "dir" | string;
  is_dir?: boolean;
  modified?: string;
};

export type ResourceSpec = UnknownRecord & {
  id?: string | number;
  name?: string;
  label?: string;
  cpu?: number;
  memory?: number;
  gpu?: number;
};

export type ListResult<T> = {
  items: T[];
  total?: number;
  raw: unknown;
};

export type TaskQuery = {
  page?: number;
  page_size?: number;
  keyword?: string;
  name?: string;
  status?: string | number;
  username?: string;
  user_group?: string;
  releace_conditions?: string | number;
  is_delete?: string | boolean;
};

export type StorageQuery = {
  path?: string;
};

export type CreateTaskPayload = UnknownRecord & {
  name: string;
  price?: string | number;
  cpu?: string | number;
  gpu?: string | number;
  memory?: string | number;
  img?: string | number;
  storage_path?: string;
  mount_path?: string;
  releace_conditions?: number;
  releace_time?: string;
  work_directory?: string;
  script_path?: string;
};

export type ScheduledTaskStatus = "pending" | "running" | "done" | "failed" | "paused";

export type ScheduledTask = {
  id: string;
  name: string;
  description?: string;
  scheduleTime: string;
  status: ScheduledTaskStatus;
  payload: CreateTaskPayload;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastError?: string;
};

export type TaskTemplate = {
  id: string;
  name: string;
  description?: string;
  taskNamePrefix: string;
  batchCount: number;
  imageId: string;
  cpu: number;
  gpu: number;
  memory: number;
  storagePath: string;
  mountPath: string;
  releaseCondition: 1 | 2 | 3;
  releaseAfterHours?: number;
  workDirectory?: string;
  scriptPath?: string;
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type LoginPayload = {
  username: string;
  password: string;
};

export type LoginResult = UnknownRecord & {
  token?: string;
  access?: string;
  access_token?: string;
};

export type UploadChunkRange = {
  start: number;
  end: number;
  total: number;
};

export type UploadProgress = {
  loaded: number;
  total?: number;
  percent: number;
};

export type UploadQueueItemStatus = "queued" | "uploading" | "done" | "failed" | "skipped" | "cancelled";

export type UploadQueueItem = {
  id: string;
  file: File;
  remoteDirectory: string;
  relativePath: string;
  status: UploadQueueItemStatus;
  progress: number;
  error?: string;
  skipReason?: string;
};

export type RuntimeStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type RuntimeHttpRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  responseType?: "json" | "blob" | "text";
  timeoutMs?: number;
  onUploadProgress?: (progress: UploadProgress) => void;
};

export type RuntimeHttpResponse<T = unknown> = {
  status: number;
  headers: Headers;
  data: T;
};

export type RuntimeWebSocketMessage = {
  data: unknown;
};

export type RuntimeWebSocket = {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: RuntimeWebSocketMessage) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void | Promise<void>;
  close(): void | Promise<void>;
};

export type RuntimeSystemNotification = {
  title: string;
  body?: string;
  tag?: string;
  silent?: boolean;
};

export type RuntimeSystemNotificationPermission = "granted" | "denied" | "default" | "unsupported";

export type RuntimeSystemNotificationResult = "shown" | "permission-denied" | "unsupported";

export type RuntimeTransport = {
  isDesktop: boolean;
  storage: RuntimeStorage;
  request<T = unknown>(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>>;
  createWebSocket(url: string): Promise<RuntimeWebSocket>;
  copyText(text: string): Promise<void>;
  requestSystemNotificationPermission(): Promise<RuntimeSystemNotificationPermission>;
  notifySystem(notification: RuntimeSystemNotification): Promise<RuntimeSystemNotificationResult>;
  openExternal(url: string): void;
  openSshSession(request: SshConnectionRequest): Promise<string>;
  writeSshSession(sessionId: string, data: string): Promise<void>;
  resizeSshSession(sessionId: string, cols: number, rows: number): Promise<void>;
  closeSshSession(sessionId: string): Promise<void>;
  onSshSessionEvent(sessionId: string, handler: (event: SshSessionEvent) => void): Promise<() => void>;
  openSystemSshTerminal(request: SshConnectionRequest): Promise<void>;
  openVscodeSsh(request: SshConnectionRequest): Promise<void>;
};

export type SshConnectionRequest = {
  host: string;
  port?: string;
  username?: string;
  password?: string;
  command: string;
  taskId?: string;
  taskName?: string;
  cols?: number;
  rows?: number;
};

export type SshSessionEvent = {
  sessionId: string;
  kind: "status" | "output" | "error" | "closed";
  data?: string;
  message?: string;
};
