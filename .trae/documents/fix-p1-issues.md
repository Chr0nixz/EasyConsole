# 修复 EasyConsole P1 问题实施计划

## Summary

本计划针对 AUDIT.md 中标记为 P1 的 9 个问题进行修复，覆盖功能完整性（7-11）、运行效率（12-13）、架构稳定性（14-15）。后端依赖项（任务编辑、token 刷新、断点续传）采用"客户端优先+优雅降级"策略：按推测接口路径实现调用，接口不存在时捕获 404/405 优雅降级。所有修改遵循 AGENTS.md 的桌面优先 + 适配器边界原则。

## Current State Analysis

### P1-7：任务编辑能力缺失
- **位置**：[api-factory.ts](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts) L116-165 instanceApi 仅有 `createTask`/`operateTask`（释放）/`deleteTask`，无 `updateTask`
- **现状**：[CreateTaskDialog.tsx](file:///d:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx) 始终走 `createTask`，克隆只能新建副本不能改原任务
- **后端依赖**：未知是否存在 `PATCH /instance/task/{id}` 或 `PUT /instance/task/{id}` 带 body 的编辑接口。`operateTask` 已占用 `PUT /instance/task/{id}` 但语义是释放

### P1-8：token 刷新机制缺失
- **位置**：[auth-context.tsx](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx) 无 `refreshToken` 逻辑，token 过期只能 `UNAUTHORIZED_EVENT` → 登出
- **现状**：用户需重新输入密码；[api-factory.ts](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts) L92-114 authApi 仅有 `bootstrapToken`/`login`/`userInfo`/`changePassword`
- **后端依赖**：未知是否存在 `POST /user/refresh_token` 或类似接口

### P1-9：定时任务无循环调度
- **位置**：[scheduled-tasks.ts](file:///d:/Projects/EasyConsole/src/lib/scheduled-tasks.ts) L72-76 `isScheduleDue` 仅检查单一 `scheduleTime`（ISO 时刻），不支持 cron/interval/daily
- **现状**：无 `recurrence` 字段；[ScheduledTasksPage.tsx](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx) 表单只能设单次时间
- **无后端依赖**：纯本地数据模型

### P1-10：存储断点续传缺失
- **位置**：[api-factory.ts](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts) L279-295 `uploadFile` 5MB 分片循环，中断后必须从头开始
- **现状**：无 `uploadId`/已传分片清单持久化；[StoragePage.tsx](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx) L169-227 `runUploadQueue` 串行处理
- **后端依赖**：未知是否有"查询已传分片"接口。`uploadChunk` 已接受 `uploadId` 参数（L283），`uploadComplete` 接受 `uploadId`（L295）

### P1-11：CLI/MCP 能力对齐缺口
- **位置**：[tools/easy-console/operations.ts](file:///d:/Projects/EasyConsole/tools/easy-console/operations.ts) 现有操作：listTasks/getTaskLog/createTask/releaseTask/deleteTask/listStorage/readStorageText/downloadStoragePath/mkdirStorage/deleteStoragePath/listImages/setDefaultImage/userInfo/listResources/listPrices/monitorUrl
- **缺失**（与 Web 端对比）：任务模板、定时任务、镜像提交（commitImage）、镜像下载（imageApi.download）、镜像详情（imageApi.detail）、批量任务操作（deleteTasks）、存储上传（uploadLocalFile）、dashboard 统计（statics/staticsCost）、改密（changePassword）、本地数据备份
- **无后端依赖**：API 工厂已有这些方法，CLI/MCP 只需封装注册

### P1-12：MD5 阻塞主线程
- **位置**：[md5.ts](file:///d:/Projects/EasyConsole/src/lib/md5.ts) L50 `md5ArrayBuffer` 纯 JS 同步实现，L140 `md5Blob` 一次性 `blob.arrayBuffer()` 后同步计算
- **现状**：[api-factory.ts](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts) L265、L292 上传完成时对整文件计算 MD5，大文件（数百 MB~GB）卡顿主线程

### P1-13：Tauri runtime-storage 全量读写
- **位置**：[lib.rs](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs) L930-935 `runtime_storage_set` 每次读整个 JSON map → 改一个 key → 写回整个 map
- **现状**：[run-logs.ts](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts) L188 `appendRunLog` read-modify-write + Tauri 后端再读再写 = 4 次 IO；[BackgroundScheduledTaskRunner.tsx](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx) 每次状态变更全量写

### P1-14：SSH connect 无超时 + http scope 过宽
- **位置**：[lib.rs](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs) L765 `client::connect` 无超时，L660 VS Code 公钥安装同样无超时
- **现状**：网络不通时一直挂起；[capabilities/default.json](file:///d:/Projects/EasyConsole/src-tauri/capabilities/default.json) http scope 全开 `http://*:*/*` + `https://*:*/*`
- **注**：fs scope 已在 P0-2 收紧（移除 `$DOCUMENT/**`、`$DESKTOP/**`）

### P1-15：runtime-storage.json 并发写无锁
- **位置**：[lib.rs](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs) L918-943 `runtime_storage_get/set/remove` 无文件锁
- **现状**：`appendRunLog` 与 `saveScheduledTasks` 并发调用时存在 lost-update 竞态：A 读 → B 读 → A 写 → B 写（A 更新被覆盖）

## Assumptions & Decisions

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 修复范围 | 全部 9 项 | 用户明确要求 |
| 后端依赖策略 | 客户端优先+优雅降级 | 按推测接口路径调用，404/405 时降级 |
| 任务编辑接口路径 | `PATCH /instance/task/{id}` | PUT 已被 operateTask（释放）占用，PATCH 语义更贴合部分更新 |
| token 刷新接口路径 | `POST /user/refresh_token` | 遵循 `/user/*` 命名空间 |
| 断点续传查询接口 | `GET /storage/chunked_upload_status?upload_id={id}` | 推测路径，404 时用客户端记录 |
| http scope 收紧 | **保留现状** | 运行时 URL 可配置（Settings 页动态切换 API base/Monitor URL）需求 > 静态 scope 收紧收益；桌面应用用户信任度高，且 fetch 经 api-client URL 校验 |
| MD5 Worker 实现 | 原生 Web Worker + 内联 md5.ts | 不引入 WASM 依赖，复用现有纯 JS 实现 |
| Tauri storage 优化 | Rust 层内存缓存 + Mutex | 单进程内 Mutex 串行化读写 + 内存 HashMap 缓存避免重复文件 IO |
| 循环调度模型 | recurrence 字段 `{ type: "once"\|"daily"\|"weekly"\|"cron", cron?: string, intervalSec?: number }` | 覆盖常见场景，cron 可选支持高级用户 |
| CLI config 目录 | 复用现有 `operations.ts` 的 `maybeMutate` 模式 | 保持一致性 |

## Proposed Changes

### P1-7：任务编辑（客户端优先+优雅降级）

**修改文件**：

1. `src/lib/api-factory.ts`
   - instanceApi 新增 `updateTask(id: string, payload: Partial<CreateTaskPayload>)`：`PATCH /instance/task/{id}`，返回解析后的 task
   - 新增 `isTaskEditable` 标志位（前端缓存，首次 404/405 后设为 false，避免重复尝试）

2. `src/components/tasks/CreateTaskDialog.tsx`
   - props 新增 `mode?: "create" | "edit"` 和 `editTaskId?: string`
   - `mode === "edit"` 时：标题改为"编辑任务"，submit 调用 `updateTask(editTaskId, payload)`，成功 toast "任务已更新"
   - 捕获 404/405：`setFormError("后端不支持任务编辑，请删除后重建")`，设 `isTaskEditable = false`

3. `src/pages/TasksPage.tsx`
   - 行操作菜单"克隆"旁新增"编辑"项（仅当 `isTaskEditable !== false` 时显示）
   - 点击编辑打开 `CreateTaskDialog mode="edit" editTaskId={task.id} initialTask={task}`

4. `tools/easy-console/operations.ts` + `cli.ts` + `mcp-tools.ts`
   - 新增 `updateTask(api, id, payload, confirm)` 操作
   - CLI 注册 `task update <id> --name <name> --image <image> ...`
   - MCP 注册 `easyconsole_task_update`

### P1-8：token 刷新（客户端优先+优雅降级）

**修改文件**：

1. `src/lib/api-factory.ts`
   - authApi 新增 `refreshToken(currentToken: string)`：`POST /user/refresh_token`，body `{ token: currentToken }`，返回 `{ token: string }`

2. `src/lib/auth-context.tsx`
   - 新增 `refreshAttemptedRef = useRef(false)` 防止重复尝试
   - 监听 `UNAUTHORIZED_EVENT`：首次触发时尝试 `refreshToken`，成功则更新 token 并重试原请求；失败（404/405/网络错误）则走原登出流程
   - 新增 token 临过期检测：可选（需 token 含 exp claim），若 JWT 则解析 exp，临过期前 5 分钟静默刷新；若非 JWT 则不做主动刷新，仅被动 401 触发

3. `src/lib/api-client.ts`
   - `fetchRequest` 新增请求重试队列：401 时触发 `UNAUTHORIZED_EVENT`，若 `refreshToken` 成功则重试排队请求，否则全部 reject

### P1-9：定时任务循环调度

**修改文件**：

1. `src/lib/types.ts`
   - `ScheduledTask` 新增 `recurrence?: TaskRecurrence` 字段
   - 新增 `TaskRecurrence` 类型：`{ type: "once" | "daily" | "weekly" | "interval" | "cron"; cron?: string; intervalSec?: number; endDate?: string }`

2. `src/lib/scheduled-tasks.ts`
   - `normalizeSchedule` 校验 `recurrence` 字段
   - `isScheduleDue` 重写：
     - `type === "once"`：保持现有逻辑
     - `type === "daily"`：检查今天 scheduleTime 时刻是否已过且上次执行非今天
     - `type === "weekly"`：检查今天是星期几是否匹配
     - `type === "interval"`：检查 `lastRunAt + intervalSec` 是否已过
     - `type === "cron"`：用简单 cron 解析器（自实现或引入 `cron-parser` 轻量库）计算下次触发
   - 新增 `computeNextRunTime(task)` 辅助函数
   - `createScheduledTask` 接受 `recurrence` 参数

3. `src/pages/ScheduledTasksPage.tsx`
   - 表单新增"重复"选择器：单次/每天/每周/间隔/自定义 cron
   - cron 输入框带校验提示
   - 任务列表显示重复类型 badge

4. `src/components/BackgroundScheduledTaskRunner.tsx`
   - `executeDueTasks` 成功后：若 `recurrence && type !== "once"`，计算下次触发时间并更新 `scheduleTime`，状态重置为 `pending`（而非 `done`）
   - 新增启动恢复：把 `running` 状态的任务重置为 `pending`（防崩溃滞留）

### P1-10：存储断点续传（客户端优先+优雅降级）

**修改文件**：

1. `src/lib/api-factory.ts`
   - `uploadFile` 新增 `resumeFromUploadId?: string` 参数
   - 新增 `queryUploadedChunks(uploadId: string)`：`GET /storage/chunked_upload_status?upload_id={id}`，404 时返回 null（降级到客户端记录）
   - `uploadFile` 逻辑：若有 `resumeFromUploadId`，先调 `queryUploadedChunks`，成功则跳过已传分片；失败则查客户端记录

2. `src/lib/upload-resume.ts`（新建）
   - `UploadResumeRecord` 类型：`{ fileKey: string; uploadId: string; uploadedChunks: number[]; md5?: string; createdAt: string }`
   - `fileKey` = `${name}-${size}-${lastModified}` 哈希，用于识别同一文件
   - `loadUploadResume(storage, fileKey)` / `saveUploadResume(storage, record)` / `clearUploadResume(storage, fileKey)`
   - 存储到 `runtime-storage.json` 的 `easy-console.upload-resume` key

3. `src/lib/upload-queue.ts`
   - 队列项新增 `resumeFromUploadId?: string`
   - 失败重试时自动传入

4. `src/pages/StoragePage.tsx`
   - `runUploadQueue` 调用 `uploadFile` 前查 `loadUploadResume`，有记录则传 `resumeFromUploadId`
   - 上传成功后 `clearUploadResume`
   - 上传中断（用户取消/网络断开）后 `saveUploadResume` 记录已传分片

### P1-11：CLI/MCP 能力对齐

**修改文件**：

1. `tools/easy-console/operations.ts`
   - 新增操作封装（均走 `maybeMutate` 模式）：
     - `commitImage(api, payload, confirm)` → `imageApi.commitImage`
     - `downloadImage(api, id, dest, confirm)` → `imageApi.download` + `writeBlobToFile`
     - `getImageDetail(api, id)` → `imageApi.detail`
     - `deleteTasks(api, ids, confirm)` → `instanceApi.deleteTasks`
     - `uploadLocalFile(api, filePath, storagePath, confirm)` → `storageApi.uploadFile`（Node fs.readFile → Blob）
     - `getDashboardStats(api, query?)` → `instanceApi.statics`
     - `getDashboardCost(api, query?)` → `instanceApi.staticsCost`
     - `changePassword(api, payload, confirm)` → `authApi.changePassword`
     - `listTaskTemplates(storage)` / `applyTaskTemplate(storage, id, confirm)` / `deleteTaskTemplate(storage, id)` → 本地存储操作
     - `listScheduledTasks(storage)` / `createScheduledTask(storage, input)` / `runScheduledTask(storage, id, confirm)` / `deleteScheduledTask(storage, id)`
     - `exportBackup(storage)` / `importBackup(storage, file)`

2. `tools/easy-console/cli.ts`
   - 注册新命令树：
     - `task delete-batch <ids...>`
     - `image commit` / `image download <id> --dest <path>` / `image detail <id>`
     - `storage upload <localPath> <storagePath>`
     - `dashboard stats [--query ...]` / `dashboard cost [--query ...]`
     - `account change-password`
     - `template list` / `template apply <id>` / `template delete <id>`
     - `schedule list` / `schedule create` / `schedule run <id>` / `schedule delete <id>`
     - `backup export --dest <path>` / `backup import <path>`

3. `tools/easy-console/mcp-tools.ts`
   - `createMcpToolDefinitions()` 数组追加对应工具：
     - `easyconsole_task_delete_batch`
     - `easyconsole_image_commit` / `easyconsole_image_download` / `easyconsole_image_detail`
     - `easyconsole_storage_upload`
     - `easyconsole_dashboard_stats` / `easyconsole_dashboard_cost`
     - `easyconsole_account_change_password`
     - `easyconsole_template_list` / `easyconsole_template_apply` / `easyconsole_template_delete`
     - `easyconsole_schedule_list` / `easyconsole_schedule_create` / `easyconsole_schedule_run` / `easyconsole_schedule_delete`
     - `easyconsole_backup_export` / `easyconsole_backup_import`

### P1-12：MD5 移至 Web Worker

**新建文件**：

1. `src/lib/md5.worker.ts`
   - 导入 `md5ArrayBuffer` from `./md5`
   - 监听 `message` 事件，接收 `ArrayBuffer`，计算后 `postMessage` 返回 hex 字符串
   - 使用 Vite 的 `?worker` 导入语法（`new Worker(new URL("./md5.worker.ts", import.meta.url), { type: "module" })`）

**修改文件**：

2. `src/lib/md5.ts`
   - `md5Blob` 改为异步 Worker 调用：
     ```ts
     import Md5Worker from "./md5.worker.ts?worker";
     export async function md5Blob(blob: Blob): Promise<string> {
       const worker = new Md5Worker();
       const buffer = await blob.arrayBuffer();
       return new Promise((resolve, reject) => {
         worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
         worker.onerror = (e) => { reject(e.error); worker.terminate(); };
         worker.postMessage(buffer, [buffer]);  // transferable
       });
     }
     ```
   - 保留 `md5ArrayBuffer` 同步版本（Worker 内部和测试用）
   - 添加 Worker 不可用降级（`typeof Worker === "undefined"` 时回退同步计算，如 Node 环境）

3. `src/lib/md5.test.ts`
   - 新增 Worker 异步测试

### P1-13：Tauri runtime-storage 增量写 + 前端缓存

**修改文件**：

1. `src-tauri/src/lib.rs`
   - 新增全局 `RUNTIME_STORAGE_CACHE: Lazy<Mutex<Option<HashMap<String, String>>>>` 和 `RUNTIME_STORAGE_LOCK: Lazy<Mutex<()>>`
   - `runtime_storage_get`：先锁 `RUNTIME_STORAGE_LOCK`，查缓存命中则返回，未命中则读文件并填充缓存
   - `runtime_storage_set`：锁 `RUNTIME_STORAGE_LOCK`，更新缓存，写文件（去抖落盘可选，初期直接写）
   - `runtime_storage_remove`：锁 `RUNTIME_STORAGE_LOCK`，缓存删除 key，写文件
   - 新增 `runtime_storage_flush` 命令（可选，用于强制落盘）
   - 缓存在首次 get/set 时懒加载

2. `src/lib/runtime.ts`
   - `tauriStorageAdapter` 前端加内存缓存镜像：`const storageCache = new Map<string, string | null>()`
   - `get`：先查缓存，未命中调 Tauri 命令并填充缓存
   - `set`：更新缓存 + 调 Tauri 命令
   - `remove`：删除缓存 + 调 Tauri 命令
   - 缓存减少 IPC 往返，Rust 侧 Mutex 解决并发写

### P1-14：SSH connect 超时

**修改文件**：

1. `src-tauri/src/lib.rs`
   - `run_russh_session` L765：`client::connect(config, (host, port), handler)` 包裹 `tokio::time::timeout(Duration::from_secs(15), ...)`，超时返回 `"SSH 连接超时，请检查网络和主机是否可达"`
   - `install_vscode_public_key` L660：同样包裹 15s 超时
   - 超时后清理 session 状态
   - http scope：**保留现状**（运行时可配置 URL 需求优先）

### P1-15：runtime-storage.json 并发写加锁

**与 P1-13 合并实现**：

- P1-13 的 `RUNTIME_STORAGE_LOCK: Lazy<Mutex<()>>` 同时解决 P1-15 的并发写问题
- 所有 `runtime_storage_get/set/remove` 命令都在 `RUNTIME_STORAGE_LOCK.lock()` 内执行，串行化读写
- 前端 `tauriStorageAdapter` 的内存缓存进一步减少并发读

## 文件变更清单

### 新建
- `src/lib/md5.worker.ts`
- `src/lib/upload-resume.ts`
- `src/lib/task-recurrence.ts`（cron 解析 + computeNextRunTime，避免 scheduled-tasks.ts 膨胀）

### 修改
- `src/lib/types.ts`（TaskRecurrence 类型 + ScheduledTask.recurrence 字段）
- `src/lib/api-factory.ts`（updateTask / refreshToken / queryUploadedChunks + uploadFile resume 参数）
- `src/lib/auth-context.tsx`（token 刷新逻辑 + 401 重试队列）
- `src/lib/api-client.ts`（请求重试队列支持）
- `src/lib/scheduled-tasks.ts`（recurrence 校验 + isScheduleDue 重写 + 启动恢复）
- `src/lib/md5.ts`（md5Blob 改用 Worker）
- `src/lib/runtime.ts`（tauriStorageAdapter 前端缓存）
- `src/lib/upload-queue.ts`（resumeFromUploadId 字段）
- `src/components/tasks/CreateTaskDialog.tsx`（mode: edit 分支）
- `src/pages/TasksPage.tsx`（编辑入口）
- `src/pages/ScheduledTasksPage.tsx`（重复选择器 + 列表 badge）
- `src/pages/StoragePage.tsx`（断点续传集成）
- `src/components/BackgroundScheduledTaskRunner.tsx`（循环任务重置 + 启动恢复）
- `src-tauri/src/lib.rs`（RUNTIME_STORAGE_CACHE/LOCK + SSH connect 超时）
- `tools/easy-console/operations.ts`（新增 15+ 操作封装）
- `tools/easy-console/cli.ts`（新增命令树）
- `tools/easy-console/mcp-tools.ts`（新增 MCP 工具定义）

### 测试
- `src/lib/md5.test.ts`（Worker 异步测试）
- `src/lib/scheduled-tasks.test.ts`（recurrence + isScheduleDue 新逻辑）
- `src/lib/upload-resume.test.ts`（新建，断点续传记录读写）
- `src/lib/api-factory.test.ts`（updateTask / refreshToken / queryUploadedChunks）
- `tools/easy-console/cli.test.ts`（新增命令测试）
- `tools/easy-console/mcp-tools.test.ts`（新增工具测试）

## Verification Steps

按 AGENTS.md 要求执行：

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
```

**重点验证项**：
1. typecheck：TaskRecurrence 类型、Worker 导入语法、upload-resume 类型
2. typecheck:tools：新增 CLI/MCP 操作类型
3. test：md5 Worker、scheduled-tasks recurrence、upload-resume、api-factory 新接口
4. build:desktop：Vite Worker 构建成功
5. cargo check：RUNTIME_STORAGE_CACHE/LOCK 编译、SSH timeout 编译

**手动验证**（如条件允许）：
- 桌面端创建循环调度任务，验证每天/间隔/cron 触发
- 上传大文件中断后重试，验证跳过已传分片
- SSH 连接不存在的主机，验证 15s 超时
- CLI 执行 `ec storage upload` / `ec image commit` / `ec dashboard stats`
- 英文 locale 下 token 刷新降级提示

## Risk & Rollback

**风险**：
1. token 刷新拦截器可能引入请求重放复杂度 → 仅对 GET 请求自动重试，POST/PUT/DELETE 需用户确认
2. cron 解析器引入新依赖 → 优先自实现轻量解析（仅支持 5 字段标准 cron），避免引入 `cron-parser` 库
3. Worker 在 Tauri 移动端可能不可用 → 降级为同步计算（`typeof Worker === "undefined"` 检查）
4. Rust 全局 Mutex 若 panic 会 poison lock → 所有 lock 内操作无 unwrap，用 map_err 转 String
5. 断点续传客户端记录可能与后端状态不一致 → 上传完成后调 `uploadComplete` 验证，失败则回退到从头上传
6. 任务编辑若后端实际支持 PUT 带 body（而非 PATCH），operateTask 释放接口可能冲突 → 首次 405 后自动尝试 PUT 备选路径

**回滚**：所有改动均在 git 版本控制下，建议按 P1 分 9 次提交，便于独立回滚。
