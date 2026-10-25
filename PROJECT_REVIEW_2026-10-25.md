# EasyConsole 项目审阅（2026-10-25）

> 审阅日期：2026-10-25  
> 审阅范围：当前工作区（含未提交改动）中的 Tauri 桌面端、React 渲染层、共享 API 与运行时适配、CLI/MCP、自动化测试、CI 与打包  
> 审阅性质：静态代码审阅、定向故障复现、现有自动化检查；本次没有修改产品源码  
> 相关历史文档：[AUDIT.md](AUDIT.md)（2026-08-13）、[PROJECT_REVIEW_2026-10-24.md](PROJECT_REVIEW_2026-10-24.md)

## 1. 结论摘要

项目底子很好。前两轮审阅中的大部分 P0/P1 已经修复：刷新 401 死锁、按账号隔离缓存、定时任务记录归属账号和 `needs_review` 状态、MCP 下载路径 junction 绕过、keyring 平台后端、跨窗口 CAS、SSH config 标记块、端口转发只绑回环、release 串行、dependabot、Rust fmt/clippy 门禁等。

本轮重点放在两部分：一是尚未提交的新代码（批量执行、变更清单、执行台账、账号分域、资源预设、跨窗口存储），二是前两轮没有覆盖到的路径。新发现 4 个 P1：

1. 下载超过 20 秒就会被中止（已复现）。
2. 刷新令牌期间切换账号，会把账号写回旧的那个。
3. 批量创建的"重试失败项"可能重复创建计费实例。
4. 本地存储读写在主线程上全量重写整个文件，还有丢数据的窗口。

## 2. 已验证结果与范围限制

### 通过的检查

