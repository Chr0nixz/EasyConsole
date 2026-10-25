# EasyConsole 项目审阅与后续开发计划

> 审阅日期：2026-10-24  
> 审阅范围：当前工作区中的 Tauri 桌面端、React 渲染层、共享 API 与运行时适配、CLI/MCP、自动化测试和界面  
> 审阅性质：静态代码审阅、定向故障复现、现有自动化检查；本次没有修改产品源码  
> 相关历史文档：[AUDIT.md](AUDIT.md)（2026-08-13）

## 1. 结论摘要

EasyConsole 的产品方向与架构边界比较清楚：Tauri 桌面端是主产品，浏览器用于开发和降级运行，CLI/MCP 复用共享 API 封装；运行时能力也集中在适配层，避免页面代码直接依赖平台 API。现有测试覆盖面较广，项目已经形成了任务、存储、模板、定时任务、SSH、运行日志和中英文界面等实用能力。

本轮最需要关注的是状态与身份边界。审阅发现账号切换时旧查询数据可能短暂暴露、计划任务没有记录创建账号、远程创建与本地落盘失败之间存在重复提交风险；另外，密钥库平台后端需要核实，MCP 下载路径检查可被 Windows junction 绕过，刷新令牌接口返回 401 时请求会挂起。它们会影响凭据安全、跨账号数据隔离和带副作用操作的可信度。

建议优先修复以下 7 项 P1：密钥库后端、刷新失败死锁、账号缓存隔离、定时任务账号归属、定时任务重放保护、MCP 下载路径约束、默认远程 HTTP。其余改进按 P2 和后续路线图推进。

## 2. 审阅评分

| 维度 | 评分 | 判断 |
|---|---:|---|
| 架构与运行时边界 | 4/5 | Tauri、浏览器和 Node 的能力边界清楚，共享 API 复用良好 |
| 功能覆盖 | 4/5 | 桌面控制、CLI/MCP、计划任务、存储和 SSH 功能完整度较高 |
| 安全与数据隔离 | 2/5 | 多个身份、凭据和本地文件边界需要加强 |
| 可靠性与可恢复性 | 2/5 | 自动任务的重试与不确定结果处理、跨窗口存储仍有风险 |
| 测试与工程治理 | 4/5 | 自动化覆盖较广；真实后端验证、依赖审计和 SSH CI 仍有缺口 |
| 界面与可用性 | 3/5 | 桌面布局和操作密度符合定位；路由 blocker 冲突需修复 |

界面另按可访问性、性能、主题、响应式和实现完整性进行启发式评估，得分为 14/20（良好）。这不是完整的 WCAG 合规审计。

## 3. 主要发现

### P1：优先处理

#### P1-1：Keyring 没有启用明确的平台凭据库后端

