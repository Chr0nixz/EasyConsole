---
timestamp: 2026-08-13
version: v0.4.17
scope: EasyConsole 全项目多维审阅（渲染层架构与性能、Rust/Tauri 桌面层安全、CLI/MCP 工具链、构建 CI/CD 与供应链）
product_priority: Tauri 桌面端优先，CLI/MCP 为派生工具，Web 为开发与降级运行面，Android 定位待明确
method: 四方向并行源码静态审阅 + 自动化验证（typecheck/lint/test/audit）+ 定向逻辑复现与可达性核对
overall_score: 6.4/10
previous_score: 6.2/10 (2026-07-21)
finding_count: P0 1 / P1 16 / P2 约 45 / P3 约 40
status: 工程基线扎实，但本地状态并发、写盘契约与质量门禁三处系统性缺口未解，不建议在无人看护下执行重要调度
---

# EasyConsole 项目审阅报告（2026-08-13）

## 1. 执行摘要

本轮相对 2026-07-21 那次审计的最大变化不是问题清单，而是**开发投入的方向**。

先说做得好的部分，这些是真实进步，应当保留：`croner` 替换了自写 cron 解析器并补上了 `previewNextRuns` 预览；Node 本地存储引入 `proper-lockfile` 加上临时文件 + fsync + rename；通知轮询加了时间预算、可见性退避与 `AbortSignal`；`secure-storage.ts` 的分层降级实现（keychain 读空回退 fallback、验证写入后才删 fallback、remove 清两边）写得相当扎实；`api-client.ts` 的 token 刷新是单飞的；`src/` 全域 **0 处 `any`、0 处 `@ts-ignore`**；Rust 侧没有一处 shell 字符串拼接执行，外部链接有 scheme 白名单，主机密钥是 TOFU + 用户确认而非无条件接受；CSP 配置正确且无 `dangerousDisableAssetCspModification`；updater 的 draft/prerelease 隔离设计是整套流程里最完善的一环。

但 v0.4.9 至 v0.4.17 共九个版本几乎全部投入"创建实例对话框"的交互微调（自动编号、区块折叠、环境变量、命名规则、时间戳），而 v0.4.7 做完的审计整改在 v0.4.8 被明确回退了一项（明文 HTTP 限制）。同期 lint 警告从 35 条涨到 55 条，且 CI 完全不拦截。

**结论：横向能力在涨，纵向可靠性没跟上，而质量门禁失效使这个背离不可见。**

### 1.1 四维评分

| 维度 | 本轮 | 上轮 | 当前判断 | 最主要限制 |
|---|---:|---:|---|---|
| 用户交互便捷性 | **7.0** | 6.5 | UI 打磨投入密集且有效，无障碍基础在，界面反模式仍然通过 | 切换语言会杀死 SSH 会话；"立即执行"会摧毁周期计划 |
| 功能丰富性和完整性 | **6.5** | 6.0 | cron 已修正，模板/调度/备份/脚本环境变量持续扩展 | 断点续传为假性可用；调度存在两套互不兼容的执行实现 |
| 架构鲁棒性和稳定性 | **6.0** | 6.5 | 适配器边界、类型安全、加密与错误映射方向正确 | 本地状态并发为系统性缺口；43 个 Tauri 命令仅 4 个测试 |
| 程序运行效率 | **6.0** | 5.5 | 轮询退避、列表虚拟化、部分查询取消已落地 | 下载在渲染层复制 3-4 份；进度回调引发全局重渲染风暴 |
| **综合** | **6.4** | 6.2 | **可持续开发，但仍不适合作为无人看护的调度控制面** | **优先修复本地并发、写盘契约与质量门禁** |

加权同上轮口径：交互 25%、功能 25%、架构 30%、效率 20%。

### 1.2 发布判断

- **不建议依赖当前调度执行重要任务**：调度页与后台执行器争抢同一份存储，可重复创建计费实例（P0）。
- **不建议把断点续传作为大文件传输的可靠承诺**：本地 checkpoint 写了但从不读取。
- **不建议让 AI Agent 使用 MCP 的备份导出与下载工具**：前者可无门禁读出 token，后者可写任意本地路径。
- **不建议在配置过 VS Code Remote-SSH 的机器上重复该操作**，直到 `~/.ssh/config` 的标记块处理被修复。
- 在封闭测试环境内，任务浏览、详情、模板、日志、镜像、普通设置和 SSH 入口可继续迭代验证。

## 2. 审阅口径

### 2.1 严重度

| 等级 | 定义 | 处理要求 |
|---|---|---|
| **P0 阻断** | 可能直接造成资金损失、凭据泄漏或不可接受的数据损坏 | 立即修复 |
| **P1 重大** | 核心流程产生错误结果、重复副作用、数据破坏、安全承诺失真或供应链风险 | 当前发布周期处理 |
| **P2 一般** | 有绕过方式，但显著影响效率、可维护性、可访问性或故障定位 | 下一迭代处理并加回归测试 |
| **P3 优化** | 不影响核心正确性，主要影响体积、细节体验或长期成本 | 纳入后续优化 |

### 2.2 证据等级

