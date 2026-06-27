# P1-11: CLI/MCP 能力对齐 — 实施计划

## Summary

补齐 CLI/MCP 工具缺失的能力,使其与 Web/Desktop 端功能对齐。当前 CLI/MCP 仅暴露 16 个操作函数(任务 CRUD 基础、存储浏览、镜像列表、资源/价格列表),缺失任务编辑/批量删除/下载、镜像提交/下载/详情、存储上传、仪表盘统计、账户管理(改密/刷新 token)、以及全部本地数据操作(模板/定时任务/备份)。

本计划新增 **24 个操作函数**(15 个后端 API 类 + 9 个本地数据类),并同步注册 CLI 命令和 MCP 工具定义。

## Current State Analysis

### 已有能力(16 个操作函数,operations.ts L104-200)

| 域 | 操作 |
|---|---|
| task | listTasks, getTaskLog, createTask, releaseTask, deleteTask |
| storage | listStorage, readStorageText, downloadStoragePath, mkdirStorage, deleteStoragePath |
| image | listImages, setDefaultImage |
| auth | userInfo |
| resource | listResources, listPrices |
| monitor | monitorUrl |

### api-factory.ts 中已实现但 CLI/MCP 未暴露的方法

**instanceApi**: `console()`, `statics()`, `staticsCost()`, `staticsCostMonth()`, `updateTask()`, `checkTaskName()`, `deleteTasks()`, `monitorIndex()`, `downloadTask()`
**imageApi**: `detail()`, `download()`, `commitImage()`, `system()`(仅被 listImages 内部调用)
**storageApi**: `uploadFile()`, `info()`
**authApi**: `changePassword()`, `refreshToken()`

### 本地数据模块已实现但 CLI/MCP 未暴露

- `task-templates.ts`: `loadTaskTemplates`, `saveTaskTemplates`, `taskTemplateToPayloads`
- `scheduled-tasks.ts`: `loadScheduledTasks`, `saveScheduledTasks`, `createScheduledTask`
- `local-data-backup.ts`: `exportLocalDataBackup`, `importLocalDataBackup`

### 关键约束

1. **存储持久化**: 当前 `nodeStorage`(node-runtime.ts L9-21)是内存 Map,仅用于运行时。`runLogStorage`(run-log-store.ts)是文件持久化但仅处理 `RUN_LOGS_STORAGE_KEY` 一个键。本地数据操作(模板/定时任务/备份)需要多键持久化存储。
2. **File 类型**: `storageApi.uploadFile()` 期望 `File` 对象。Node 20+ 全局有 `File`(undici),可从 Buffer 构造。`md5Blob` 已兼容 Node(无 Worker 时同步计算)。
3. **Mutation 模式**: 现有 `maybeMutate(action, payload, confirm, run)` 模式,dry-run 默认,需 `--yes`/`confirm:true` 才执行。所有新增 mutation 遵循此模式。
4. **CLI 命令注册模式**: `run(command, handler)` 包装器自动处理 context 创建、runLog 记录、emitSuccess/emitFailure。
5. **MCP 工具定义模式**: `{ name, description, inputSchema: Record<string, z.ZodType>, handler(context, input) }`,通过 `createMcpToolDefinitions()` 返回数组。
6. **测试模式**: cli.test.ts 和 mcp-tools.test.ts 用 `createFakeContext()` 注入 mock api/storage,测试 dry-run 和 confirm 行为。

## Assumptions & Decisions

| 决策项 | 选择 | 理由 |
|---|---|---|
| 本地数据存储后端 | 新建 `createFileLocalStorage(filePath)`,持久化到 `~/.easy-console/local-data.json` | 复用 run-log-store.ts 的文件存储模式,但支持多键;与 config.json 同目录 |
| context.storage 字段 | 新增,独立于 runLogStorage | runLogStorage 仅处理单键且已优化;storage 处理多键通用数据 |
| File 上传 | 使用 Node 20+ 全局 `new File([buffer], filename)` | 项目依赖 @types/node ^25,隐含 Node 20+;tsconfig.tools.json 含 DOM lib |
| 仪表盘命令分组 | 归入 `dashboard` 命令组 | 与现有 task/storage/image 分组风格一致 |
| 账户命令分组 | 归入 `account` 命令组 | 改密、刷新 token 属账户管理 |
| 模板/定时任务/备份分组 | `template`/`schedule`/`backup` 三个命令组 | 与 Web 端页面分组对应 |
| applyTaskTemplate | 生成 payloads 后调 createTask,返回 mutation 结果 | 复用 maybeMutate,默认 dry-run |
| runScheduledTask | 手动触发:直接用 payload 调 createTask,不修改本地状态 | 定时任务的自动调度由 Desktop BackgroundScheduledTaskRunner 负责;CLI/MCP 仅提供手动触发 |
| refresh-token 命令 | 调 authApi.refreshToken,成功则保存新 token 到 config | 与 login 命令一致,持久化结果 |