[src-tauri/Cargo.toml](src-tauri/Cargo.toml#L45) 声明了 keyring 3，但没有显式启用 Windows、Apple 或 Linux 平台后端 feature。当前依赖树也没有显示平台凭据库实现。Keyring v3 在没有适用平台 feature 时可能退回 mock store，因此“凭据已写入操作系统密钥库”的产品预期需要实证确认。

**建议：**按目标平台显式启用并锁定后端 feature；增加桌面打包后的写入、重启读取、删除和升级迁移测试；检查旧明文 fallback 的清理和迁移结果。

#### P1-2：刷新接口返回 401 会使请求永久等待

[src/lib/api-client.ts](src/lib/api-client.ts#L145) 会把 401 请求加入刷新队列，而刷新回调又使用同一个 ApiClient 调用刷新接口。如果刷新接口本身返回 401，它也会进入等待队列，无法完成刷新。定向本地模拟中，请求持续处于 pending 状态。

**建议：**刷新请求绕过自动刷新拦截，或使用不参与刷新队列的独立传输；覆盖刷新成功、刷新 401、并发 401、刷新网络错误和队列释放测试。

#### P1-3：账号切换时旧账号查询缓存会短暂显示

[src/lib/query-keys.ts](src/lib/query-keys.ts#L3) 和 [src/lib/task-snapshot-query.ts](src/lib/task-snapshot-query.ts#L20) 的查询键没有包含账号身份；[src/lib/auth-context.tsx](src/lib/auth-context.tsx#L408) 的退出流程也没有取消或清除旧查询。本机双账号界面验证中，登录账号 B 后，刷新期间仍显示账号 A 的任务。

**建议：**在查询键中加入稳定的账号标识；切换账号时取消旧请求并清除旧账号缓存；避免旧请求在切换后回填数据。账号标识不应包含 token 或其他秘密。

#### P1-4：本地定时任务未绑定创建账号

定时任务使用全局存储键：[src/lib/scheduled-tasks.ts](src/lib/scheduled-tasks.ts#L5)。后台执行器使用当前 singleton API 创建远程任务：[src/components/BackgroundScheduledTaskRunner.tsx](src/components/BackgroundScheduledTaskRunner.tsx#L81)。账号 A 创建的计划如果在账号 B 登录时到期，可能会在 B 的身份下提交。

**建议：**任务记录保存创建账号标识和必要的 API 环境信息；执行前校验当前身份，不匹配时暂停并提示用户选择原账号或明确迁移任务。

#### P1-5：远端创建成功、本地保存失败后，重试会重复创建

[src/lib/schedule-execution.ts](src/lib/schedule-execution.ts#L172) 把本地持久化失败也当成远程创建失败处理，失败记录可能丢失远程 task ID。故障注入复现显示：远端创建成功后令本地写入失败，再次运行会创建第二个远程实例。手动“立即执行”路径还使用 force 模式：[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L548)。

**建议：**区分远端失败、本地提交失败和结果未知三种状态；结果未知时进入 needs_review，保留远程响应中可取得的 ID，并禁止自动盲目重放；如果 API 支持则传幂等键。为各失败边界增加故障注入测试。

#### P1-6：MCP 下载路径可被 junction 或符号链接绕过

[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L109) 只做词法路径前缀检查，随后直接创建目录和写文件（122–134 行）。本机 Windows junction 测试成功把文件写到下载根目录之外。

**建议：**拒绝路径上的 symlink、junction 和 reparse point；通过规范化后的真实路径或安全句柄限制写入根目录；默认拒绝覆盖已有文件，并为本地文件写入增加明确的 MCP 确认语义。

#### P1-7：默认远程 API 使用明文 HTTP

默认 API 地址位于 [src/lib/api-client.ts](src/lib/api-client.ts#L5)。当前登录使用 SHA-256 密码摘要，后续 bearer token 也通过 HTTP 传输；捕获的摘要或 token 可能被重放或冒用。项目已说明实验室服务使用 HTTP，设置页也有警告，因此这是已知部署取舍，但不适合成为面向更多环境的默认安全姿态。

**建议：**发布配置优先使用 HTTPS 或本机安全隧道；保留实验室 HTTP 时要求明确启用，并在界面持续显示连接安全状态。文档、设置页和运行时行为保持一致。

### P2：纳入近期迭代

#### P2-1：任务页同时注册多个 React Router blocker

[src/pages/TasksPage.tsx](src/pages/TasksPage.tsx#L2248) 同时挂载创建和编辑两个表单，两者都经 [src/components/tasks/CreateTaskDialog.tsx](src/components/tasks/CreateTaskDialog.tsx#L308) 调用 [src/lib/use-unsaved-changes.ts](src/lib/use-unsaved-changes.ts#L25) 注册 blocker。浏览器控制台出现 “A router only supports one blocker at a time”，未保存更改保护可能不完整。

**建议：**页面只注册一个 blocker 并汇总 dirty state，或只挂载当前活跃的表单。

#### P2-2：Tauri 多窗口的存储缓存不会感知其他窗口更新

[src/lib/runtime.ts](src/lib/runtime.ts#L85) 的 tauriStorageCache 会持续返回本窗口的缓存。本机模拟两个 webview 存储后端时，窗口 B 写入后窗口 A 仍读到旧值；数组数据的读改写可能覆盖另一窗口更新。

**建议：**增加跨窗口变更通知和缓存失效；对关键数据提供版本校验或原生端事务式读改写；补双窗口并发测试。

#### P2-3：CI 没有运行 SSH 集成测试

SSH 集成测试需要显式启用 ssh-test-internals feature（[src-tauri/Cargo.toml](src-tauri/Cargo.toml#L60)），但 [CI 工作流](.github/workflows/ci.yml#L91) 没有执行该测试。本机测试最终通过，不过 SFTP 上传下载 round-trip 首次超时、重试后通过。

**建议：**将 SSH 集成测试加入 CI 的适当阶段，调查超时波动，并让失败日志区分连接、传输和资源清理问题。

#### P2-4：有 3 处颜色值未纳入设计 token

检测器在 [src/components/tasks/SshTerminalTab.tsx](src/components/tasks/SshTerminalTab.tsx#L75) 和 [src/lib/app-settings.ts](src/lib/app-settings.ts#L95) 附近报告了未登记颜色值。终端颜色可能是刻意设计的主题值。

**建议：**确认这些值的用途，补充设计 token 或改用已有 token；同时检查键盘焦点、窄窗口布局和错误状态的可见性。

## 4. 已验证结果与范围限制

### 通过的检查

- version:check
- typecheck、typecheck:tools
- lint：0 errors、46 warnings，刚好达到仓库 warning ratchet
- npm test：82 个测试文件、490 项测试通过
- build:desktop
- Rust cargo check、cargo fmt --check、cargo clippy -D warnings
- cargo test --lib：30 项测试通过
- SSH 集成测试启用对应 feature 后最终通过；SFTP round-trip 首次超时，重试通过

### 未能确认的事项

- npm audit 未能提供依赖漏洞结论：Registry 返回 400，提示 package tree 无效；当前 npm ls --depth=0 也报告若干 extraneous 包。应在干净 npm ci 环境重跑审计，不能据此宣称依赖无漏洞。
- 本轮未使用真实账号或生产 token，未对真实 API、真实 SSH 服务执行端到端验证。
- 界面检查集中在桌面尺寸和本机模拟账号，没有完成移动设备布局与完整 WCAG 自动扫描。
- 此次只做审阅，没有手工修改产品源码。

## 5. 后续开发计划

### 阶段一：身份与副作用安全（建议作为下一个发布周期）

1. 确认并启用各目标平台的 keyring 后端，验证密钥持久化及迁移。
2. 修复刷新接口 401 死锁，补并发刷新与失败路径测试。
3. 按账号隔离 React Query 缓存，切换身份时取消旧请求并清理旧数据。
4. 为计划任务记录 owner account，切换账号后校验执行身份。
5. 给定时任务执行增加 needs_review 状态、远程任务 ID 保存和幂等保护。
6. 修复 MCP 下载路径的 junction/symlink 绕过，并确认覆盖行为。
7. 统一默认 HTTP 策略、设置页提示和发布文档。

**阶段验收：**刷新失败不会挂起请求；账号切换不显示或回填旧账号数据；计划任务不会在错误账号下执行；远程创建结果不确定时不会自动重复提交；MCP 写入不能逃出授权目录。

### 阶段二：多窗口一致性和桌面可靠性

1. 为 Tauri 多窗口提供存储变更广播或版本一致性机制。
2. 将路由离开保护收敛为页面级单一 blocker。
3. 将 SSH 集成测试加入 CI，并减少 SFTP 测试的超时波动。
4. 为跨窗口存储、账号切换、计划任务故障恢复增加端到端或集成测试。
5. 处理颜色 token advisory，并对核心页面补键盘导航、焦点顺序和窄窗口复查。

**阶段验收：**双窗口并发更新无静默覆盖；计划任务状态在重启和窗口切换后可解释；SSH 与表单保护行为有稳定自动化覆盖。

### 阶段三：工程质量与发布治理

1. 在干净安装环境运行 npm ci 和依赖审计，区分可修复漏洞、上游阻塞与风险豁免。
2. 按仓库要求保持 lint warning 数量不增长，并逐步降低 warning ratchet。
3. 将 SSH 集成检查纳入 CI；对关键安全和调度路径建立稳定的回归套件。
4. 为高风险操作增加故障注入测试，包括网络成功后本地写失败、进程中断、重复触发和缓存过期。
5. 为当前审计问题建立可追踪的 issue 或里程碑，并在关闭时记录验证证据。

**阶段验收：**依赖审计可重复、CI 覆盖核心状态边界、每个 P1 都有明确负责人和回归测试。

## 6. 有价值的功能建议

以下功能适合建立在身份隔离、幂等和存储一致性修复之后。按预期收益排序：

### 6.1 计划任务执行台账与异常核对

为每次运行记录执行 ID、触发来源、创建账号、开始/结束时间、远程 task ID、结果和重试状态；提供“结果未知，待核对”列表及手动关联远程任务的入口。用户可以判断某次提交是否已经在服务器生效，也能在重启后继续处理，而不是依靠再次执行来试探。

### 6.2 任务成本预估与预算保护

基于现有价格和资源信息，在创建及批量执行前展示预计资源、运行时长区间和成本；允许设置单任务确认阈值、每日预算提醒和高成本操作二次确认。预算应是本地保护提示，若后端不支持强制限额，不应暗示它能阻止服务端计费。

### 6.3 批量操作预览与变更清单

批量创建、停止、删除或模板应用前，先显示影响对象、账号、资源规格和不可逆操作；提交后提供逐项结果、失败项重试和导出。这样既降低误操作，也便于 CLI/MCP 使用者在确认前审查最终 payload。

### 6.4 账号与运行环境工作区

将账号、API 环境、监控地址和相关本地任务归属集中呈现；切换账号时明确显示当前工作区，并提示哪些本地计划任务属于其他账号。此功能应与查询缓存隔离和计划任务 owner 校验一起设计。

### 6.5 本地诊断包

提供一键导出脱敏诊断包，包含应用版本、运行时类型、最近错误、关键配置状态、sidecar 版本和用户主动选择的日志。导出前预览内容并脱敏 token、密码、主机名和本地路径，方便排障而不要求用户手工拼接日志。

### 6.6 存储传输任务中心

统一显示上传与下载队列、速率、剩余时间、失败原因和可恢复状态；支持暂停/继续、失败重试与校验结果。先保证断点信息持久化与服务端状态校验正确，再提供“断点续传”产品承诺。

### 6.7 MCP 安全预览和操作记录

对高影响 MCP 操作提供结构化 dry-run 结果、影响摘要、确认参数和执行回执；把下载、本地文件写入、凭据备份等本地副作用明确纳入权限与审计模型。让 Agent 能在执行前解释“将对哪个账号、哪个任务、哪个路径做什么”。

## 7. 推荐的优先级

1. **先修复 P1：**凭据后端、刷新死锁、账号隔离、计划任务账号归属与重放安全、MCP 路径约束、HTTP 安全策略。
2. **随后完成桌面可靠性：**多窗口存储一致性、单一路由 blocker、SSH 集成测试稳定化。
3. **再增加高收益功能：**执行台账、成本预估、批量预览和诊断包。
4. **最后扩展传输与自动化能力：**在可靠性验收完成后增强存储队列和 MCP 工作流。

建议以“正确身份、明确副作用、失败可恢复”为下一阶段的产品主线。它们会直接提高已有功能的可信度，也会为后续自动化和 Agent 集成打好基础。

## 8. 整改记录（2026-10-24）

> 记录时间：2026-10-24。以下为评审发布后同日完成的整改；验证基线：`typecheck`、`typecheck:tools`、`lint`（39 warnings，ratchet 持平）、`npm test`（88 个测试文件 / 566 项测试）全部通过。

### P1 项

- **P1-1（keyring 平台后端）：已修复。** `src-tauri/Cargo.toml` 显式启用 `windows-native` / `apple-native` / `sync-secret-service` / `crypto-rust` feature，不再依赖 mock 回退。
- **P1-2（刷新 401 死锁）：已修复。** `src/lib/api-client.ts` 刷新路径不再进入自身刷新队列；`api-client.test.ts` 覆盖 `refreshes and retries POST after 401`、`emits unauthorized when refresh fails after POST 401` 等失败路径。
- **P1-3（账号切换缓存泄漏）：已修复。** `src/lib/account-scope.ts` 提供 `accountScopeKey` / `applyAccountQueryScope`（切换时取消在途查询并清空缓存），查询键按账号分域；证据：`account-scope.test.ts`、`query-keys.test.ts`。
- **P1-4（定时任务归属）：已修复。** `src/lib/scheduled-tasks.ts` 记录 `owner`，`scheduledTaskOwnerMismatch` 校验执行身份，不匹配走 `holdScheduledTaskForReview`；证据：`scheduled-tasks.test.ts`（`scheduled task owner` 用例组）。
- **P1-5（重放保护）：已修复。** `src/lib/schedule-execution.ts` 区分远端失败 / 本地落盘失败 / 结果未知，结果不确定进入 `needs_review` 并禁止自动重放；`src/lib/execution-ledger.ts` 台账保留远程任务 ID 供人工核对。证据：`schedule-execution.test.ts`、`execution-ledger.test.ts`。
- **P1-6（MCP 下载路径绕过）：已修复。** `tools/easy-console/operations.ts` 拒绝 symlink / junction / reparse point 逃逸下载根目录；证据：`tools/easy-console/download-path.test.ts`。
- **P1-7（默认明文 HTTP）：文档已对齐，默认策略待产品决策。** `AGENTS.md` Environment 一节已写明打包桌面端当前允许实验室明文 HTTP、CLI/MCP 默认拒绝并需显式 opt-in、对外环境应使用 HTTPS 或本地安全隧道；`src/lib/transport-security.ts` 提供统一分类与设置页告警。默认 API 地址是否切换为 HTTPS 属于产品决策，本轮未改动。

### P2 项

- **P2-1（多 blocker 冲突）：已修复。** `src/pages/TasksPage.tsx` 只挂载当前活跃的创建/编辑表单，`CreateTaskDialog` 打开期间仅注册一个路由 blocker。
- **P2-2（多窗口存储一致性）：本轮实现。** `src/lib/runtime.ts` 的 `createCachedWindowStorage` 以原生命令为后端：他窗口写入触发的广播事件失效本窗口缓存（epoch 计数防止迟到的读响应回填旧值）；跨窗口读改写经 `src-tauri` 的 `runtime_storage_compare_and_swap`（全局锁下的 CAS）+ JS 侧重试循环完成，`RuntimeStorage.update` / `updateStorageValue` 优先走该原子路径。证据：`runtime-storage-cache.test.ts`（双窗口并发读改写不丢更新）、`src-tauri/src/lib.rs` 的 `apply_storage_cas` 单元测试。
- **P2-3（CI 缺 SSH 集成测试）：已修复。** `.github/workflows/ci.yml` 已加入 `cargo test --test ssh_integration --features ssh-test-internals` 阶段。
- **P2-4（未登记颜色值）：已修复。** 终端色板收敛到 `src/lib/ssh-terminal-colors.ts` 统一登记管理，`SshTerminalTab.tsx` 与 `app-settings.ts` 引用该模块。

### 功能建议落地

- **6.1（执行台账与异常核对）：本轮实现。** 数据层 `src/lib/execution-ledger.ts`（记录触发来源、账号、远程任务 ID、结果与人工核对结论）；UI `src/components/scheduled/ExecutionLedgerPanel.tsx` 在定时任务页新增"执行台账"视图：待核对区聚合 `local-persist-failed` / `unknown` 未核对条目，支持"确认已创建（可填远程任务 ID 备注）/ 确认未创建"两个走确认对话框的操作；证据：`ExecutionLedgerPanel.test.tsx`。
- **6.4（账号工作区呈现）：本轮实现。** `src/components/scheduled/WorkspaceAccountBanner.tsx` 在定时任务页顶部展示当前工作区账号，当存在归属其他账号或来源未知（legacy）且仍会自动执行的定时任务时计数提示并支持跳转定位到对应行（恢复/迁移仍走任务行既有"恢复"按钮）；证据：`WorkspaceAccountBanner.test.tsx`。
- **6.3（批量操作预览与变更清单）：本轮实现。** 提交前 `src/components/batch/BatchPreviewDialog.tsx` 展示账号、逐项名称/摘要与不可逆徽章（文字+颜色，删除为 danger tone 且逐项 irreversible），已接入任务页批量删除/释放、`CreateTaskDialog` 批量创建（count≥2，单发路径不变）与模板页执行（原 payload 预览列表替换为该对话框）；执行统一走共享 `runBatch`（`continueOnError` 默认，失败不中断）与 `src/components/batch/use-batch-operation.ts` 编排（实时进度、每次完成落一条 `change-list` 记录、失败子集经 `retryFailedBatchItems` 原地重试并以 `retryOf` 关联），`runSequentiallyWithDelay` 调用全部移除并删除 `src/lib/batch.ts`；提交后 `BatchResultDialog` 提供逐项状态徽章、汇总、失败项重试与 JSON/CSV/Markdown 导出（error 经 run-logs 脱敏）；任务页新增可折叠 `BatchHistoryPanel`（动作/结果筛选、逐项展开看失败原因、重试提示——实际重试仍从原操作入口发起，不做跨会话自动重放）。证据：`BatchPreviewDialog.test.tsx`、`batch-export.test.ts`、`BatchResultDialog.test.tsx`、`use-batch-operation.test.tsx`、`BatchHistoryPanel.test.tsx`（本项验证基线：`typecheck`、`typecheck:tools`、`lint`（39 warnings，ratchet 持平）、`npm test`（97 个测试文件 / 647 项测试）全部通过）。

### 依赖审计（2026-10-24）

- 干净重建：`npm ci` 因运行中的 Vite dev server 锁定 `lightningcss-win32-x64-msvc` 原生模块无法完成（EPERM）；改用 `npm install`（补齐缺失包）+ `npm prune`（清除 extraneous）修复依赖树，`npm ls --depth=0` 已无 extraneous / missing / invalid。
- 审计结果（修复前）：`npm audit` 报 22 项（3 low / 6 moderate / 11 high / 2 critical），`npm audit --omit=dev` 报 8 项（3 moderate / 4 high / 1 critical）。全部 22 项 npm 均标注为 semver 范围内可修复（无需 `--force`、无大版本升级、无"无修复方案"项）。
- 修复方式：`npm audit fix` 在本机连续失败（`/audits/quick` 返回 400、arborist `Cannot read properties of null (reading 'edgesOut')` 崩溃），故按同等语义改用 `npm update <pkg>`（仅范围内提升、不改 manifest，jsdom→canvas 可选 peer 触发 npm 10 arborist 崩溃的两包改用 `npx npm@11` 执行）逐批应用：`zod`、`@modelcontextprotocol/sdk`、`undici`、`qs`、`body-parser`、`proxy-addr`、`ip-address`、`fast-uri`、`tar`、`nanoid`、`postcss`、`browserslist`、`baseline-browser-mapping`、`@babel/core`、`brace-expansion`、`source-map-js`、`hono`、`vitest`/`@vitest/mocker`、`esbuild`、`@yao-pkg/pkg`。
- 修复后：`npm audit --omit=dev` **0 vulnerabilities**；验收阶段补跑 `npx npm@11 update vite`（npm 10 的 arborist 对本树仍崩溃，同上文改用 npm@11）后，`npm audit` 与 `npm audit --omit=dev` 均为 **0 vulnerabilities**。
- 遗留说明：`package.json` 中 `zod` 范围随修复升至 `^4.6.6`（语义兼容）；registry `/audits/quick` 端点处于退役过渡期（返回 400 / "endpoint is being retired" 提示），后续审计结论以 `npm audit` 实际输出为准，不得沿用本节结论。