| 标记 | 含义 |
|---|---|
| **S** | 由当前工作区源码或配置直接确认 |
| **V** | 由 typecheck、lint、test、audit 等命令实际执行验证 |
| **R** | 经二次人工复核代码路径与可达性后确认（含对初判定级的修正） |
| **U** | 受真实账号、服务器、设备或签名环境限制，本轮未下结论 |

### 2.3 范围与限制

审阅覆盖 `src/`、`src-tauri/`、`tools/easy-console/`、`.github/`、构建配置与现有测试。本轮未使用真实账号或生产 token，未修改远端任务、存储或 SSH 主机。所有涉及真实后端行为的判断标记为 U。

**关于可达性的说明**：本轮对若干"任意文件写入"类初判做了二次核对并主动降级。SFTP 的 `localPath` 实际来自原生文件对话框（`src/components/tasks/SftpPanel.tsx:142,164`），`downloadUrlToLocalPath` 在 `src/` 中无任何调用方。这些属于**深度防御缺口**（Tauri 命令对渲染层无差别暴露，渲染层一旦被注入即可绕过对话框），而非可直接利用的漏洞，已按此口径归类。

## 3. 上一轮问题处置复核

| 上轮 ID | 上轮级别 | 当前状态 | 说明 |
|---|---|---|---|
| SEC-01 明文 HTTP | P0 | **主动回退** | v0.4.8 明确放开；`shouldEnforceSecureRemoteTransport()` 硬编码 `return false`。回退决策本身可接受，但文档未同步，见 SEC-02 |
| SCH-01 cron 计算错误 | P1 | **已修复** | 改用 `croner`，补 `previewNextRuns`，有表驱动测试 |
| SCH-02 调度幂等 | P1 | **部分修复** | 已引入 `executionKey`/租约机制，但被 SCH-03 与 SCH-04 绕过 |
| BAK-01 凭据备份数据源 | P1 | **部分修复** | 桌面路径已接入，但门禁与文档失真，见 BAK-02 |
| UPL-01 断点续传偏移 | P1 | **未修复** | `resolveUploadResumeOffset` 逻辑正确但无人调用，见 UPL-03 |
| UPL-02 队列成功误报 | P1 | **已修复** | `finalizeUploadQueueResult` 已以最终快照为准；残留重试子集统计问题见 P2 清单 |
| CLI-01 计划创建绕过确认 | P1 | **已修复** | 走 `maybeMutate`，CLI/MCP 两侧均有测试 |
| STO-01 Tauri 存储双数据源 | P1 | **已修复** | `secure-storage.ts` 分层实现完整且有注释说明不变量 |
| DAT-01 Node 存储无锁 | P1 | **半修复** | 单次 get/set 已加锁并原子写，但锁粒度错层，见 DAT-02 |
| IO-01 大文件整缓冲 | P1 | **Rust 侧已修复，渲染层未修复** | Rust 用 64KB 缓冲与 `bytes_stream()` 流式；渲染层仍复制 3-4 份，见 IO-02 |
| POL-01 通知全量轮询 | P1 | **已修复** | 时间预算 + 可见性退避 + 活动任务过滤 |
| PERF-01 查询取消与 key | P2 | **部分修复** | `query-keys.ts` 仅覆盖 images/tasks；约 10 处 `queryFn` 仍不传 signal |
| ARCH-01 超大模块与测试缺口 | P2 | **恶化** | `TasksPage.tsx` 1969→2221 行，`lib.rs` 2699→2571 行；测试增至 355 项但分布更失衡 |
| PKG-01 双 sidecar | P3 | **未修复** | 实测 55.43 + 56.83 = 112.26 MB，略有增长 |
| UX-01/02/03、A11Y-01、AUTH-01、TERM-01 | P2 | **多数已改善** | 终端已有滚动跟随与录制上限；任务表已有排序与虚拟化 |

**净判断**：上轮 20 项中 7 项已修复、5 项部分修复、1 项主动回退、其余未动。修复集中在**纯逻辑层**（cron、加密、存储原语），跨边界与跨进程的问题基本原样保留——这与上轮 8.3 节"失败路径覆盖落后于功能增长"的预判一致。

## 4. 风险总览

