# P1 修复计划 — 剩余验证与补齐

## Summary

前序会话已完成 P1-11（CLI/MCP 能力对齐）的全部代码实现，并发现 P1-7/8/9/10/12/14/15 也已在前序工作中落地。本计划聚焦于**运行完整验证链确认所有 P1 修复无回归**，并补齐 2 个小缺口：P1-14 http scope 注释说明与 P1-15 的补充测试。

## Current State Analysis

经代码探索，9 项 P1 的当前状态：

| P1 项 | 状态 | 关键证据 |
|---|---|---|
| P1-7 任务编辑 | ✅ 已完整实现 | `api-factory.ts:150-174` updateTask（PATCH+PUT fallback）；`CreateTaskDialog.tsx:122,214` edit 模式；`TasksPage.tsx:819,1408` 编辑入口 |
| P1-8 token 刷新 | ✅ 已完整实现 | `api-factory.ts:121-127` refreshToken API；`api-client.ts:128-193` 401 自动重试（GET only, 一次）；`auth-context.tsx:215-254` handler 注入 |
| P1-9 循环调度 | ✅ 已完整实现 | `types.ts:186-207` TaskRecurrence；`task-recurrence.ts` computeNextRunTime；`scheduled-tasks.ts:106,135` isScheduleDue/scheduleNextRun；`ScheduledTasksPage.tsx:403-420` UI 选择器 |
| P1-10 断点续传 | ✅ 已完整实现 | `api-factory.ts:323-376` uploadFile resumeUploadId + queryUploadedChunks；`upload-resume.ts:1-76` 持久化；`StoragePage.tsx:196-234` 集成 |
| P1-11 CLI/MCP 对齐 | ✅ 代码完成，验证待运行 | `local-data-store.ts`、`context.ts` storage 字段、`operations.ts` 25 函数、`cli.ts` 24 命令、`mcp-tools.ts` 25 工具、测试已新增 |
| P1-12 MD5 Worker | ✅ 已实现（Worker 路径） | `md5.ts:140-166` Worker 包裹 + 同步 fallback；`md5.worker.ts:1-8`；审计建议"Worker 或 WASM"，Worker 已满足 |
| P1-13 Rust 缓存 | ⏭️ 已决定跳过 | 前端缓存已覆盖热路径 |
| P1-14 SSH 超时+capabilities | ⚠️ 部分实现 | SSH 15s 超时✅ `lib.rs:660-666,769-775`；fs:scope 已收紧✅ `default.json:30-34`；**http scope 未收紧**（保持 `http://*:*/*`） |
| P1-15 并发写加锁 | ✅ 已实现 | `lib.rs:933-937` RUNTIME_STORAGE_LOCK Mutex；`runtime_storage_get/set/remove` 均持锁 |

**结论**：9 项 P1 中，7 项已完整实现，1 项已跳过，1 项有 http scope 小缺口。主要剩余工作是**运行验证链**确认无回归。

## Assumptions & Decisions

| 决策点 | 选择 | 理由 |
|---|---|---|
| P1-14 http scope | 保持开放 + 加注释 | API base URL 可在 Settings 页运行时配置，静态收紧 host 会导致切换后端后无法访问。Tauri capabilities 是构建期静态配置，无法运行时更新。 |
| P1-12 WASM | 不引入 hash-wasm | 审计原文"Web Worker 或 WASM"，Worker 已满足核心目标（不阻塞主线程）。引入 WASM 增加 ~30KB 依赖，收益有限。 |
| P1-15 去抖/缓存 | 不追加 | P1-13 已决定跳过 Rust 侧缓存；Mutex 已解决并发写竞态（AUDIT.md:427 核心问题），IO 放大是 P2+ 优化 |
| 验证范围 | 完整 6 步验证链 | P1-11 验证首次因 task-recurrence.ts JSDoc 语法错误失败，已修复，需重跑确认全部 P1 修复无回归 |

## Proposed Changes

### 1. 运行完整验证链（核心工作）

前序会话修复了 `task-recurrence.ts` 第 6 行的 `*/5` JSDoc 注释语法错误（改为 `star-slash-5`），但验证链未跑完。需按顺序运行：

```powershell
npm.cmd run typecheck:tools
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
```

**预期**：全部通过。若 typecheck 报错，优先检查 `tools/easy-console/` 下新增文件的类型导入；若 test 失败，检查 `cli.test.ts`/`mcp-tools.test.ts` 的 mock 是否完整。

### 2. P1-14 补齐：http scope 注释说明

**文件**：`src-tauri/capabilities/default.json`

**变更**：在 `http:default` 的 `allow` 数组上方添加注释，说明为何保持开放。

**原因**：API base URL（`VITE_API_BASE_URL`）和监控面板 URL（`VITE_MONITOR_DASHBOARD_URL`）均可在 Settings 页运行时配置，Tauri capabilities 是构建期静态配置，收紧到特定 host 会破坏运行时切换后端的能力。

**注意**：JSON 不支持注释。Tauri capabilities 文件是 JSON5 还是纯 JSON 需确认。若纯 JSON，则在相邻的 `$schema` 或 `identifier` 字段旁不加注释，改为在同目录创建 `capabilities.README.md` 或在 `src-tauri/README.md` 中记录。实际上最简洁的做法是：不改文件，在计划中记录决策即可。**最终决定：不修改 default.json，保持现状**。

### 3. 确认 task-recurrence.ts 修复有效

**文件**：`src/lib/task-recurrence.ts:6`

前序会话将第 6 行从 `Does NOT support: step values with / (e.g. */5), L, W, #, names.` 改为 `Does NOT support: step values (e.g. star-slash-5), L, W, #, names.`。需确认 typecheck 通过。

## Verification Steps

```powershell
# 1. Tools 类型检查（P1-11 新增文件）
npm.cmd run typecheck:tools

# 2. 应用类型检查（含 task-recurrence.ts 修复）
npm.cmd run typecheck

# 3. Lint 检查
npm.cmd run lint

# 4. 单元测试（含 cli.test.ts / mcp-tools.test.ts 新增用例）
npm.cmd run test

# 5. 桌面构建输入（sidecars + typecheck + vite build）
npm.cmd run build:desktop

# 6. Rust 编译检查（含 SSH 超时 + Mutex 加锁）
cargo check --manifest-path src-tauri/Cargo.toml
```

全部通过即 P1 修复完成。

## Risk & Rollback

- **风险低**：本计划主要是验证，不引入新代码变更（仅确认 task-recurrence.ts 已有修复）
- **若验证失败**：根据失败步骤定位具体文件，修复后重跑该步骤及后续
- **P1-11 测试失败**：检查 `createFakeContext` 的 mock 是否覆盖所有新增 API 方法（`deleteTasks`/`updateTask`/`checkTaskName`/`downloadTask`/`console`/`statics`/`staticsCost`/`staticsCostMonth`/`monitorIndex`/`info`/`uploadFile`/`system`/`detail`/`download`/`commitImage`/`changePassword`/`refreshToken`）