| 命令/检查 | 结果 |
|---|---|
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run typecheck:tools` | 通过 |
| `npm.cmd run lint` | 0 errors、39 warnings，与 ratchet 持平 |
| `npm.cmd run test` | 98 个测试文件、651 项测试全部通过 |
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| `cargo test --lib` | 33 项测试全部通过 |
| 下载超时复现 | 本地慢速响应体服务器：响应头 131ms 返回，响应体读取在 1s 计时器到期时抛出 `AbortError` |

### 未覆盖的事项

- 没有运行 `build:desktop` 和 SSH 集成测试（`--features ssh-test-internals`）。
- 没有使用真实账号对真实 API、真实 SSH 服务做端到端验证。
- 没有对界面做实测或可访问性扫描。
- 桌面端下载超时的结论基于代码路径：Tauri 走的是与 Web 相同的 `fetchRequest` 逻辑，复现用的是 Node 原生 fetch。

## 3. 新发现的问题

### P1：优先处理

#### P1-1：下载超过 20 秒就会被中止（已复现）

- **位置：**[src/lib/runtime.ts](src/lib/runtime.ts#L394)、[tools/easy-console/node-runtime.ts](tools/easy-console/node-runtime.ts#L53)。
- **原因：**默认 20 秒超时用的是同一个计时器，`clearTimeout` 在响应体读完后才执行，所以读取响应体的时间也算在里面。镜像下载 [api-factory.ts](src/lib/api-factory.ts#L245)、存储下载 `transmit`（[#L276](src/lib/api-factory.ts#L276)）和任务下载（[#L223](src/lib/api-factory.ts#L223)）都没有覆盖 `timeoutMs`，因此大文件或慢网络下必然失败。
- **影响：**桌面端、Web 端和 CLI/MCP 的镜像、存储文件、任务文件下载。
- **建议：**
  - 下载改用空闲超时：每收到一个数据块就重置计时，不再用总时长超时；
  - 长期看，让 `http_download_to_file` 支持带鉴权头，实现 Rust 侧流式写盘，渲染层不再持有整个 Blob；
  - 补"慢速响应体超过超时仍能完成"的回归测试。

#### P1-2：刷新令牌期间切换账号，会把账号写回旧的那个

- **位置：**[src/lib/auth-context.tsx](src/lib/auth-context.tsx#L470)（第 470–483 行）。
- **过程：**账号 A 的请求触发刷新；刷新进行中用户切换到账号 B（`loginSaved` 已写入 B 的 token 并把缓存分域切到 B）；刷新随后返回，A 的新 token 和 A 的 user 被无条件写回。此时缓存分域和定时任务归属校验仍认为当前是 B，B 的定时任务可能用 A 的身份提交，查询结果也会写进 B 的缓存。
- **概率与后果：**需要在刷新的几百毫秒窗口内切换账号，概率低；但后果是跨账号提交和数据串号。
- **建议：**
  - 应用新 token 前先确认 `apiClient.getToken() === currentToken`，或引入会话代数计数，切换账号时让在途刷新作废；
  - 刷新成功后把新 token 写回对应的 savedAccounts 记录。目前没有写回，之后一键登录用的还是旧 token。

#### P1-3：批量创建的"重试失败项"可能重复创建计费实例

- **位置：**[src/components/batch/use-batch-operation.ts](src/components/batch/use-batch-operation.ts)；调用方 [CreateTaskDialog.tsx](src/components/tasks/CreateTaskDialog.tsx#L637)（重试入口 [#L1181](src/components/tasks/CreateTaskDialog.tsx#L1181)）、[TaskTemplatesPage.tsx](src/pages/TaskTemplatesPage.tsx#L1207)。
- **原因：**`runBatch` 把网络错误和超时当成确定失败，结果对话框可以直接"重试失败项"。请求可能已经到达服务端并创建了实例。这和上一轮在定时任务里修掉的 P1-5 是同一类问题。
- **需要核实：**重试沿用相同的 payload 和任务名。如果后端强制任务名唯一，重试会被拒绝，风险就小很多。
- **建议：**
  - `isNetworkError` 的失败归为"结果未知"（与 `schedule-execution` 的 `unknown` 一致），在结果对话框里与确定失败分开展示；
  - 对"结果未知"项，先刷新任务列表或用 `checkTaskName` 核对，再允许重试；
  - 补"创建请求超时后重试不重复创建"的测试。

#### P1-4：本地存储在主线程上全量重写，还有丢数据的窗口

- **主线程阻塞：**`runtime_storage_get/set/remove/compare_and_swap` 和 `keychain_*` 都是同步 command（[src-tauri/src/lib.rs](src-tauri/src/lib.rs#L493)，第 493–615 行）。Tauri 会在主线程上执行非 async 的 command，每次读写都要解析并重写整个 `runtime-storage.json`（pretty-print 的 JSON 套 JSON 字符串）。
- **写入放大：**上传每传完一个 5MB 分片就写一次断点记录（[StoragePage.tsx](src/pages/StoragePage.tsx#L237)），10GB 文件大约要整文件重写 2000 次；运行日志、执行台账、变更清单的每次追加也是整文件重写。
- **丢数据窗口：**`write_string_map` 先把原文件改名为 `.bak`，再把临时文件改名为正式文件（[lib.rs](src-tauri/src/lib.rs#L182)），且没有 fsync。如果在两步之间崩溃或断电，下次 `load_string_map` 发现文件不存在会返回空表（[lib.rs](src-tauri/src/lib.rs#L127)），不会读取 `.bak`；再过两次写入，`.bak` 也会被删掉。结果是设置、定时任务、模板、执行台账等全部本地数据丢失。
- **建议：**
  - command 改为 async，或把文件 I/O 放到 `spawn_blocking`；
  - 写入改为"临时文件 + fsync + 直接 rename 覆盖"（Windows 上 `std::fs::rename` 本身就会替换目标），`.bak` 在写入前单独复制；读取时文件缺失或 JSON 损坏就回退到 `.bak`；
  - 中期考虑按 key 拆分文件或改用 SQLite，避免每次都重写全量数据；
  - 上传断点记录节流，比如每 N 片或每 2 秒写一次，结束和失败时再强制写一次。

### P2：纳入近期迭代

#### P2-1：CLI/MCP 和桌面端的数据互不相通

- CLI/MCP 读写 `~/.easy-console/local-data.json`（[local-data-store.ts](tools/easy-console/local-data-store.ts#L10)），桌面端读写应用数据目录下的 `runtime-storage.json`。
- 通过 `easyconsole_schedule_create`（[mcp-tools.ts](tools/easy-console/mcp-tools.ts#L588)）创建的定时任务没有任何程序会自动执行，只能用 `schedule run` 手动触发，但工具说明里没写这一点。AI 会以为任务已经排上了。
- 模板和运行日志同样是分开的两份，这违背了 PRODUCT.md 里"CLI/MCP 是桌面工作流的延伸"的原则。
- **建议：**短期在 CLI/MCP 的工具说明和返回结果里明确"本地定时任务不会自动执行"；长期让 sidecar 与桌面端共享同一份存储（共享文件路径 + 跨进程锁，或由桌面端提供本地 IPC）。

#### P2-2：批量结果对话框可能一直卡在"进行中"

- `start` 和 `retryFailed` 在批量执行结束后直接 `await appendBatchOperation(...)`（[use-batch-operation.ts](src/components/batch/use-batch-operation.ts#L113)、[#L165](src/components/batch/use-batch-operation.ts#L165)）。如果存储写入抛错，后面的 `update({ pending: false })` 不会执行，对话框会一直停在进行中，调用方的 `void startBatch(...)` 还会产生未处理的 rejection。用户可能因此重新提交。
- 重试记录的 `startedAt` 取的是结束时间（[#L159](src/components/batch/use-batch-operation.ts#L159)）。
- **建议：**变更清单写入改为尽力写入，与执行台账 `recordExecutionOutcome` 的做法一致；在重试开始前记录 `startedAt`。

#### P2-3：定时任务没有"错过执行"的处理策略

- [isScheduleDue](src/lib/scheduled-tasks.ts#L194) 不管晚了多久都会执行。应用关了 9 小时，早上 9 点的任务会在下午 6 点打开应用时创建实例。
- 应用没有开机自启，本地定时任务能否执行完全取决于应用是否开着。
- **建议：**增加错过执行策略（跳过 / 补跑一次 / 询问）和可配置的容忍窗口；提供开机自启和托盘常驻选项。

#### P2-4：关键路径测试缺口

- `AuthProvider` 没有任何测试，账号切换、刷新、静默重登这些最敏感的路径都没覆盖。
- `ScheduledTasksPage`（1128 行）、`TaskTemplatesPage`（1224 行）、`BackgroundScheduledTaskRunner` 没有测试。
- 项目没有接入覆盖率工具（如 `@vitest/coverage-v8`），也没有覆盖率阈值。

#### P2-5：实时日志每 6 秒拉一次完整日志

- [TaskLogPanel.tsx](src/components/tasks/TaskLogPanel.tsx#L21) 的 `LIVE_LOG_POLL_MS = 6_000`，而 `task_log` 接口不支持偏移，每次都下载全量日志。日志很大时网络和渲染开销明显。
- **建议：**客户端限制展示尾部若干 KB；已连接 SSH 时可改用 `tail -f`；向后端争取支持偏移参数。

#### P2-6：TasksPage 每 5 秒整页重渲染

- [TasksPage.tsx](src/pages/TasksPage.tsx#L1696) 的计时器每 5 秒更新 `nowMs`，只为刷新一处"x 秒前"文案，却让约 1650 行的页面组件整体重渲染。这是 AUDIT.md 提过的遗留问题，现在仍在。
- **建议：**把相对时间抽成自带计时器的小组件。

### P3 与工程治理

- `recharts` 在 [package.json](package.json#L60) 里声明了，但 `src/`、`tools/` 中一处都没用。要么删掉，要么用来做成本图表。
- 两个 sidecar 合计约 118MB（58MB + 60MB），合并成单个二进制、按子命令分派可以省掉一半。`src-tauri/binaries/` 下还有一个 5 月遗留的旧 `easy-console-x86_64-pc-windows-msvc.exe`。
- SSH 集成测试不清理临时目录：%TEMP% 里残留约 150 个 `ec-sftp-*` / `ec-local-*`，还有固定文件名的私钥（[ssh_integration.rs](src-tauri/tests/ssh_integration.rs#L259)、[#L387](src-tauri/tests/ssh_integration.rs#L387)），并发跑测试时会互相覆盖。建议改用 `tempfile::TempDir`，密钥文件名带随机后缀。
- `resetStaleRunningTasks`（[scheduled-tasks.ts](src/lib/scheduled-tasks.ts#L318)）和 `normalizeSchedule` 写入的 `lastError` 只有英文，没有走 `i18nText`。
- [skills/easy-console-ai/SKILL.md](skills/easy-console-ai/SKILL.md) 列出的 MCP 工具约 15 个，实际有 50 个，定时任务、模板、备份、批量操作相关的都没列。
- 上一轮审阅仍未关闭的项：
  - 安装包没有系统级代码签名（Windows Authenticode、macOS 公证）；
  - GitHub Actions 没有 pin 到提交 SHA，release job 持有 `TAURI_SIGNING_PRIVATE_KEY`，却引用了 `dtolnay/rust-toolchain@stable` 这种分支引用；
  - `.mjs` 构建脚本不在 lint 和类型检查范围内；
  - ESLint 没有启用类型感知规则（如 `no-floating-promises`）；
  - Android 在 PRODUCT.md、README.md、AGENTS.md 里一个字都没提，但有独立 CI、发布流程和 `install_apk` 命令；
  - `.impeccable/` 已写进 .gitignore，但仍有 11 个文件被 git 跟踪；
  - TasksPage（2563 行）和 SettingsPage（2295 行）过大。
- **流程问题：**审阅时 main 分支上有 86 个未提交文件、约 +5.3k 行改动，里面包含好几项 P1 修复。建议按主题拆成几次提交，尽快落盘。

## 4. 可以加入的功能

按投入产出比排序：

1. **闲置 GPU 检测与提醒：**基于 `monitor_index` 或 Grafana 的利用率数据，空闲 N 分钟发通知，可选自动释放。对算力平台来说最直接省钱。
2. **定时释放前提醒和一键延长：**释放条件为"定时释放"的任务，在到期前 10 分钟提醒，用户可以直接延长。
3. **一键打开 Jupyter / TensorBoard：**在现有端口转发规则上做预设，转发建立后自动打开浏览器。
4. **日志关键词告警和外部通知：**日志中出现 OOM、Traceback、NaN 等关键词时告警。任务状态变化可以推送到飞书、企业微信或钉钉的 webhook，人不在电脑前也能收到。
5. **让定时任务可靠运行：**加开机自启、托盘常驻和"错过执行"策略（跳过 / 补跑一次 / 询问），可选接入系统计划任务，作为应用没开时的兜底。
6. **成本看板：**用现成的 `statics_cost` 和按月接口画趋势图和按实验拆分的成本，正好把 recharts 用起来。
7. **SSH 命令片段与多实例广播：**常用命令存成片段，同一条命令可以对选中的多个实例一起执行。
8. **增强 CLI/MCP：**
   - 补 `task get` / `task wait`，等任务进入运行状态后返回 SSH 信息，很适合 Agent 使用；
   - 给创建任务的 payload 写严格的 zod schema，替代 `z.record`；
   - 把模板和资源预设作为 MCP resource 暴露。
9. **按实验 ID 归组：**项目里已经有 `EXPERIMENT_ID` 环境变量，可以按它聚合任务，对比各次运行的配置、时长和成本。
10. **补齐镜像管理：**后端已有删除和更新镜像的接口（`DELETE /image/image`、`PUT /image/image/{id}`），前端还没有封装。

## 5. 建议的顺序

1. **先修 4 个 P1：**下载空闲超时、刷新与账号切换竞态、批量创建结果未知不直接重试、存储命令异步化与原子写入；同时补 `AuthProvider` 测试。
2. **再处理数据互通：**至少先在 CLI/MCP 的工具说明里写清楚本地定时任务不会自动执行，再规划共享存储。
3. **然后做高收益功能：**从闲置 GPU 检测、定时释放前提醒做起。
4. **工程治理持续推进：**提交当前改动、补覆盖率、合并 sidecar、补签名与 SHA pin。