| ID | 级别 | 领域 | 问题 | 证据 |
|---|---|---|---|---|
| SCH-03 | **P0** | 功能 | 调度页盲写覆盖后台执行器租约，重复创建计费实例 | S+R |
| SEC-02 | **P1** | 安全 | 传输安全承诺在代码、README 与 UI 文案三方不一致 | S+R |
| SSH-01 | **P1** | 数据 | `~/.ssh/config` 标记不成对时吞掉用户全部后续配置，且非原子写 | S+R |
| CLI-02 | **P1** | 安全 | `account change-password` 明文密码落盘 run-logs.json | S+R |
| BAK-02 | **P1** | 安全 | 备份导入默认含 secrets（帮助文本相反）；MCP 导出可无门禁泄露 token | S |
| MCP-01 | **P1** | 安全 | 三个 download 工具无 confirm 且本地路径无任何约束 | S |
| TAU-01 | **P1** | 安全 | `validate_local_path` 仅校验存在性，使下载命令成为覆盖原语兼功能 bug | S+R |
| UX-04 | **P1** | 交互 | 切换界面语言会静默杀死所有 SSH 会话 | S+R |
| IO-02 | **P1** | 效率 | 下载在渲染层复制 3-4 份；进度回调按分片触发全局重渲染 | S |
| UPL-03 | **P1** | 功能 | 断点续传 checkpoint 写而不读，失败分支还会抹掉索引 | S |
| SCH-04 | **P1** | 功能 | 页面"立即执行"是第二套实现，绕过租约且摧毁周期性 | S |
| SCH-05 | **P1** | 稳定 | `isScheduleDue` 可抛异常，一次抛出即让整个调度循环停摆 | S |
| DAT-02 | **P1** | 架构 | operations 层读-改-写跨两次锁；run-logs.json 完全无锁无原子写 | S |
| RES-01 | **P1** | 资源 | 端口转发任务在多数退出路径泄漏，端口与 SSH 连接不释放 | S |
| RES-02 | **P1** | 安全 | 主机密钥确认被连接超时嵌套，TOFU 实际不可用且 map 泄漏 | S |
| GATE-01 | **P1** | 工程 | lint 为空门禁；无任何 Rust 质量检查；无覆盖率度量 | V |
| SUP-01 | **P1** | 供应链 | 7 个生产依赖漏洞；Action 未 pin SHA（含分支引用）；无自动更新机制 | V |
| REL-01 | **P1** | 发布 | release 矩阵并发读改写 `latest.json`；桌面包无代码签名/公证 | S |

P2/P3 条目见第 6 节分领域清单。

## 5. 系统性根因

单条修复解决不了问题，以下五点才是真正需要处理的对象。

### 5.1 本地状态已是分布式系统，代码却按单机写

四个审阅方向独立撞到同一堵墙：

| 位置 | 表现 |
|---|---|
| `src/pages/ScheduledTasksPage.tsx:193` | `persist()` 用挂载快照整表盲写 |
| `tools/easy-console/operations.ts` 全部 mutation | load→改→save 跨两次独立加锁 |
| `tools/easy-console/run-log-store.ts:22` | 裸 `writeFile`，解析失败还静默返回 `[]` |
| `src/lib/app-settings.ts:448` | `saveAccountSettings` 绕过 `updateStorageValue` |
| `src-tauri/src/lib.rs:721,2254` | `~/.ssh/config`、`ssh-history.json` 无锁非原子 |
| `tools/easy-console/local-data-store.ts:9` | CLI/MCP 与桌面端根本不是同一个存储文件 |

**关键观察：正确的原语已经写好了**——`mutateScheduledTasks`（`src/lib/scheduled-tasks.ts:85`）、`updateStorageValue`、`write_string_map`、`proper-lockfile` 都在仓库里，只是没有被一致地使用。上轮报告 8.1 节已经准确指出这个根因，一年后仍然存在，说明**仅靠文档描述根因不足以改变实现，必须落成类型层面的强制契约**。

### 5.2 本地文件写盘被当成只读操作

Rust 侧与 CLI 侧独立发现同一类缺陷：`validate_local_path` 唯一的实质检查是 `path.exists()`；MCP 的三个 download 工具把 `outputPath` 当自由字符串。两边都缺"本地写盘目标必须落在受控根目录内"的统一契约。这不是某个模块的疏忽，应作为一个横向改造项处理。

### 5.3 安全承诺与实现三方不一致

问题不在于防护强度，而在于**说的和做的不一样**，这比没有防护更危险，因为它会误导后续决策：代码 `return false`、README 承诺阻止、UI 文案宣称"生产环境禁止"；帮助文本写 `non-secret` 而默认值含 secrets；脱敏正则匹配键名而实际键名恰好不命中。

### 5.4 质量门禁失效，使前三条得以持续恶化

这是元问题。`npm run lint` 实测 55 warning、退出码 0；整条流水线无 clippy/fmt/cargo audit；三个负责打包的 `.mjs` 脚本既无 lint 也无类型检查；无覆盖率度量；无 dependabot。**没有任何机制能让上述劣化在合并前可见。**

### 5.5 长会话资源生命周期没有统一收口

桌面端是长驻应用，但清理逻辑散落：端口转发只在显式 Close 分支 abort；窗口强关无 Rust 侧兜底；pending map 在 future 取消时不清理。反方向也有一例——切换语言反而杀掉了不该关闭的 SSH 会话。

## 6. 分领域发现

### 6.1 P0：SCH-03 调度页盲写覆盖后台执行器租约

**级别：P0｜证据：S + R｜影响：重复创建计费 GPU 实例**

`src/pages/ScheduledTasksPage.tsx:193` 的 `persist()` 调用 `saveScheduledTasks`，后者是 `updateStorageValue(key, () => JSON.stringify(items))`——updater 完全忽略传入的 `raw`，是纯盲写。而后台执行器 `src/components/BackgroundScheduledTaskRunner.tsx:70` 用的是 `mutateScheduledTasks`，做的是正确的读-改-写。两者争抢同一个 storage key。

复现路径：后台执行器将某计划置为 `running`、写入 `executionKey`/`leaseStartedAt`/`lastRemoteTaskId` 并已成功调用 `createTask`；此时用户在页面上做任何操作（暂停、删除其他项、保存表单），`persist()` 就用挂载时的快照把该记录回滚为 `pending` 并清空 `lastRemoteTaskId`。30 秒后 `isScheduleDue` 再次为真，而幂等检查因 `lastRemoteTaskId` 已被抹除而失效，同一计划被重复提交。