## Proposed Changes

### 1. 新建 `tools/easy-console/local-data-store.ts`

文件持久化的多键 RuntimeStorage,模式参考 `run-log-store.ts`。

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RuntimeStorage } from "../../src/lib/types";

export function getDefaultLocalDataPath(configPath: string) {
  return process.env.EASY_CONSOLE_LOCAL_DATA_PATH ?? join(dirname(configPath), "local-data.json");
}

export function createFileLocalStorage(filePath: string): RuntimeStorage {
  // 缓存避免每次操作都读文件;写时整体序列化
  let cache: Map<string, string> | null = null;

  async function load(): Promise<Map<string, string>> {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      cache = new Map(Object.entries(parsed));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        cache = new Map();
      } else {
        throw error;
      }
    }
    return cache!;
  }

  async function flush(map: Map<string, string>) {
    await mkdir(dirname(filePath), { recursive: true });
    const obj = Object.fromEntries(map.entries());
    await writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  return {
    async get(key) {
      const map = await load();
      return map.get(key) ?? null;
    },
    async set(key, value) {
      const map = await load();
      map.set(key, value);
      await flush(map);
    },
    async remove(key) {
      const map = await load();
      map.delete(key);
      await flush(map);
    },
  };
}
```

### 2. 修改 `tools/easy-console/context.ts`

新增 `storage: RuntimeStorage` 字段。

```ts
import { createFileLocalStorage, getDefaultLocalDataPath } from "./local-data-store";

export type EasyConsoleContext = {
  api: EasyConsoleApi;
  client: ApiClient;
  config: EasyConsoleConfig;
  runLogStorage: RuntimeTransport["storage"];
  runLogPath: string;
  storage: RuntimeStorage;  // 新增
};

export async function createEasyConsoleContext(options: EasyConsoleContextOptions = {}): Promise<EasyConsoleContext> {
  const config = await loadEasyConsoleConfig(options);
  const client = new ApiClient(options.runtime ?? createNodeRuntime(), config.apiBaseUrl);
  client.setToken(config.token);
  const localDataPath = getDefaultLocalDataPath(config.configPath);
  return {
    api: createEasyConsoleApi(client),
    client,
    config,
    runLogPath: options.runLogPath ?? getDefaultRunLogPath(config.configPath),
    runLogStorage: createFileRunLogStorage(options.runLogPath ?? getDefaultRunLogPath(config.configPath)),
    storage: createFileLocalStorage(localDataPath),  // 新增
  };
}
```

### 3. 修改 `tools/easy-console/operations.ts`

新增 24 个操作函数,分两类:

#### 3a. 后端 API 类(15 个,走 `api` 参数)

```ts
// === Task 扩展 ===
export function updateTask(api: EasyConsoleApi, taskId: string | number, payload: Partial<CreateTaskPayload>, confirm?: boolean) {
  return maybeMutate("task.update", { id: taskId, payload }, confirm, () => api.instanceApi.updateTask(taskId, payload));
}

export function deleteTasks(api: EasyConsoleApi, taskIds: Array<string | number>, confirm?: boolean) {
  return maybeMutate("task.deleteBatch", { ids: taskIds }, confirm, () => api.instanceApi.deleteTasks(taskIds));
}

export function checkTaskName(api: EasyConsoleApi, name: string) {
  return api.instanceApi.checkTaskName(name);
}

export async function downloadTask(api: EasyConsoleApi, query: UnknownRecord, outputPath?: string) {
  const blob = await api.instanceApi.downloadTask(query);
  const targetPath = outputPath ?? `task-${Date.now()}.zip`;
  return writeBlobToFile(blob, targetPath);
}

// === Dashboard ===
export function getDashboardStats(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.instanceApi.statics(query);
}

export function getDashboardCost(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.instanceApi.staticsCost(query);
}

export function getDashboardCostMonth(api: EasyConsoleApi) {
  return api.instanceApi.staticsCostMonth();
}

export function getMonitorIndex(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.instanceApi.monitorIndex(query);
}

// === Image 扩展 ===
export function listSystemImages(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.imageApi.system(query);
}

