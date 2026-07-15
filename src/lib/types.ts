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
  node?: UnknownRecord & {
    id?: string | number;
    name?: string;
    node_type?: string;
    ip?: string;
    status?: boolean;
  };
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

export type MonitorMetricSeries = UnknownRecord & {
  name?: string;
  data?: Array<{ timestamp?: number; value?: number }>;
};

export type MonitorIndexResponse = UnknownRecord & {
  index?: number;
  cpu?: MonitorMetricSeries[];
  memory?: MonitorMetricSeries[];
  network?: MonitorMetricSeries[];
  disk?: MonitorMetricSeries[];
  metrics?: UnknownRecord;
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

export type TaskRecurrenceType = "once" | "daily" | "weekly" | "interval" | "cron";

export type TaskRecurrence = {
  type: TaskRecurrenceType;
  /** Days of week for weekly recurrence (0=Sun … 6=Sat). */
  weekdays?: number[];
  /** Seconds between runs for interval recurrence. */
  intervalSec?: number;
  /** Standard 5-field cron expression for cron recurrence. */
  cron?: string;
  /** Stop repeating after this ISO timestamp. */
  endDate?: string;
};

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
  recurrence?: TaskRecurrence;
};

export type TaskTemplateVariable = {
  /** Placeholder key used in `${key}` tokens inside template string fields. */
  key: string;
  /** Optional human-readable label shown in the variable collection UI. */
  label?: string;
  /** Optional default value used when the user leaves the field empty. */
  defaultValue?: string;
  /** Whether the user must provide a non-empty value at execution time. */
  required?: boolean;
  /** Optional helper text shown below the input. */
  description?: string;
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
  /** Optional `${key}` variable definitions that the user fills in at execution time. */
  variables?: TaskTemplateVariable[];
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
  /** Upload ID from a previous partial upload, used for resumable uploads. */
  resumeFromUploadId?: string;
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
  signal?: AbortSignal;
  onUploadProgress?: (progress: UploadProgress) => void;
  onDownloadProgress?: (progress: UploadProgress) => void;
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

export type RuntimeKind = "web" | "desktop" | "mobile";

export type RuntimeLogChannel = "web" | "tauri" | "mobile";

export type RuntimeTransport = {
  isDesktop: boolean;
  isMobile: boolean;
  runtimeKind: RuntimeKind;
  runLogChannel: RuntimeLogChannel;
  supportsTray: boolean;
  supportsSystemTerminal: boolean;
  supportsInAppSsh: boolean;
  supportsUpdater: boolean;
  supportsFileReveal: boolean;
  storage: RuntimeStorage;
  secureStorage: RuntimeStorage;
  request<T = unknown>(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>>;
  createWebSocket(url: string): Promise<RuntimeWebSocket>;
  copyText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  requestSystemNotificationPermission(): Promise<RuntimeSystemNotificationPermission>;
  notifySystem(notification: RuntimeSystemNotification): Promise<RuntimeSystemNotificationResult>;
  openExternal(url: string): void;
  openLocalPath(path: string): Promise<void>;
  revealLocalPath(path: string): Promise<void>;
  openSshSession(request: SshConnectionRequest): Promise<string>;
  writeSshSession(sessionId: string, data: string): Promise<void>;
  resizeSshSession(sessionId: string, cols: number, rows: number): Promise<void>;
  closeSshSession(sessionId: string): Promise<void>;
  onSshSessionEvent(sessionId: string, handler: (event: SshSessionEvent) => void): Promise<() => void>;
  listKnownHosts(): Promise<KnownHostEntry[]>;
  removeKnownHost(hostPort: string): Promise<void>;
  clearKnownHosts(): Promise<void>;
  openSystemSshTerminal(request: SshConnectionRequest): Promise<void>;
  openVscodeSsh(request: SshConnectionRequest): Promise<void>;
  sftpList(sessionId: string, path: string): Promise<SftpEntry[]>;
  sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<void>;
  sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<void>;
  sftpDelete(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, oldPath: string, newPath: string): Promise<void>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  onSftpProgress(sessionId: string, handler: (progress: SftpProgress) => void): Promise<() => void>;
  startPortForward(sessionId: string, rule: PortForwardRule): Promise<void>;
  stopPortForward(sessionId: string, ruleId: string): Promise<void>;
  onPortForwardStatus(sessionId: string, handler: (status: PortForwardStatus) => void): Promise<() => void>;
  listSshHistory(): Promise<SshHistoryEntry[]>;
  addSshHistory(entry: Omit<SshHistoryEntry, "id" | "connectedAt">): Promise<void>;
  clearSshHistory(): Promise<void>;
  setDesktopCloseToTray(enabled: boolean): Promise<void>;
  setDesktopClosePrompt(enabled: boolean): Promise<void>;
  cancelDesktopClosePrompt(): Promise<void>;
  completeDesktopClosePrompt(action: "tray" | "exit"): Promise<void>;
  showDesktopMainWindow(): Promise<void>;
  hideDesktopTrayMenu(): Promise<void>;
  runDueScheduledTasks(): Promise<void>;
  quitDesktopApp(): Promise<void>;
  onDesktopCloseRequested(handler: () => void): Promise<() => void>;
  onDesktopRunDueScheduledTasks(handler: () => void): Promise<() => void>;
  onDeepLink(handler: (urls: string[]) => void): Promise<() => void>;
};

export type DownloadQueueItemStatus = "queued" | "downloading" | "done" | "failed" | "cancelled";

export type DownloadQueueSource = "task" | "storage" | "image";

export type DownloadQueueItem = {
  id: string;
  source: DownloadQueueSource;
  sourceLabel: string;
  filename: string;
  targetName: string;
  targetId?: string | number;
  status: DownloadQueueItemStatus;
  progress: number;
  loaded: number;
  total?: number;
  destinationPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommitQueueItemStatus = "queued" | "running" | "done" | "failed";

export type CommitQueueItem = {
  id: string;
  taskName: string;
  taskId?: string | number;
  podName: string;
  status: CommitQueueItemStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type SshAuthMode = "password" | "key";

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
  connectTimeoutSec?: number;
  keepaliveIntervalSec?: number;
  termType?: string;
  sshKeyPath?: string;
  authMode?: SshAuthMode;
};

export type SshSessionEvent = {
  sessionId: string;
  kind: "status" | "output" | "error" | "closed" | "sftp-progress" | "port-forward-status";
  data?: string;
  message?: string;
};

export type KnownHostEntry = {
  hostPort: string;
  fingerprint: string;
};

export type SshCustomColors = {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type PortForwardType = "local" | "remote" | "dynamic";

export type PortForwardRule = {
  id: string;
  type: PortForwardType;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  enabled: boolean;
};

export type PortForwardStatus = {
  ruleId: string;
  active: boolean;
  error?: string;
};

export type SftpEntry = {
  name: string;
  longName: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  permissions: string;
};

export type SftpProgress = {
  transferred: number;
  total: number;
};

export type SshHistoryEntry = {
  id: string;
  host: string;
  port: string;
  username: string;
  taskName: string;
  connectedAt: number;
};