页面还在 `:174-182` 只于挂载时加载一次，此后除语言切换外不再同步，快照陈旧窗口很长。

**整改**：`persist()` 改用 `mutateScheduledTasks`，按 `id` 合并用户实际改动的那一条；页面订阅存储变化或在后台执行完成后重新加载；更彻底的做法是把列表纳入 React Query 并由执行器 `invalidateQueries`。

### 6.2 P1：安全与数据完整性

**SEC-02 传输安全承诺三方不一致**（S+R）
`src/lib/transport-security.ts:33` 硬编码 `return false`，函数体内 `void readViteEnv()` 是读取环境变量却不使用的死代码；`README.md:90` 仍承诺"Production desktop builds also block remote cleartext"；`describeTransportViolation()` 准备了一句永不触发的"生产环境禁止使用远程明文 HTTP/WS"。`AGENTS.md:89` 反而是准确的。
**整改**：二选一并保持一致。鉴于实验室后端只有 HTTP，建议保留宽松策略、删除 README 承诺与死代码，改为在设置页对远程明文给出持续可见的状态标识（而非一次性提示）。

**SSH-01 `~/.ssh/config` 标记块吞配置**（S+R）
`src-tauri/src/lib.rs:696-711` 逐行重建时，遇起始标记置 `skipping = true`，仅遇结束标记复位。若结束标记缺失（上次写入被中断、用户手工编辑删除），该标记之后**所有**用户配置被静默丢弃；`:721` 的 `fs::write` 非原子，中途退出会留下半截文件，恰好触发下一次标记不成对，形成级联破坏。此问题不依赖任何攻击者。
**整改**：起始标记无配对结束标记时中止并返回错误；写入改为临时文件 + rename，覆盖前保留 `.bak`。

**CLI-02 改密码明文落盘**（S+R）
`tools/easy-console/cli.ts:267,282` 无差别记录 `command.opts()`；`src/lib/run-logs.ts:60` 的脱敏正则匹配**键名**，而 `--old`/`--new` 的键名是 `old`/`new`，均不命中。补充：走 `--payload-json` 时键名为 `payloadJson`，同样不命中，内含明文密码的完整 JSON 也会原样落盘。`shouldLogCommand` 仅排除 `run-log.*`。目标文件 `~/.easy-console/run-logs.json` 无任何权限收紧。
**整改**：改为按命令声明的字段白名单记录 metadata；同时将 `old`/`new`/`payloadJson` 加入脱敏正则作为纵深防御。

**BAK-02 备份机密段门禁与文档失真**（S）
`tools/easy-console/cli.ts:836` 帮助文本写 `default: all non-secret`，而 `:843` 实际默认值是 `[...nonSecret, ...secret]`，会用备份文件中的 token 与 savedAccounts 覆盖本地凭据——这也是一条凭据注入路径。`easyconsole_backup_export(includeSecrets)` 是纯读操作，完全绕过 mutation 确认体系，可无门禁把 `Bearer` token 送入模型上下文。
**整改**：导入默认改为 `nonSecretBackupSections`，机密段需显式开关 + 二次确认；MCP 侧直接移除 `includeSecrets` 能力；CLI 侧强制 `--output <file>` 并以 0600 写盘，禁止走 stdout。

**MCP-01 download 工具无门禁无路径约束**（S）
`tools/easy-console/mcp-tools.ts:213,336,405` 的 `outputPath` 为自由字符串，经 `operations.ts:81` 的 `writeBlobToFile` 直接 `resolve` → `mkdir` → `writeFile`，无 base 目录、无 `..` 检查、静默覆盖、无 confirm。不传时还会用 `basename` 写入当前工作目录。
**整改**：视本地写盘为 mutation，加 confirm；增加下载根目录约束并校验 `resolve` 后前缀；默认拒绝覆盖。

**TAU-01 `validate_local_path` 仅校验存在性**（S+R）
`src-tauri/src/lib.rs:539-552`。用于 `http_download_to_file`（`:2338`）时，语义恰好变成"只能覆盖已存在的文件"——既是安全缺口，也是功能 bug：正常的下载到新文件必然失败。之所以未被发现，是因为前端 `downloadUrlToLocalPath`（`src/lib/download.ts:108`）目前无任何调用方。
`open_local_path` 在 Windows 上走 `rundll32 url.dll,FileProtocolHandler`（`:556`），等价 ShellExecute，`.exe`/`.bat`/`.lnk` 会被直接执行。此处存在一条**不需要任何注入**的链路：远端存储中的文件名可控，用户下载后在 `AppShell.tsx:370` 点"打开文件"，预期是查看文件，实际是执行程序。
**整改**：拆分为 `validate_open_target`（扩展名白名单 + 拒 UNC）与 `validate_download_target`（校验父目录位于允许的基准目录内）。