export function getImageDetail(api: EasyConsoleApi, imageId: string | number) {
  return api.imageApi.detail(imageId);
}

export async function downloadImage(api: EasyConsoleApi, imageId: string | number, outputPath?: string) {
  const blob = await api.imageApi.download(imageId);
  const targetPath = outputPath ?? `image-${imageId}.tar`;
  return writeBlobToFile(blob, targetPath);
}

export function commitImage(api: EasyConsoleApi, payload: ImageCommitPayload, confirm?: boolean) {
  return maybeMutate("image.commit", payload, confirm, () => api.imageApi.commitImage(payload));
}

// === Storage 扩展 ===
export async function uploadLocalFile(api: EasyConsoleApi, localPath: string, remoteDirectory: string, confirm?: boolean) {
  // 读取本地文件 → File 对象 → 调 uploadFile
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const buffer = await readFile(localPath);
  const filename = basename(localPath);
  const file = new File([buffer], filename);
  return maybeMutate("storage.upload", { localPath, remoteDirectory, filename }, confirm,
    () => api.storageApi.uploadFile(file, normalizeStoragePath(remoteDirectory)));
}

export function getStorageInfo(api: EasyConsoleApi) {
  return api.storageApi.info();
}

// === Account ===
export function changePassword(api: EasyConsoleApi, payload: UnknownRecord, confirm?: boolean) {
  return maybeMutate("account.changePassword", payload, confirm, () => api.authApi.changePassword(payload));
}

export async function refreshToken(api: EasyConsoleApi, currentToken: string) {
  const newToken = await api.authApi.refreshToken(currentToken);
  return { refreshed: Boolean(newToken), token: newToken };
}
```

#### 3b. 本地数据类(9 个,走 `storage` 参数)

```ts
import { loadTaskTemplates, saveTaskTemplates, taskTemplateToPayloads, type TaskTemplate } from "../../src/lib/task-templates";
import { loadScheduledTasks, saveScheduledTasks, createScheduledTask, type ScheduledTask } from "../../src/lib/scheduled-tasks";
import { exportLocalDataBackup, importLocalDataBackup, parseLocalDataBackup, type LocalDataBackupSection } from "../../src/lib/local-data-backup";

// === Task Templates ===
export async function listTaskTemplates(storage: RuntimeStorage) {
  return loadTaskTemplates(storage);
}

export async function applyTaskTemplate(storage: RuntimeStorage, api: EasyConsoleApi, templateId: string, confirm?: boolean) {
  const templates = await loadTaskTemplates(storage);
  const template = templates.find((t) => t.id === templateId);
  if (!template) throw new Error(`Task template not found: ${templateId}`);
  const payloads = taskTemplateToPayloads(template);
  return maybeMutate("template.apply", { templateId, templateName: template.name, count: payloads.length }, confirm,
    async () => {
      const results = [];
      for (const payload of payloads) {
        results.push(await api.instanceApi.createTask(payload));
      }
      return { created: results.length, results };
    });
}

export async function deleteTaskTemplate(storage: RuntimeStorage, templateId: string, confirm?: boolean) {
  const templates = await loadTaskTemplates(storage);
  const template = templates.find((t) => t.id === templateId);
  if (!template) throw new Error(`Task template not found: ${templateId}`);
  return maybeMutate("template.delete", { templateId, templateName: template.name }, confirm,
    async () => {
      const remaining = templates.filter((t) => t.id !== templateId);
      await saveTaskTemplates(storage, remaining);
      return { deleted: true };
    });
}

// === Scheduled Tasks ===
export async function listScheduledTasks(storage: RuntimeStorage) {
  return loadScheduledTasks(storage);
}

export async function createScheduledTask(storage: RuntimeStorage, input: {
  name: string;
  description?: string;
  scheduleTime: string;
  payload: CreateTaskPayload;
  recurrence?: TaskRecurrence;
}) {
  const items = await loadScheduledTasks(storage);
  const task = createScheduledTask(input);
  await saveScheduledTasks(storage, [...items, task]);
  return task;
}

