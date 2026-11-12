# EasyConsole 项目审阅（2026-11-12）

> 审阅日期：2026-11-12<br>
> 审阅范围：当前工作区（`main` @ `d5f1cb9`，含 44 个已修改、16 个未跟踪文件的未提交改动）中的 Tauri 桌面端、React 渲染层、共享 API 与运行时适配、CLI/MCP、自动化测试与 CI<br>
> 审阅性质：静态代码审阅、现有自动化检查、一项浏览器实测；本次没有修改产品源码<br>
> 相关历史文档：[AUDIT.md](AUDIT.md)（2026-08-13）、[PROJECT_REVIEW_2026-10-24.md](PROJECT_REVIEW_2026-10-24.md)、[PROJECT_REVIEW_2026-10-25.md](PROJECT_REVIEW_2026-10-25.md)、[REVIEW_FOLLOWUP_2026-10-27.md](REVIEW_FOLLOWUP_2026-10-27.md)

## 1. 结论摘要

项目整体质量高。约 7 万行代码（`src/lib` 2.2 万、`src/components` 1.7 万、`src/pages` 1.3 万、`src-tauri/src` 1.1 万、`tools` 0.7 万），分层清晰，平台调用都收在运行时适配层后面。计费相关路径（定时创建、批量重试、令牌刷新）都按"结果未知不重放"设计。上一轮（10-25）的 P1 本轮抽查了三项，均已修复：