**RES-02 主机密钥确认实际不可用**（S）
`src-tauri/src/lib.rs:30` 的确认等待上限为 120 秒，但整个 `client::connect` 被 `connect_timeout`（默认 15 秒，`:1164`）包住。用户来不及确认，外层超时触发、握手 future 被丢弃，前端得到误导性的"连接超时"，且 `pending_host_key_prompts` 中的条目在 future 取消时不会清理，形成随失败次数增长的泄漏。TOFU 机制设计正确但实际不可用。
**整改**：将等待用户确认移出连接超时作用域；给 pending map 加 Drop 守卫。

### 6.3 P1：正确性与稳定性

**UPL-03 断点续传写而不读**（S）
`src/pages/StoragePage.tsx:222` 每片完成后写入 `saveUploadResume`，但 `src/lib/api-factory.ts:353` 续传时只调用服务端 `queryUploadedChunks`，**完全不读本地 checkpoint**；该端点 404/405 时返回 `null`，`startOffset` 保持 0。更糟的是 `StoragePage.tsx:239` 的 catch 分支用 `uploadedChunks: []` 覆盖记录，主动抹掉刚累积的索引。`resolveUploadResumeOffset`（`api-factory.ts:39`）用 Set 找第一个缺口，逻辑对稀疏索引是正确的——问题是没人调用它。
**整改**：`uploadFile` 增加 `resumeFromChunks` 参数，优先用本地 checkpoint，服务端查询作交叉校验；catch 分支保留已有索引。

**SCH-04 页面"立即执行"是第二套实现**（S）
`src/pages/ScheduledTasksPage.tsx:432-486` 手写 `status: running → done`，不使用 `src/lib/schedule-execution.ts` 的租约与幂等机制。后果之一是**周期任务被手动执行一次后永久变为 `done`**（`:449`），不再推进 `scheduleTime`；后果之二是与后台执行器无互斥。
**整改**：抽出共享的 `runScheduledTask(storage, task)`，页面、后台执行器、CLI 三处共用。

**SCH-05 调度循环可被单条脏数据停摆**（S）
`src/lib/scheduled-tasks.ts:139` → `task-recurrence.ts:66` 会抛 `RecurrenceValidationError`，而调用点 `BackgroundScheduledTaskRunner.tsx:79` 与 `ScheduledTasksPage.tsx:583` 均无 try/catch。同时 `normalizeRecurrence`（`scheduled-tasks.ts:23`）**允许**持久化非法组合（weekly 无 weekdays、interval 无 intervalSec、cron 无 cron）。存储中只要有一条这样的记录（旧版本数据、导入备份、手改 JSON），所有定时任务都不再执行，页面则在 render body 中抛出导致整页白屏。
**整改**：`isScheduleDue` 内部捕获异常并返回 `false`；`normalizeRecurrence` 对缺字段项降级为单次并在 UI 标记 `needs_review`。

**DAT-02 跨进程读-改-写仍非原子**（S）
`tools/easy-console/local-data-store.ts:35` 的 `withLock` 只包住单次 get 或单次 set，而 `operations.ts` 的所有本地数据修改都是 `load → 计算 → save` 跨两次加锁。`runScheduledTask`（`operations.ts:462`）尤其危险：单次调用含 4 次独立 save，中间夹着远端建任务的网络往返。`run-log-store.ts:22` 则完全无锁无原子写，而 `parseRunLogs` 解析失败会静默返回 `[]`——一次写入中断即导致全部审计日志无声消失。
**整改**：在 `RuntimeStorage` 上暴露 `withTransaction(fn)`，文件锁包住整段 load→modify→save，强制两个 store 都遵守；补多进程并发压测。

**RES-01 端口转发任务泄漏**（S）
`src-tauri/src/lib.rs:1250` 的 `port_forward_handles.drain() + abort()` 只出现在显式 `Close` 分支，而循环还有远端 EOF、`channel.wait()` 返回 `None`、以及 Write/Resize 失败时 `?` 提前返回三类出口。drop `JoinHandle` 不会取消 tokio 任务，转发任务持有 `Arc<Handle>` 与已绑定的 `TcpListener`，导致本地端口占用、SSH 连接存活、SOCKS5 代理继续对外服务直至进程退出。
另需注意 `:1481` 的 `local_host` 由渲染层任意指定且不强制回环，填 `0.0.0.0` 时同网段任何人可使用这个**无认证** SOCKS5 代理（`:1014` 固定回复 no-auth）。
**整改**：清理逻辑移至循环之后统一执行；Write/Resize 失败改为记录后 `break`；强制绑定回环地址。

**UX-04 切换语言杀死所有 SSH 会话**（S+R）
`src/lib/i18n.tsx:519` 的 `text` 是 `useCallback(..., [locale])`，被列入 `src/components/tasks/SshTerminalTab.tsx:462` 连接副作用的依赖数组。切换语言 → 依赖变化 → cleanup 执行 → `closeSshSession` + `terminal.dispose()`，滚动历史全部丢失。而 `AppSshTerminalDialog.tsx:170` 专门为关闭已连接标签做了二次确认，切一次语言即全部绕过。
**整改**：`text` 移入 ref（同文件 `:132` 已有此模式）。

