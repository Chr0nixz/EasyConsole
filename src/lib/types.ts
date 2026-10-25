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
  price?: string | number;
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
  /** Unit follows the endpoint: seconds from `/instance/task`, hours from `/instance/statics`. */
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
  /** Aggregate seconds — use `formatSecondsDuration`. */
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

/** Locally saved CPU/GPU/memory combination for one-click reuse in task forms. */
export type ResourcePreset = {
  id: string;
  name: string;
  cpu: number;
  gpu: number;
  memory: number;
  createdAt: string;
  updatedAt: string;
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

export type ScheduledTaskStatus = "pending" | "running" | "done" | "failed" | "paused" | "needs_review";

/**
 * Identity of the account that created (or last adopted) a scheduled task.
 * `key` is the account scope key (see account-scope.ts); never contains secrets.
 */
export type ScheduledTaskOwner = {
  key: string;
  displayName: string;
};

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
  /** Stable key for the in-flight or last attempted trigger: `${id}@${scheduleTime}`. */
  executionKey?: string;
  /** When the current running lease started (ISO). */
  leaseStartedAt?: string;
  /** Remote task id created for the current/last successful execution key. */
  lastRemoteTaskId?: string;
  /** Account that created (or last adopted) this schedule; legacy records carry a legacy marker. */
  owner?: ScheduledTaskOwner;
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
  price?: string | number;
  cpu: number;
  gpu: number;
  memory: number;
  storagePath: string;
  mountPath: string;
  releaseCondition: 1 | 2 | 3;
  releaseAfterHours?: number;
  workDirectory?: string;
  scriptPath?: string;
  /** Optional shell env assignments prepended to the script command when releaseCondition is 3. */
  scriptEnv?: Array<{ key: string; value: string }>;
  /** @deprecated Prefer scriptEnv. Migrated on load. */
  experimentId?: string;
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
  /**
   * Run `fn` with exclusive access to the whole store.
   *
   * Optional: backends that are already safe for a single process (browser and
   * Tauri storage, which are serialized by `withStorageLock`) may omit it.
   * Backends shared across OS processes -- the Node file store used by the CLI
   * and MCP sidecars -- must implement it, otherwise a load→modify→save
   * sequence spans two independent locks and concurrent processes overwrite
   * each other. `updateStorageValue` uses it automatically when present.
   *
   * Implementations must tolerate nesting: `fn` will call `get`/`set` on the
   * same store, and those must not try to re-acquire a non-reentrant lock.
   */
  withTransaction?<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Atomic read-modify-write for one key, safe against concurrent writers in
   * other windows/processes (native compare-and-swap loop on desktop).
   * `updateStorageValue` prefers it over the get→updater→set sequence when
   * present. The updater may run more than once on cross-window conflicts and
   * must be a pure function of its input.
   */
  update?(key: string, updater: (current: string | null) => string | null | Promise<string | null>): Promise<string | null>;
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
  supportsSshPopOut: boolean;
  supportsUpdater: boolean;
  supportsFileReveal: boolean;
  storage: RuntimeStorage;
  secureStorage: RuntimeStorage;
  request<T = unknown>(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse<T>>;
  createWebSocket(url: string): Promise<RuntimeWebSocket>;
  copyText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  getSystemNotificationPermission(): Promise<RuntimeSystemNotificationPermission>;
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
  confirmKnownHost(promptId: string, accept: boolean): Promise<void>;
  openSystemSshTerminal(request: SshConnectionRequest): Promise<void>;
  openVscodeSsh(request: SshConnectionRequest): Promise<void>;
  /** Lists every VS Code Remote-SSH key this install installed on hosts. */
  listVscodeSshKeys(): Promise<VscodeKeyRecord[]>;
  /** True when a shared VS Code key from a pre-per-host install exists locally. */
  hasLegacyVscodeKey(): Promise<boolean>;
  /**
   * Removes the legacy shared VS Code key from this machine (key files and
   * config blocks referencing it). The remote authorized_keys line needs the
   * host's own credentials — use revokeVscodeSsh from the task panel for that.
   */
  cleanupLegacyVscodeKey(): Promise<void>;
  /**
   * Revokes a VS Code Remote-SSH setup. With `removeRemote` the marked key is
   * removed from the host's `authorized_keys` first; without it only the local
   * config block and key files are deleted.
   */
  revokeVscodeSsh(request: SshConnectionRequest, removeRemote: boolean): Promise<void>;
  openSshWindow(request: SshConnectionRequest): Promise<void>;
  /**
   * Registers a user-picked directory as an allowed root for SFTP local
   * paths. Native upload/download reject local paths outside every root
   * registered for the session, so a compromised renderer cannot read or
   * write arbitrary local files. No-op on runtimes without native SFTP.
   */
  sftpRegisterLocalRoot(sessionId: string, rootPath: string): Promise<void>;
  sftpList(sessionId: string, path: string): Promise<SftpEntry[]>;
  sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<SftpTransferOutcome>;
  sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<SftpTransferOutcome>;
  sftpDelete(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, oldPath: string, newPath: string): Promise<void>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  sftpCancel(sessionId: string, transferId?: string): Promise<void>;
  onSftpProgress(sessionId: string, handler: (progress: SftpProgress) => void): Promise<() => void>;
  startPortForward(sessionId: string, rule: PortForwardRule): Promise<void>;
  stopPortForward(sessionId: string, ruleId: string): Promise<void>;
  onPortForwardStatus(sessionId: string, handler: (status: PortForwardStatus) => void): Promise<() => void>;
  listSshHistory(): Promise<SshHistoryEntry[]>;
  /** `limit` caps how many entries are kept (defaults to 20 on every runtime). */
  addSshHistory(entry: Omit<SshHistoryEntry, "id" | "connectedAt">, limit?: number): Promise<void>;
  clearSshHistory(): Promise<void>;
  setDesktopCloseToTray(enabled: boolean): Promise<void>;
  setDesktopClosePrompt(enabled: boolean): Promise<void>;
  cancelDesktopClosePrompt(): Promise<void>;
  completeDesktopClosePrompt(action: "tray" | "exit"): Promise<void>;
  showDesktopMainWindow(): Promise<void>;
  hideDesktopTrayMenu(): Promise<void>;
  runDueScheduledTasks(): Promise<void>;
  quitDesktopApp(): Promise<void>;
  /** macOS / iOS keyboards label the command modifier ⌘ rather than Ctrl. */
  isApplePlatform?: boolean;
  /** Match native window chrome to the app theme; `null` follows the OS. No-op outside desktop. */
  setNativeTheme?(theme: "light" | "dark" | null): Promise<void>;
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

export type SshSessionPhase = "connecting" | "connected" | "exited" | "failed" | "closed";

/** Coarse tab status the SSH workspace UI derives from session events. */
export type SshTabStatusKind = "ready" | "connected" | "failed" | "closed";

export type SshSessionEvent = {
  sessionId: string;
  kind: "status" | "output" | "error" | "closed" | "sftp-progress" | "port-forward-status" | "host-key-prompt";
  /** Structured session state for status/error/closed events; lets consumers derive the state without matching localized messages. */
  phase?: SshSessionPhase;
  data?: string;
  message?: string;
};

export type SshHostKeyPrompt = {
  promptId: string;
  host: string;
  port: number;
  fingerprint: string;
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
  /**
   * Session host this rule auto-starts for (case-insensitive exact match).
   * When absent, the rule auto-starts for every SSH session.
   */
  host?: string;
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
  /** Identifies the transfer this progress belongs to, so cancellation can target it. */
  transferId?: string;
  transferred: number;
  total: number;
};

export type SftpTransferStatus = "completed" | "canceled";

/**
 * Final result of one SFTP transfer, returned by the upload/download command.
 * Progress events are display-only; this outcome is the success criterion.
 * Failed transfers reject the command with the error message instead of a
 * `failed` status.
 */
export type SftpTransferOutcome = {
  transferId: string;
  operation: "upload" | "download";
  status: SftpTransferStatus;
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

/**
 * A VS Code Remote-SSH setup this install configured: the dedicated key it
 * generated, where it was installed, and its fingerprint. Listed in Settings
 * so every remote `authorized_keys` change EasyConsole made is visible and
 * revocable.
 */
export type VscodeKeyRecord = {
  alias: string;
  host: string;
  port: string;
  username: string;
  /** SHA-256 fingerprint of the installed public key. */
  fingerprint: string;
  installedAt: number;
};