export async function runScheduledTask(storage: RuntimeStorage, api: EasyConsoleApi, taskId: string, confirm?: boolean) {
  const items = await loadScheduledTasks(storage);
  const task = items.find((t) => t.id === taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  return maybeMutate("schedule.run", { taskId, taskName: task.name }, confirm,
    () => api.instanceApi.createTask(task.payload));
}

export async function deleteScheduledTask(storage: RuntimeStorage, taskId: string, confirm?: boolean) {
  const items = await loadScheduledTasks(storage);
  const task = items.find((t) => t.id === taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  return maybeMutate("schedule.delete", { taskId, taskName: task.name }, confirm,
    async () => {
      const remaining = items.filter((t) => t.id !== taskId);
      await saveScheduledTasks(storage, remaining);
      return { deleted: true };
    });
}

// === Backup ===
export async function exportBackup(storage: RuntimeStorage, includeSecrets: boolean) {
  return exportLocalDataBackup(storage, includeSecrets);
}

export async function importBackup(storage: RuntimeStorage, backupText: string, sections: LocalDataBackupSection[], confirm?: boolean) {
  const backup = parseLocalDataBackup(backupText);
  return maybeMutate("backup.import", { sections, includeSecrets: backup.includeSecrets }, confirm,
    () => importLocalDataBackup(storage, backup, sections));
}
```

### 4. 修改 `tools/easy-console/cli.ts`

新增 7 个命令组共 24 个命令:

#### task 扩展(4 个)
- `task update <id>` — 编辑任务(复用 buildPayloadFromOptions,--yes 执行)
- `task delete-batch <ids...>` — 批量删除(逗号分隔或多个参数,--yes)
- `task check-name <name>` — 检查任务名
- `task download <id>` — 下载任务数据(--output)

#### dashboard(4 个)
- `dashboard stats` — 仪表盘统计
- `dashboard cost` — 费用统计
- `dashboard cost-month` — 月度费用
- `dashboard monitor-index` — 监控指标

#### image 扩展(4 个)
- `image system` — 系统镜像列表
- `image detail <id>` — 镜像详情
- `image download <id>` — 下载镜像(--output)
- `image commit` — 提交镜像(--payload-json 或 --pod-name + --user)

#### storage 扩展(2 个)
- `storage upload <localPath> <remoteDir>` — 上传本地文件(--yes)
- `storage info` — 存储信息

#### account(2 个)
- `account change-password` — 改密(--payload-json 或 --old/--new,--yes)
- `account refresh-token` — 刷新 token(成功后保存到 config)

#### template(3 个)
- `template list` — 列出模板
- `template apply <id>` — 应用模板创建任务(--yes)
- `template delete <id>` — 删除模板(--yes)

#### schedule(4 个)
- `schedule list` — 列出定时任务
- `schedule create` — 创建定时任务(--name,--schedule-time,--payload-json,可选 --recurrence-json)
- `schedule run <id>` — 手动触发(--yes)
- `schedule delete <id>` — 删除(--yes)

#### backup(2 个)
- `backup export` — 导出本地数据(--include-secrets)
- `backup import <file>` — 导入本地数据(--sections,--yes)

#### sourceForCommand 更新
```ts
function sourceForCommand(action: string): RunLogSource {
  if (action.startsWith("login") || action.startsWith("whoami") || action.startsWith("account.")) return "auth";
  if (action.startsWith("task.") || action.startsWith("template.") || action.startsWith("schedule.")) return "task";
  if (action.startsWith("storage.") || action.startsWith("backup.")) return "storage";
  if (action.startsWith("image.") || action.startsWith("dashboard.")) return "image";
  if (action.startsWith("resource.") || action.startsWith("price.") || action.startsWith("monitor-url")) return "system";
  return "system";
}
```

#### account refresh-token 特殊处理
refresh-token 成功后需保存新 token 到 config 文件:
```ts
accountRefresh.action(run(accountRefresh, async (context) => {
  if (!context.config.token) throw new Error("No current token found in config.");
  const result = await refreshToken(context.api, context.config.token);
  if (result.token) {
    await saveEasyConsoleConfig({ apiBaseUrl: context.config.apiBaseUrl, token: result.token }, context.config.configPath);
    context.client.setToken(result.token);
  }
  return result;
}));
```

### 5. 修改 `tools/easy-console/mcp-tools.ts`

追加 24 个 MCP 工具定义到 `createMcpToolDefinitions()` 返回数组:

| 工具名 | 输入 schema |
|---|---|
| `easyconsole_task_update` | `{ taskId: idSchema, payload: z.record(), confirm?: }` |
| `easyconsole_task_delete_batch` | `{ taskIds: z.array(idSchema), confirm?: }` |
| `easyconsole_task_check_name` | `{ name: z.string() }` |
| `easyconsole_task_download` | `{ taskId: idSchema, outputPath?: }` |
| `easyconsole_dashboard_stats` | `{ query?: }` |
| `easyconsole_dashboard_cost` | `{ query?: }` |
| `easyconsole_dashboard_cost_month` | `{}` |
| `easyconsole_dashboard_monitor_index` | `{ query?: }` |
| `easyconsole_image_system` | `{ query?: }` |
| `easyconsole_image_detail` | `{ imageId: idSchema }` |
| `easyconsole_image_download` | `{ imageId: idSchema, outputPath?: }` |
| `easyconsole_image_commit` | `{ payload: z.record(), confirm?: }` |
| `easyconsole_storage_upload` | `{ localPath: z.string(), remoteDirectory: z.string(), confirm?: }` |
| `easyconsole_storage_info` | `{}` |
| `easyconsole_account_change_password` | `{ payload: z.record(), confirm?: }` |
| `easyconsole_account_refresh_token` | `{}` |
| `easyconsole_template_list` | `{}` |
| `easyconsole_template_apply` | `{ templateId: z.string(), confirm?: }` |
| `easyconsole_template_delete` | `{ templateId: z.string(), confirm?: }` |
| `easyconsole_schedule_list` | `{}` |
| `easyconsole_schedule_create` | `{ name: z.string(), scheduleTime: z.string(), payload: z.record(), description?:, recurrence?: }` |
| `easyconsole_schedule_run` | `{ taskId: z.string(), confirm?: }` |
| `easyconsole_schedule_delete` | `{ taskId: z.string(), confirm?: }` |
| `easyconsole_backup_export` | `{ includeSecrets: z.boolean().optional() }` |
| `easyconsole_backup_import` | `{ backupText: z.string(), sections?: z.array(z.string()), confirm?: }` |

注意:`easyconsole_account_refresh_token` 成功后需保存新 token,handler 内部处理(与 CLI 一致)。

### 6. 更新 `tools/easy-console/cli.test.ts` 和 `mcp-tools.test.ts`

扩展 `createFakeContext()`:
- 添加 `storage: memoryStorage()` 字段
- 添加 mock 方法: `instanceApi.updateTask`, `deleteTasks`, `checkTaskName`, `downloadTask`, `console`, `statics`, `staticsCost`, `staticsCostMonth`, `monitorIndex`; `imageApi.detail`, `download`, `commitImage`; `storageApi.uploadFile`, `info`; `authApi.changePassword`, `refreshToken`

新增测试用例(每个命令至少一个):
- CLI: dry-run 行为(mutations)、JSON 输出格式、本地数据操作 CRUD
- MCP: dry-run 行为、input validation、本地数据操作 CRUD

### 文件变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `tools/easy-console/local-data-store.ts` | 新建 | 文件持久化多键 RuntimeStorage |
| `tools/easy-console/context.ts` | 修改 | 新增 `storage` 字段 |
| `tools/easy-console/operations.ts` | 修改 | 新增 24 个操作函数 |
| `tools/easy-console/cli.ts` | 修改 | 新增 24 个 CLI 命令 |
| `tools/easy-console/mcp-tools.ts` | 修改 | 追加 24 个 MCP 工具定义 |
| `tools/easy-console/cli.test.ts` | 修改 | 扩展 mock + 新增测试 |
| `tools/easy-console/mcp-tools.test.ts` | 修改 | 扩展 mock + 新增测试 |

## Verification Steps

按 AGENTS.md 约定的验证链:

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
```

重点验证:
1. `typecheck:tools` — 确认 operations.ts/cli.ts/mcp-tools.ts 类型正确,File/Blob/FormData 在 Node 环境可用
2. `test` — 确认 cli.test.ts 和 mcp-tools.test.ts 全部通过(含新增 24 命令的 dry-run 和 confirm 测试)
3. `lint` — 无新增 lint 错误
4. `build:desktop` — sidecar 构建成功

## Risk & Rollback

- **风险**: `File` 全局在低版本 Node 不可用。缓解: 项目 @types/node ^25 隐含 Node 20+,`File` 已是全局;若需兼容可在 uploadLocalFile 中加 `typeof File === "undefined"` 检测并降级到 Blob+name 属性注入。
- **风险**: local-data.json 与 Web/Desktop 的 localStorage/Tauri storage 键空间隔离,CLI 创建的模板/定时任务不会自动同步到桌面端。缓解: 这是预期行为(CLI/MCP 是独立工具),backup 命令提供跨端迁移路径。
- **回滚**: 所有变更集中在 `tools/easy-console/` 目录,回滚仅需还原该目录下 7 个文件。无 src/ 或 src-tauri/ 变更,不影响 Web/Desktop 构建。