**IO-02 下载链路内存与重渲染**（S）
`src/lib/runtime.ts:197` 累积 chunk 后 `new Blob(chunks)`，`src/lib/download.ts:37` 又读成 chunks 并 `merged = new Uint8Array(total)` 合并，合计 3-4 份完整副本；下载 2GB 峰值可达 6-8GB。同时 `runtime.ts:208` 在**每个网络分片**（通常 16-64KB）触发 `onProgress`，经 `download-queue-context.tsx:83` 的 `setItems` 更新全局 Context，而 `:215` 的 value memo 依赖 `items`，导致 `AppShell`、`TasksPage`、`StoragePage` 在下载 1GB 期间重渲染上万次。
Rust 侧的流式实现是对的（64KB 缓冲 + `bytes_stream()`），只是渲染层没用。
**整改**：桌面端改走修好后的 `http_download_to_file`；进度回调按 ≥200ms 或 ≥1% 节流；Context 拆分为稳定动作与数据两层。

### 6.4 P1：工程与供应链

**GATE-01 质量门禁失效**（V）
`npm run lint` 实测 `55 problems (0 errors, 55 warnings)`、退出码 0；`ci.yml:72`、`release.yml:84`、`android-ci.yml:100` 均无 `--max-warnings`。`eslint.config.js:20-25` 将 `preserve-caught-error`、`react-hooks/set-state-in-effect`、`react-refresh/only-export-components` 降为 `warn`，在 CI 中等价于关闭。
整条流水线对 `.github/` grep `clippy|fmt --check|cargo audit` **零匹配**；release.yml 连 `cargo check` 都没有。
`eslint.config.js:11` 只覆盖 `**/*.{ts,tsx}`，实测 `eslint --print-config build-sidecars.mjs` 返回 0 条规则；三个 tsconfig 也都不含 `.mjs`。**负责打包 sidecar、构建桌面产物、校验版本一致性的三个关键脚本，既无 lint 也无类型检查**，`build-sidecars.mjs:103` 中已存在一处 TDZ 隐患（`packageExe` 引用了第 115 行才声明的 `platform`）。
无 `@vitest/coverage-v8`，无覆盖率阈值。测试分布严重失衡：**43 个 `#[tauri::command]` 仅 4 个 Rust 测试**，而桌面端是主产品；`TasksPage.tsx`(2221 行)、`TaskTemplatesPage.tsx`(1038 行)、`ScheduledTasksPage.tsx`(886 行)、`SshTerminalTab.tsx`(851 行)、`auth-context.tsx`(432 行) 均无或近乎无覆盖。

**SUP-01 供应链治理缺失**（V）
`npm audit --omit=dev` 实测**生产依赖 7 个漏洞（4 high）**，含 `react-router-dom`（路由匹配 DoS、`<Link>` 开放重定向）；`@modelcontextprotocol/sdk` 带入的 `hono`/`ip-address`/`fast-uri` 随 `easy-console-mcp.exe` 分发。全量 audit 因 npm registry TLS 中断失败（与上轮同一网络问题）。
第三方 Action 全部未 pin SHA，其中 `dtolnay/rust-toolchain@stable` 是**分支引用**（HEAD 可被重写），而 release job 同时持有 `TAURI_SIGNING_PRIVATE_KEY` 与 `contents: write`。
无 `.github/dependabot.yml`、无 `renovate.json`、`package.json` 无 `overrides`/`resolutions`。

**REL-01 发布链路风险**（S）
`release.yml:17-37` 的 4 平台矩阵 `fail-fast: false` 且无 `max-parallel`，每个 job 独立调用 tauri-action 生成 updater feed——即并发读改写同一份 `latest.json`，可能产出**平台条目残缺但看起来正常**的更新源。README 的人工检查点写的是"verify latest.json present"，拦不住这个问题。
`release.yml:89-92` 只有 updater 的 minisign 密钥，**没有任何 OS 代码签名**（无 `APPLE_*`、无 `certificateThumbprint`）。macOS 未公证会被 Gatekeeper 拦截，且未签名的 .app 替换很可能使 macOS 自动更新链路根本不可用。
`release.yml:79-85` 的 Verify 挤在单个多行 `run` 中，Windows pwsh 下能否中断取决于 runner 镜像的 PowerShell 版本（7.4 起才默认开启 `PSNativeCommandUseErrorActionPreference`），而 `ci.yml` 反而已正确拆分为独立 step。

### 6.5 P2 摘要（按领域）

**渲染层**：任务列表页把分页数据写进全量快照 query key（`use-task-list-controller.ts:67`），污染通知 diff 与重名检测；`saveAccountSettings` 不走存储锁；SSH 标签页在 setState updater 内调用另一个 setState 且依赖导致标签自动跳回；重试上传会用失败子集替换整个队列导致计数错误；远程文本预览先下载完整文件再切片；`TasksPage` 每 5 秒整页重渲染只为刷新一个"x 秒前"文案；queryKey 约定仅覆盖两个域；模板页用 `useMutation` 拉镜像绕过缓存；`ssh.defaultPassword` 明文存入普通存储而非 secureStorage；i18n 缺口集中在 lib 层（`describeRecurrence` 全中文、`toLocaleString("zh-CN")` 硬编码、`remote-storage.ts:52` 用 `i18nText` 结果作对象 key）。