- 下载超时已改为按数据块重置的空闲超时（[src/lib/runtime.ts](src/lib/runtime.ts#L446)）。
- 刷新令牌期间切换账号会抛 `SessionChangedError` 并丢弃刷新结果（[src/lib/api-client.ts](src/lib/api-client.ts#L69)、[src/lib/auth-context.tsx](src/lib/auth-context.tsx#L470)）。
- 本地存储已拆成按 key 的文件、异步命令、CAS 和跨进程锁（[src-tauri/src/runtime_storage.rs](src-tauri/src/runtime_storage.rs)）。

当前风险集中在**未提交的那批改动**上。本轮新发现：

- 2 项建议提交前修复：创建表单的 Enter 防护漏掉了下拉框（已实测）；`npm run test` 把旧 worktree 的测试也跑了进去。
- 3 项需要决策：未合并的 launchd 唤醒提交、macOS 11–13 的后台调度、未提交改动的拆分。
- 6 项中低优先级问题和若干零碎。

## 2. 已验证结果与范围限制

### 通过的检查

| 命令/检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run typecheck:tools` | 通过 |
| `npm run lint` | 0 errors、37 warnings，与 ratchet 持平 |
| `npm run test` | 报告 244 个文件、1819 项全部通过；其中 120 个文件来自旧 worktree（见 P1-2） |
| `npx vitest run --exclude '.claude/**'` | 124 个文件、921 项全部通过（当前工作区的真实数字） |
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| `cargo test --lib` | 86 项全部通过 |
| 下拉框 Enter 提交复现 | Chromium 152（macOS）：文本框按 Enter 不提交，下拉框按 Enter 提交 |

### 未覆盖的事项

- 没有运行 `build:desktop`、`tauri:build` 和 SSH 集成测试（`--features ssh-test-internals`）。
- 没有使用真实账号对真实 API、真实 SSH 服务做端到端验证。
- 没有在打包后的 macOS 应用（WKWebView）里实测；P1-1 的实测环境是 Chromium。
- 没有在 macOS 11–13 上验证后台调度（见 D-2）。
- 重点读了核心库（API 客户端、运行时适配、认证、定时执行）、Rust 外壳的命令与路径校验、CLI/MCP 的写操作防护，以及全部未提交 diff。SSH 模块（`session.rs`、`sftp.rs`、`vscode.rs`）和大部分页面组件只做了抽查。

## 3. 建议提交前修复

### P1-1：焦点在下拉框时按 Enter 仍会提交创建表单（已复现）

- **位置：**[src/lib/form-submit-keys.ts](src/lib/form-submit-keys.ts#L21)。
- **原因：**`guardImplicitSubmit` 只对 `HTMLInputElement` 调用 `preventDefault()`。浏览器对聚焦的 `<select>` 按 Enter 同样会触发表单隐式提交，这条路径没有被拦住。
- **复现：**用与 `guardImplicitSubmit` 相同的逻辑搭了一个含文本框、下拉框和提交按钮的最小表单，在 Chromium 152 中用真实按键测试。文本框按 Enter 不触发 `submit`；下拉框按 Enter 触发 `submit`。
- **影响：**创建对话框里有 4 个下拉框：镜像（[CreateTaskDialog.tsx](src/components/tasks/CreateTaskDialog.tsx#L989)）、释放条件（[CreateTaskDialog.tsx](src/components/tasks/CreateTaskDialog.tsx#L1107)），以及 [ResourcePriceFields.tsx](src/components/tasks/ResourcePriceFields.tsx#L103) 里的两个。单实例创建不经过确认直接提交并开始计费，这与 PRODUCT.md 本次新增的 "Enter in a field never submits it" 不符。
- **范围：**Windows 的 WebView2 与 Chromium 同内核。macOS 的 WKWebView 没有实测。
- **测试缺口：**[src/lib/form-submit-keys.test.tsx](src/lib/form-submit-keys.test.tsx) 的测试表单里没有 `<select>`；jsdom 也不模拟隐式提交，只能断言 keydown 的默认行为是否被取消。
- **建议：**
  - 对 `HTMLSelectElement` 同样取消 Enter 的默认行为；
  - 在测试表单里加一个 `<select>`，断言其 Enter keydown 被取消；
  - 打包后在 macOS 和 Windows 上各手动确认一次。

### P1-2：`npm run test` 把旧 worktree 的测试也跑了

- **位置：**[vite.config.ts](vite.config.ts#L32)。
- **原因：**`test` 配置没有 `exclude`。仓库里有一个 git worktree `.claude/worktrees/ecstatic-clarke-2def7a`，Vitest 把其中 120 个测试文件一并收集。ESLint 的忽略项本次已经加上（[eslint.config.js](eslint.config.js#L10)），Vitest 漏了。
- **影响：**本地 `npm run test` 报告的 244 个文件、1819 项里，将近一半是另一个分支的代码副本。结果混了两个版本，耗时翻倍，那个分支的失败会表现为当前工作区的失败。CI 上没有这个 worktree，不受影响。
- **建议：**在 `test` 里加 `exclude: [...configDefaults.exclude, ".claude/**"]`。

## 4. 需要决策的事项

### D-1：worktree 里有一个未合并的提交

- **现状：**分支 `claude/ecstatic-clarke-2def7a` 比 `main` 多一个提交 `4f9a115`（2026-11-07，`feat(macos): start the app for due schedules through launchd`），新增 647 行的 `src-tauri/src/scheduled_wake_macos.rs`，并改动 `lib.rs`、`ScheduledWakeSettings.tsx`、README、PRODUCT.md 和 AI skill。该 worktree 工作区是干净的。
- **冲突：**当前未提交的 README 写的是 "scheduled wake-up is Windows-only"。两边在 `lib.rs`、README、PRODUCT.md 上会冲突。
- **需要决定：**合并这个提交，还是放弃它并移除 worktree。放弃的话 P1-2 的重复测试也随之消失，但 Vitest 的排除项仍建议加上。

### D-2：macOS 11–13 上后台定时任务能否执行未经验证

- **位置：**[src-tauri/tauri.macos.conf.json](src-tauri/tauri.macos.conf.json#L16)（`backgroundThrottling: "throttle"`）、[同文件](src-tauri/tauri.macos.conf.json#L29)（`minimumSystemVersion: "11.0"`）、[src/components/BackgroundScheduledTaskRunner.tsx](src/components/BackgroundScheduledTaskRunner.tsx#L328)。
- **原因：**Tauri 的 `backgroundThrottling` 在 macOS 上只对 14.0 及以上生效。本次改动同时做了两件事：macOS 默认改为"关窗后继续后台运行"；原生 30 秒定时器注册成功后，渲染层取消了自己的 JS 兜底定时器。在 11–13 上，隐藏的 WKWebView 可能被系统挂起，原生事件是否仍能驱动定时任务执行，没有验证过。
- **现有文档：**README 的 macOS 一节只写了 "On macOS 14+, the hidden main window limits background processing while continuing to handle schedule checks"，没有说明更早的版本。
- **需要决定：**把最低系统版本提到 14.0，或者在 macOS 13 上实测隐藏窗口超过 5 分钟后的定时执行，并把结果写进 README。

### D-3：未提交改动过大，且直接在 `main` 上

- **现状：**44 个已修改文件（+931 / −394）加 16 个新文件，混了四个主题：
  - macOS 外壳（`macos.rs`、`tauri.macos.conf.json`、`window-chrome.ts`、`StandaloneWindow.tsx`、`DesktopWindowActions.tsx`、系统终端启动方式）；
  - 延长释放（`ExtendReleaseDialog.tsx`、`use-extend-release.tsx`、提醒提示条上的一步延长）；
  - 创建流程与费用提示（`form-submit-keys.ts`、`schedule-cost.ts`、按钮上的单价、计划摘要）；
  - 工具链（Node 25 的 Vitest 参数、ESLint 忽略项、CI 的 macOS bundle 冒烟测试）。
- **建议：**按主题拆成几个提交，P1-1 的修复跟随"创建流程"那一个。

## 5. 中低优先级问题

### P2-1：凭据存储会静默降级为明文文件

- **位置：**[src/lib/secure-storage.ts](src/lib/secure-storage.ts#L44)、[src/lib/password-crypto.ts](src/lib/password-crypto.ts#L23)。
- **原因：**钥匙串写入失败或校验不一致时，`createLayeredSecureStorage` 把值写到普通的运行时存储，也就是应用数据目录下的按 key 文件。受影响的是登录令牌和保存的账号记录。账号记录里"记住密码"的密文用固定的应用内字符串派生密钥，只能算混淆，能读到该文件的人可以还原密码。
- **触发场景：**macOS 的 ad-hoc 签名每次更新都会让钥匙串重新弹出授权（README 已说明）；用户点拒绝后就走到降级路径。Linux 没有 Secret Service 时同理。
- **现状：**设置页和登录页都没有提示当前凭据存在哪里。
- **建议：**
  - 在设置页显示当前凭据存储位置（系统钥匙串 / 本地文件）；
  - 处于降级状态时，"记住密码"默认不保存，或在勾选时给出明确提示。

### P2-2：大文件下载整个进渲染进程内存

- **位置：**[src/lib/runtime.ts](src/lib/runtime.ts#L395)、[src/lib/download.ts](src/lib/download.ts#L44)、[src-tauri/src/lib.rs](src-tauri/src/lib.rs#L1322)。
- **原因：**下载先把所有数据块收进一个 Blob，再 `arrayBuffer()` 复制一份，然后经 IPC 交给 `writeFile`。文件在内存里至少存在两份。
- **影响：**几 GB 的镜像下载有内存压力，渲染进程可能被系统终止。
- **现状：**Rust 侧已有流式写盘的 `http_download_to_file`，但不能携带鉴权头，对应的 [downloadUrlToLocalPath](src/lib/download.ts#L97) 没有任何调用方。10-25 的审阅已经提过这个长期方向。
- **建议：**让 `http_download_to_file` 支持鉴权头和空闲超时，镜像与存储下载改走这条路径。

### P2-3：CLI/MCP 上传整文件读入内存，且对本地路径没有限制

- **位置：**[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L665)。
- **原因：**`uploadLocalFile` 在 `maybeMutate` 之前就 `readFile(localPath)`，所以 dry-run 也会把整个文件读进内存。MCP 的上传工具对 `localPath` 没有任何约束，而下载有 `getDownloadRoot()` 的根目录、符号链接和真实路径三重校验，两边不对称。
- **影响：**大文件上传占用等量内存；被误导的代理带上 `confirm: true` 可以把用户可读的任意本地文件（SSH 私钥、`~/.easy-console/config.json`）上传到该账号的远程存储。
- **建议：**
  - dry-run 只 `stat` 文件，返回大小和文件名；
  - MCP 上传增加可配置的本地根目录，或至少拒绝已知的敏感路径；
  - 上传改为流式分片读取。

### P3-1：页面崩溃后关闭按钮可能没有反应

- **位置：**[src/App.tsx](src/App.tsx#L122)、[src-tauri/src/lib.rs](src-tauri/src/lib.rs#L1838)。
- **原因：**开启关闭确认时，原生侧阻止关闭并发出 `desktop-close-requested`，由渲染层的 `DesktopWindowActions` 弹出对话框。该组件挂在 `ErrorBoundary` 内部；路由树抛错进入兜底界面后它被卸载，事件无人处理。
- **影响：**Windows/Linux 默认开启关闭确认，此时点关闭按钮没有任何反应，只能从托盘退出。
- **说明：**本次把这个组件从 `AppShell` 上移到 `AppRoot`，已经修掉了"登录页上无法响应关闭请求"的旧问题，是改进。
- **建议：**把 `<DesktopWindowActions />` 放到 `ErrorBoundary` 之外（仍在 `ToastProvider` 和路由内）。

### P3-2：网关 5xx 被当成确定失败

- **位置：**[src/lib/batch-runner.ts](src/lib/batch-runner.ts#L98)、[src/lib/schedule-execution.ts](src/lib/schedule-execution.ts#L416)。
- **原因：**只有 `kind === "network"` 的错误归为"结果未知"。HTTP 502/504 是 `kind === "http"`，归为确定失败。
- **影响：**网关返回 504 时后端可能已经创建了实例。批量结果里的"重试失败项"或定时任务的手动重跑有重复创建计费实例的可能。客户端默认 20 秒超时通常先于网关超时触发并归为"未知"，所以概率低。
- **建议：**对创建类请求，把 502/503/504 也归为"结果未知"。

### P3-3：延长释放写入的是绝对时间

- **位置：**[src/lib/task-release-notifications.ts](src/lib/task-release-notifications.ts#L43)、[src/components/TaskNotificationWatcher.tsx](src/components/TaskNotificationWatcher.tsx#L95)。
- **原因：**新释放时间由缓存的任务快照计算（`max(现在, 原释放时间) + N 小时`），然后整体写回。提示条上的"延长 1 小时"闭包里的快照最多旧 15 秒，列表里的快照取决于轮询间隔。
- **影响：**如果别处（另一台设备、CLI）刚把释放时间延长了更多，这里的写入会把它改短。
- **附带假设：**`releace_time` 按客户端本地时区解析和格式化。客户端与服务器不在同一时区时，倒计时和到期提醒会偏移相应的小时数。原版控制台是同样的做法。
- **建议：**提交前先取一次最新的任务详情再计算；时区假设值得在真实环境确认一次。

## 6. 零碎

- [package.json](package.json#L62) 的 `react` 下限是 `^19.0.0`，但 [DesktopWindowActions.tsx](src/components/DesktopWindowActions.tsx#L23) 用了 19.2 才有的 `useEffectEvent`。锁文件装的是 19.2.6，当前没有运行时问题，建议把下限提到 `^19.2.0`。
- [src/lib/download.ts](src/lib/download.ts#L78) 有残留的 `void exists;`。
- 根目录有 22 个 md 文件，其中多份是带日期的审阅、验收和发布演练记录，可以收进 `docs/`。本文件按现有惯例仍放在根目录。
- 体量偏大的文件：`TasksPage.tsx`（2834 行）、`SettingsPage.tsx`（2491 行）、`src-tauri/src/lib.rs`（2371 行）、`ssh/session.rs`（2172 行）。不影响正确性，但后续改动的审阅成本会持续上升。

## 7. 建议的处理顺序

1. 修 P1-1（下拉框 Enter）和 P1-2（Vitest 排除项），两处改动都很小。
2. 决定 D-1（launchd 提交的去留）。
3. 按 D-3 拆分并提交当前改动。
4. 决定 D-2（最低系统版本或补测）。
5. P2-1 至 P2-3 排进后续迭代；P3 和零碎项随手处理。

## 8. 整改跟进（2026-11-12）

### P1 状态

- **P1-1：已修复。** `guardImplicitSubmit` 现在也会取消 `<select>` 上 Enter 的默认行为；表单测试加入下拉框断言。改动见 `a88f0b2`。
- **P1-2：已修复。** Vitest 使用 `configDefaults.exclude` 并排除 `.claude/**`。`npm run test` 现报告 124 个文件、921 项通过，改动见 `fb2a624`。

### D1-D3 决定

- **D-1：保留 macOS launchd 唤醒提交 `4f9a115`，验收通过后再合入。** 该提交继续留在独立 worktree；合入前需通过 macOS CI、打包应用启停 LaunchAgent 验收和显式的 `macos_launch_agent_roundtrip` 测试。它不唤醒睡眠中的 Mac，也不代替应用执行远程操作。
- **D-2：保留 macOS 最低系统版本 11.0。** 不因尚未复现的风险提高到 14.0。README 已说明 macOS 11–13 的隐藏窗口调度尚未验证，时效性计划应保持主窗口可见，直到补完验收。
- **D-3：按主题拆分提交。** 当前改动已转到 `codex/review-followups-2026-11-12`，创建与计费提示、释放时间扩展、macOS 外壳、测试与打包工具链分别提交；设计说明和本报告另作文档提交。

### 验证边界

- `npm run typecheck`、`npm run typecheck:tools`、`npm run lint`（0 errors、37 warnings）和 `npm run test`（124 个文件、921 项）通过。
- 本机没有 `cargo` 或 `rustc`，`npm run build:desktop` 在 sidecar 构建阶段因 `spawnSync rustc ENOENT` 失败；打包应用和 LaunchAgent 验收尚未执行，因此 D-1 仍未达到合入条件。