**桌面层**：SSH 会话在弹出窗口被系统强关时不断开；SFTP 传输在会话主循环内串行执行，阻塞终端且不可取消；Windows 上外部程序按 PATH 解析存在二进制劫持面；`wt --title` 与 PowerShell 回退把未校验的 `task_name` 交给会二次解析命令行的程序；`validate_host` 允许 `-` 开头；会话事件用 `app.emit` 全局广播，所有窗口可读任意会话终端输出；明文密码在 `PendingSshWindows` 中无限期驻留；VS Code 私钥以空口令落盘且 Windows 未显式设 ACL；`write_string_map` 的 rename 顺序存在崩溃窗口且缺 fsync；`runtime-storage.json` 在 Unix 上未收紧权限；`http:default` capability 为全网通配；`tray-menu` 窗口不在任何能力清单中。

**CLI/MCP**：Node 运行时对所有请求硬编码 20 秒超时，大文件下载必然中断；`account refresh-token` 是真实 mutation 但无确认门禁；`--json` 模式对 commander 用法错误无效；run log 写入失败会把已成功的操作报告为失败（Agent 可能因此重试破坏性操作）；MCP payload schema 为 `z.record` 过于宽松，模型只能靠试错而试错代价是创建计费实例；远端存储路径无 `..` 归一化且允许对根路径执行删除；CLI/MCP 创建的计划任务桌面端根本不读，实际永远不会执行；`task_list`/`run_log_export` 无输出体积上限；`--password` 明文参数进入 shell history。

**构建**：`recharts` 被 catch-all 规则并入会被 modulepreload 的 eager chunk（391.6KB，登录页也要下载）；`vendor-tools` 规则从未命中且会掩盖 Node 依赖误入渲染层的错误；`bundle.targets: "all"` 使 MSI 成为既无签名又不接更新的旁路分发物；`~/.pkg-cache` 未缓存导致每次 CI 每平台重复下载约 50MB；所有 workflow 缺 `concurrency` 分组；Android release APK 在 keystore secret 缺失时仍会以未签名状态上传到 Release；`.impeccable/` 与 `.trae/` 已写入 .gitignore 却仍被 track（11 个文件）；`version-check.mjs` 的 Cargo 正则不锚定 `[package]` 段。

### 6.6 P3 摘要

三个 tsconfig 均未开启 `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`noUnusedLocals`（对本项目大量使用 `UnknownRecord` 的场景，第一项价值最高）；无共享 base tsconfig；`tsconfig.tools.json` 给 Node 目标引入 DOM lib；生产 program 混入 vitest 类型；ESLint 未启用 `recommendedTypeChecked`，导致 `no-floating-promises` 这类规则对一个重度 async 项目完全缺席；MSRV 声明无验证且无 `rust-toolchain.toml`；Cargo 与 bundle 元数据（license/publisher/copyright）为空；MCP server 版本号硬编码 `0.2.1` 与项目版本脱节；`describeRecurrence` 在渲染期 mutate 传入对象；interval 周期存在累积漂移；`statusSnapshotRef` 的 Map 随任务删除无界增长；`window.location.reload()` 被用作错误恢复手段；两个 `.bat` 本地脚本的 JDK 版本（21）与 CI（17）漂移。

**核实无问题的项**（避免误报）：无 sourcemap 泄漏；打包脚本不会夹带 `.env` 或密钥；MCP stdout 无污染（构建产物中 `process.stdout.write` 出现 0 次）；MCP 错误返回结构化；CLI/MCP 环境变量与配置文件优先级正确；远端 mutation 门禁无遗漏；operations 层复用充分；MD5 实现对大文件正确；token 刷新单飞；xterm 输出有界；运行日志脱敏对设置页 metadata 有效；仓库无构建产物、无密钥被提交（324 个 track 文件，`.git` 13MB）；`.gitattributes` 配置合理；updater 的 draft/prerelease 隔离设计正确。

## 7. 验证结果

| 命令/检查 | 结果 | 说明 |
|---|---|---|
| `npm.cmd run typecheck` | 通过 | Renderer TypeScript |
| `npm.cmd run typecheck:tools` | 通过 | CLI/MCP TypeScript |
| `npm.cmd run test` | 通过 | 66 个测试文件，355 项测试（上轮 53/267） |
| `npm.cmd run lint` | **通过但劣化** | 0 errors，**55 warnings**（上轮 35），退出码 0 |
| `npm.cmd audit --omit=dev` | **不通过** | 7 个生产依赖漏洞（4 high） |
| `npm.cmd audit`（全量） | 未完成 | npm registry TLS 连接中断，与上轮同一问题 |
| Rust 测试数量 | **失衡** | 43 个 `#[tauri::command]` 对 4 个 `#[test]` |
| sidecar 体积 | 未改善 | 55.43 + 56.83 = 112.26 MB |
| `.mjs` 构建脚本静态检查 | **不通过** | eslint 规则数 0，且不在任何 tsconfig 范围内 |

## 8. 整改路线图

### Phase 0：立即止血（约 1-2 天，改动小且互相独立）

1. **SCH-03**：`persist()` 改用 `mutateScheduledTasks` 按 id 合并。
2. **GATE-01 首步**：`"lint": "eslint . --max-warnings=0"`；若 55 条不能一次清完，先设 `--max-warnings=55` 做棘轮，只允许下降。
3. **CLI-02**：run log 改字段白名单，并扩充脱敏正则。
4. **BAK-02**：导入默认改回非机密段；MCP 移除 `includeSecrets`。
5. **SSH-01**：标记不成对时中止；写入改原子 + `.bak`。
6. **UX-04**：`text` 移入 ref。
7. **SEC-02**：README、UI 文案与代码三方对齐，删除死代码。

**阶段出口**：不再存在会花钱、破坏用户主机配置或泄露明文凭据的路径；lint 基线不可再上涨。

### Phase 1：契约级改造（1-2 个迭代）

1. **DAT-02 + 5.1 根因**：在 `RuntimeStorage` 上落地 `withTransaction(fn)`，强制 `operations.ts`、`run-log-store`、`app-settings`、Rust 侧 known-hosts/ssh-history 全部改用；补多进程并发压测。
2. **5.2 根因**：拆分 `validate_open_target` / `validate_download_target`，MCP download 工具加下载根目录约束与 confirm，两侧共用同一语义。
3. **IO-02**：修好并启用 `http_download_to_file`；进度回调节流；Context 拆分。
4. **UPL-03**：续传优先读本地 checkpoint，catch 分支保留索引。
5. **SCH-04 / SCH-05**：抽出共享 `runScheduledTask`；`isScheduleDue` 内部容错；`normalizeRecurrence` 拒绝非法组合。
6. **RES-01 / RES-02**：清理逻辑收口到单一退出路径；确认等待移出连接超时；强制回环绑定。
7. **SUP-01 / REL-01 首步**：`npm audit fix` + dependabot（覆盖 npm/cargo/github-actions）；release 矩阵 `max-parallel: 1`；Verify 拆独立 step。

**阶段出口**：任意故障注入点重启后同一 execution key 最多产生一个远端任务；多进程并发不丢数据；本地写盘目标受控；更新源平台条目完整。

### Phase 2：工程治理（持续）

1. **测试重心转移**：从纯函数正常路径转向 Tauri 命令层、context 层与故障注入（网络成功后本地写失败、IPC 恢复、多进程并发、上传硬退出）；接入 `@vitest/coverage-v8` 并对 `src/lib/**`、`tools/**` 设阈值。
2. **补 Rust 门禁**：clippy `-D warnings`、`fmt --check`、定时 `cargo audit`。
3. **`.mjs` 纳入检查**：补 eslint flat config 分支，或改写为 `.ts` 纳入 `tsconfig.tools.json`。
4. **PKG-01**：合并两个 sidecar 为单二进制按子命令分派，安装包直接瘦约 56 MB。
5. **代码签名与公证**：若面向外部分发，此项应提升至 Phase 0。
6. **Action pin 到 commit SHA**，配合 dependabot 维护。
7. **拆分超大模块**：`TasksPage.tsx:283-856` 的菜单整块外移；`lib.rs` 按 storage/ssh/sftp/external 分模块但保持 command 接口稳定。
8. **明确 Android 定位**：目前它有专门 CI、签名流程、capability 与多次白屏修复，但 `PRODUCT.md` 与 `README` 只字未提，等于一条无文档、无验收标准、无测试的第四产品线。要么正式纳入，要么明确标注实验性。

### 明确不建议现在做

- 继续给创建实例对话框增加交互选项（已连续九个版本）。
- 收窄 `http:default` 的通配 scope——运行时可改 base URL 的设计使其难以收窄，属知情接受型风险，记录即可。
- 迁移 SQLite——先让 `withTransaction` 契约落地并验证是否足够。

## 9. 复审验收标准

- P0 清零；Phase 0 全部七项有代码修复与回归测试。
- 本地数据的所有 mutation 走统一事务契约，多进程并发压测无覆盖、无截断。
- 所有本地写盘目标经基准目录校验；打开本地文件的命令拒绝可执行扩展名与 UNC。
- 调度只有一套执行实现；任意故障注入点重启后不重复创建远端任务。
- 断点续传在硬退出后可恢复，稀疏分片不错位。
- `lint` 退出码可拦截 warning；clippy、fmt、cargo audit 进入 CI；核心模块有覆盖率阈值。
- 生产依赖漏洞清零或有明确的 overrides 与豁免记录；Action 全部 pin 到 SHA。
- `latest.json` 在 4 平台条目齐全后才允许 publish，且有自动断言而非人工目测。
- 文档承诺与代码行为一致：README、AGENTS、UI 文案对传输安全与备份语义的描述可被代码验证。

## 10. 结论

EasyConsole 的架构方向、类型纪律、加密实现与桌面能力边界都值得肯定，本轮也确认上一周期在纯逻辑层做出了真实修复。制约它从"可操作"走向"结果可信"的，不是缺少功能，而是三条系统性缺口：**本地状态按单机代码书写、本地写盘缺少统一契约、质量门禁无法让劣化可见**。

这三条互相强化——门禁失效使前两条得以在九个版本的功能迭代中悄悄累积，而每次迭代又新增了依赖这些薄弱基础的功能。因此建议下一阶段**暂停横向功能扩张**，先完成 Phase 0 的止血与 Phase 1 的契约改造。这两个阶段的工作量并不大（Phase 0 约 1-2 天），但它们决定了后续每一个新功能是建立在可信基础上还是继续放大既有风险。
