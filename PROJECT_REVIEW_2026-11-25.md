# EasyConsole 项目审阅（2026-11-25）

> 审阅日期：2026-11-25<br>
> 审阅范围：当前工作区（`codex/review-followups-2026-11-12` @ `6bb4679`，含 29 个已修改、5 个未跟踪文件的未提交改动）中的 Tauri 桌面端、React 渲染层、共享 API 与运行时适配、CLI/MCP、自动化测试与 CI<br>
> 审阅性质：静态代码审阅和现有自动化检查；本次没有修改产品源码<br>
> 相关历史文档：[PROJECT_REVIEW_2026-11-12.md](PROJECT_REVIEW_2026-11-12.md)、[PROJECT_REVIEW_2026-10-25.md](PROJECT_REVIEW_2026-10-25.md)、[SSH_REVIEW_2026-10-27.md](SSH_REVIEW_2026-10-27.md)、[AUDIT.md](AUDIT.md)

## 1. 结论摘要

项目整体质量高，核心路径写得很谨慎。定时创建先落租约再发请求，认领走 CAS 和跨进程锁；主机密钥按 TOFU 校验，终端启动参数没有注入点；CLI/MCP 的每个写操作都有 dry-run 闸门。这些本轮都逐项确认过，见第 8 节。

问题集中在这套核心的边缘，可以归成三类：

- **"结果未知"之后的恢复动作会绕过引擎建立的保护。** 执行到期、重试失败项、恢复计划、批量释放的结果汇总，都可能导致重复创建计费实例，或者把没释放成功的实例报成已释放。
- **MCP 边界对模型传入的值信任过多。** 下载路径有根目录、符号链接和真实路径三重校验，上传路径、ID 和备份文本没有对应的约束。
- **VS Code 集成改写用户文件时把读取失败当成空文件。** 桌面外壳的窗口生命周期只在 macOS 上是对的。

本轮新发现 7 项建议优先修复、15 项中优先级问题。11-12 报告里的 P2、P3 共 6 项都还没处理。当前未提交的改动（操作栏自定义、快捷键、文案与无障碍）本身干净，可以提交。

## 2. 已验证结果与范围限制

### 通过的检查

| 命令/检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run typecheck:tools` | 通过 |
| `npm run lint` | 0 errors、37 warnings，与 ratchet 持平 |
| `npm run test` | 126 个文件、942 项全部通过 |
| `npm run version:check` | 0.4.27，三处一致 |
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets -- -D warnings` | 通过 |

### 审阅方式

- 未提交的 diff、上一轮问题的现状、存储上传、本地备份、CI 与构建配置由主审阅直接阅读。
- 三块上一轮只抽查过的区域各做了一次完整通读：Rust 外壳与 SSH 模块、CLI/MCP 工具链、计费与释放相关的自动化流程。
- 第 3、4 节的每一项都由主审阅对照源码复核过。只来自通读报告、没有复核的项目单独列在第 5 节，并标明"未复核"。
- P1-1、P2-1、P2-2 另有临时 Vitest 用例确认，用例没有入库。

### 未覆盖的事项

- 没有运行 `cargo test --lib`、`build:desktop`、`tauri:build` 和 SSH 集成测试（`--features ssh-test-internals`）。
- 没有使用真实账号对真实 API、真实 SSH 服务做端到端验证。后端在 5xx、过期 `upload_id`、过去的 `releace_time` 上的实际行为都是未知数，相关条目的后果按最坏情况描述。
- Rust 侧只做了静态阅读。涉及 Windows、Linux 的结论依据代码和标准库、Tauri 的文档行为推断，没有在这两个平台上实跑。
- SSH 前端组件（`SshTerminalTab.tsx`、`SftpPanel.tsx`、`AppSshTerminalDialog.tsx`）和大部分页面组件只做了抽查。

## 3. 建议优先修复

### P1-1："执行到期"会用过期快照重复创建实例

- **位置：**[src/lib/schedule-execution.ts](src/lib/schedule-execution.ts#L353)、[src/pages/ScheduledTasksPage.tsx](src/pages/ScheduledTasksPage.tsx#L893)。
- **原因：**非强制认领只检查租约、归属和状态，不检查该行此刻是否仍然到期。循环计划每次执行后回到 `pending` 并带上下一次的 `scheduleTime`；`alreadyCompletedExecution` 的键是 `id@scheduleTime`，时间推进后就对不上了。
- **触发：**用户停在定时任务页跨过 09:00。后台执行器跑完每日计划并把它推进到明天。页面列表只在窗口获得焦点时刷新（[ScheduledTasksPage.tsx](src/pages/ScheduledTasksPage.tsx#L370)），这一行仍显示 09:00 待执行，"执行到期 1"可点。确认后当天再创建一个实例。
- **相关：**
  - 后台执行器在一轮开始时算一次到期列表，再顺序处理（[BackgroundScheduledTaskRunner.tsx](src/components/BackgroundScheduledTaskRunner.tsx#L113)）。期间别处手动执行了列表靠后的某行，执行器随后会再执行一次。
  - 应用没有单实例保护。两个进程同时运行、一轮内有两条以上循环计划到期时，同样可能交叉重复。
- **建议：**
  - 非强制认领在锁内用 `isScheduleDue(latest, now)` 复核，不到期就跳过；
  - 页面在打开执行预览前重新读取列表；
  - 考虑接入 Tauri 的单实例插件。

### P1-2：5xx 被归为"确定失败"，可一键重试出重复实例

- **位置：**[src/lib/api-client.ts](src/lib/api-client.ts#L69)、[src/lib/batch-runner.ts](src/lib/batch-runner.ts#L98)、[src/lib/schedule-execution.ts](src/lib/schedule-execution.ts#L416)、[src/lib/runtime.ts](src/lib/runtime.ts#L490)。
- **原因：**只有 `kind === "network"` 算结果未知。HTTP 502/504 是 `kind === "http"`，响应无法识别是 `kind === "parse"`，两者都落到"失败"，于是批量结果提供"重试失败项"，定时计划可以直接恢复重跑。这是 11-12 的 P3-2，没有处理；本次未提交的 `httpStatusMessage` 注释里写着"5xx 后请求可能已生效"，分类没有跟上。
- **附带问题：**运行时在返回状态码之前就对响应体做 `JSON.parse`。nginx 默认的 HTML 502/404 页面会抛语法错误，被包装成网络错误，用户看到的是 "Unexpected token '<'"。结果是：
  - 新的状态码文案对最常见的网关错误不生效；
  - HTML 的 401 不会被识别为登录过期；
  - 同一个 504，响应体是 HTML 时归为"未知"，是 JSON 或空时归为"失败"，分类取决于响应体格式。
- **单实例创建：**[CreateTaskDialog.tsx](src/components/tasks/CreateTaskDialog.tsx#L586) 的失败分支不区分错误类型。超时也提示"实例创建失败"，创建按钮保持可点。
- **建议：**
  - 创建类请求把 5xx 和 `parse` 也归为结果未知；
  - 非 2xx 响应不解析响应体，或解析失败时保留状态码继续走状态映射；
  - 单实例创建遇到结果未知时，提示先到列表确认，而不是"创建失败"。

### P1-3：批量释放把"结果未知"报成成功

- **位置：**[src/pages/TasksPage.tsx](src/pages/TasksPage.tsx#L1513)。
- **原因：**`handleBatchSettled` 只看 `summary.failed`。`unknown` 不计入失败，走成功分支。
- **触发：**释放 5 个实例并点"后台运行"，其中 2 个请求超时。提示"批量释放完成 · 3 个实例"，结果对话框被清掉，运行日志记为 `success`。
- **影响：**那两个实例可能仍在计费，用户没有任何线索。"最近批量操作"的重试只取 `failed` 项，也捞不到它们。
- **建议：**`unknown > 0` 时按未完成处理：保留结果对话框，提示改为"N 个结果未知，请核对"，运行日志不记成功，并在历史面板里给未知项一个核实入口。

### P1-4：VS Code 集成会清空非 UTF-8 的 `~/.ssh/config`

- **位置：**[src-tauri/src/ssh/vscode.rs](src-tauri/src/ssh/vscode.rs#L495)，同样的写法在 [第 1045 行](src-tauri/src/ssh/vscode.rs#L1045) 和 [第 1122 行](src-tauri/src/ssh/vscode.rs#L1122)。
- **原因：**`fs::read_to_string(&config_path).unwrap_or_default()` 把所有读取错误都当成空文件。文件里只要有一个非 UTF-8 字节，`read_to_string` 就返回 `InvalidData`。
- **触发：**配置里有一行 GBK 编码的中文注释，这在中文 Windows 上很常见。点"在 VS Code 中打开"，整份配置被改写成只剩 EasyConsole 块；撤销授权和旧密钥清理则把它写成空文件。
- **备份救不回来：**写入前会复制一份 `config.easy-console.bak`（[第 432 行](src-tauri/src/ssh/vscode.rs#L432)），但只保留一代，下一次操作无条件覆盖它。第二次操作之后原件就没有了。
- **相关：**[第 458 行](src-tauri/src/ssh/vscode.rs#L458) 的 `rename` 会把符号链接形式的配置（dotfiles 仓库的常见做法）替换成普通文件。
- **建议：**
  - 只有文件不存在才当作空，其他读取错误直接报错并中止；
  - 按字节处理，或在无法解码时拒绝改写；
  - 备份带时间戳，或者已有备份时不覆盖；
  - 写入前解析符号链接，写到链接的目标上。

### P1-5：MCP 边界有三处过度信任输入

三处的前提相同：代理被页面或文档里的内容误导，带着 `confirm: true` 调用工具。

- **上传不限制本地路径。**[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L665) 在闸门之前就读入整个文件，[mcp-tools.ts](tools/easy-console/mcp-tools.ts#L576) 的 `localPath` 是任意字符串。代理可以把 `~/.ssh/id_rsa` 或保存 CLI 令牌的 `config.json` 传到远程存储，再用读文本工具取回内容。dry-run 也会读文件，对 `/dev/zero` 或命名管道会耗尽内存或挂起。这是 11-12 的 P2-3，没有处理。
- **`backup_import` 可以改写桌面端的 API 地址。**[mcp-tools.ts](tools/easy-console/mcp-tools.ts#L809) 拒绝了凭据分区，但 `settings` 分区里的 `apiBaseUrl` 会写进与桌面端共享的存储。桌面端下次启动时先应用这个地址，再装入钥匙串里的令牌（[auth-context.tsx](src/lib/auth-context.tsx#L107)），令牌就发给了那个主机。已保存的账号没有和主机绑定。
- **ID 不编码直接拼进 URL。**[src/lib/api-factory.ts](src/lib/api-factory.ts#L203) 等 8 处用模板字符串拼路径，MCP 的 `idSchema`（[mcp-tools.ts](tools/easy-console/mcp-tools.ts#L82)）接受任意字符串。`taskId: "x/../../image/image/7"` 的预览和日志都写着删除任务，实际请求是删除镜像。
- **建议：**
  - 上传在 dry-run 时只 `stat`，并增加和下载对称的本地根目录限制；
  - MCP 导入排除 `apiBaseUrl` 和监控地址，或要求在桌面端确认；
  - 桌面端发现令牌签发时的主机与当前 API 主机不一致时不发送令牌；
  - 拼路径时统一 `encodeURIComponent`，ID 的 schema 限制为数字或安全字符集。

### P1-6：CLI/MCP 写日志失败会吞掉已成功的操作结果

- **位置：**[tools/easy-console/cli.ts](tools/easy-console/cli.ts#L333)、[tools/easy-console/mcp-tools.ts](tools/easy-console/mcp-tools.ts#L937)、[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L410)。
- **原因：**操作完成后、返回结果前要追加一条运行日志，这一步没有保护。它抛错会进入 `catch`，`catch` 里再写一次日志，再次抛错，结果和原始错误都没有输出。
- **触发：**应用数据目录不可写（沙箱里的 MCP 宿主）、磁盘满、约 37 秒内拿不到存储锁。
- **影响：**实例已经创建，调用方只拿到 `EACCES` 或 `ELOCKED`，没有任务 ID，退出码为 1。代理会重试，产生重复实例。
- **相关：**批量回执把执行器的 `unknown` 压成 `ok: false`。`template apply` 里超时但实际成功的创建显示为失败，`created` 计数偏小，调用方看不出需要先核实。
- **建议：**
  - 这两处日志写入改为尽力而为，`appendBatchItemRunLogs` 已经是这样做的；
  - 回执增加 `status` 字段（`succeeded` / `failed` / `unknown`），保留 `ok` 以兼容 1.x 契约。

### P1-7：Windows/Linux 上"关闭即退出"会留下无窗口进程

- **位置：**[src-tauri/src/lib.rs](src-tauri/src/lib.rs#L1847)。
- **原因：**关闭确认和关闭到托盘都关掉时，只有 macOS 分支调用 `app.exit(0)`。其他平台不拦截关闭，主窗口被销毁；只要还有别的窗口，运行时就不会发出退出请求。
- **触发：**用户在关闭对话框里选了"退出"并勾选记住。之后只要右键过一次托盘（隐藏的 `tray-menu` 窗口从此存在，见 [第 1032 行](src-tauri/src/lib.rs#L1032)），或者开着 SSH 弹出窗口，关主窗口后进程就不退出。
- **影响：**
  - 托盘图标还在，"显示主窗口"找不到 `main`，没有反应；
  - 主窗口名下的 SSH 会话和端口转发不会被清理；
  - 定时任务的心跳事件发给不存在的窗口，计划静默停止。
- **范围：**依据代码和 Tauri 运行时的行为推断，没有在 Windows 上实跑。
- **建议：**非 macOS 平台走同一分支（拦截关闭、标记退出、`app.exit(0)`），并在 Windows 上手动确认一次。

## 4. 中优先级问题

### 计费与释放

- **P2-1：定时释放时间按计划时间算，不按实际运行时间。**
  - 位置：[src/lib/scheduled-release.ts](src/lib/scheduled-release.ts#L6)、[schedule-execution.ts](src/lib/schedule-execution.ts#L378)。
  - 影响：对一个定在下周的计划点"立即执行"，提交的释放时间是下周再加 24 小时，多计费约 8 天。表单写的是"每次运行后 24 小时"，执行预览里也不显示释放时间。迟到 30 小时才补跑的计划会提交一个已经过去的释放时间，后端如何处理未知。
  - 建议：以实际提交时刻为基准；预览里显示本次的释放时间。
- **P2-2："恢复"待确认的计划不改时间槽。**
  - 位置：[src/lib/scheduled-tasks.ts](src/lib/scheduled-tasks.ts#L290)。
  - 影响：`resumeScheduledTask` 把状态改回 `pending`，清掉错误信息和 `executionKey`，`scheduleTime` 不变。09:00 的创建超时后，用户确认实例其实已建好，09:04 点恢复想让每日计划继续，这一行仍在 10 分钟宽限期内，执行器 30 秒内再建一个。在执行记录里标记"已确认创建"只写台账，不推进计划。
  - 建议：恢复循环计划时推进到下一次；恢复前有未解决的结果未知记录时要求确认。
- **P2-3：延长释放仍用缓存快照写绝对时间。**
  - 位置：[src/lib/use-extend-release.tsx](src/lib/use-extend-release.tsx#L33)。
  - 影响：别处刚把释放时间延到明天，这里的旧快照加 1 小时会把它改回今天，实例提前近一天释放。成功提示也不核对后端返回的释放时间。这是 11-12 的 P3-3，没有处理。
  - 建议：提交前先取一次最新的任务详情。
- **P2-4：闲置自动释放的两处薄弱点。**
  - 位置：[src/lib/idle-instance-reminder.ts](src/lib/idle-instance-reminder.ts#L42)、[src/components/IdleInstanceWatcher.tsx](src/components/IdleInstanceWatcher.tsx#L137)。
  - 影响一：`Number(null)` 和 `Number("")` 都是 0。监控断档如果以 null 点返回，会被算作新鲜的闲置证据，连"网络必须恰好为 0"的规则也一并满足。GPU 探测仍需通过，功能默认关闭，所以实际风险在整段时间只用 CPU 的任务上。
  - 影响二：释放成功后的提示和运行日志都以 `isCurrent()` 为条件，而任务快照每 10 秒刷新一次就会让它变假。实例可能已被释放、容器数据已销毁，却既没有提示也没有审计记录。
  - 建议：值为 null 或空串的点直接丢弃；释放成功后的日志无条件写入。
- **P2-5：批量操作和"重试失败项"没有绑定发起账号。**
  - 位置：[src/components/batch/use-batch-operation.ts](src/components/batch/use-batch-operation.ts#L113)。
  - 影响：执行过程用的是全局 API 客户端，没有账号范围检查。开始一个 50 项的模板应用后退出并切到账号 B，剩余项会在 B 名下创建并计费，变更记录把整批都归到 B。定时任务有归属检查，批量没有。
  - 建议：开始时记下账号范围，每项执行前比对，不一致就中止余下的项。
- **P2-6：CLI/MCP 的 `schedule run` 会重放结果未知的计划。**
  - 位置：[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L874)、[schedule-execution.ts](src/lib/schedule-execution.ts#L353)。
  - 影响：这条路径固定传 `force: true`。首次执行超时后计划处于 `needs_review` 且没有远程 ID，再次 `schedule run --yes` 不命中任何跳过分支，直接再建一个。dry-run 预览不显示状态和上次的错误。
  - 建议：`needs_review` 状态下拒绝执行，或要求额外的显式参数。

### 存储与备份

- **P2-7：断点续传记录只按文件名、大小、修改时间建键。**
  - 位置：[src/lib/upload-resume.ts](src/lib/upload-resume.ts#L56)、[src/pages/StoragePage.tsx](src/pages/StoragePage.tsx#L204)。
  - 影响：键里没有目标目录和账号。同一个文件先传 `/a` 中断，再传 `/b` 或换账号上传，会沿用旧的 `upload_id` 并跳过已记录的分片。记录没有过期时间，只在上传成功时清除；`upload_id` 在服务端失效后，这个文件每次重试都会以同样的方式失败。
  - 建议：键里加入账号范围和目标路径；记录设过期时间；续传失败时清掉记录并从头上传。
- **P2-8：加密备份导入不做版本校验。**
  - 位置：[src/pages/SettingsPage.tsx](src/pages/SettingsPage.tsx#L1160)、[src/lib/backup-crypto.ts](src/lib/backup-crypto.ts#L102)。
  - 影响：明文备份经过 `parseLocalDataBackup` 校验 `app`、`version` 和 `items`，加密备份解密后直接使用。未来版本导出的加密备份会被 1.x 原样导入，与 [LOCAL_DATA_FORMATS.md](LOCAL_DATA_FORMATS.md) 的"不静默覆盖未知格式"不符。解密还固定使用代码里的迭代次数，忽略文件里记录的 `kdf.iterations`，以后调高迭代次数会让旧备份无法解密。
  - 建议：解密结果同样走 `parseLocalDataBackup`；派生密钥时读取文件里的 KDF 参数。
- **P2-9：CLI/MCP 导入时，备份里缺失的分区会被写成空数组。**
  - 位置：[src/lib/local-data-backup.ts](src/lib/local-data-backup.ts#L145)、[cli.ts](tools/easy-console/cli.ts#L1028)、[mcp-tools.ts](tools/easy-console/mcp-tools.ts#L820)。
  - 影响：两个入口默认选中全部非凭据分区。导入一份只含语言设置的备份，或者一份没有资源预设的旧备份，会清空与桌面端共享的模板、预设、计划和运行日志。桌面端的导入对话框只列出备份里存在的分区，不受影响。
  - 建议：默认分区取备份里实际存在的那些；预览里列出每个分区会写入的条数。

### CLI/MCP

- **P2-10：CLI/MCP 应用模板不解析变量默认值和必填项。**
  - 位置：[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L738)。
  - 影响：桌面端先调用 `resolveTemplateVariables` 和 `findMissingRequiredVariables`，CLI/MCP 直接传原始的变量值。没有传值时占位符保持字面量，`template apply --yes` 会带着 `${dataset}` 创建计费实例，预览只显示生成的名称。
  - 建议：复用桌面端的两步解析；必填变量缺失时拒绝执行。
- **P2-11：刷新令牌会把新令牌输出到标准输出和 MCP 结果。**
  - 位置：[tools/easy-console/operations.ts](tools/easy-console/operations.ts#L684)。
  - 说明：[CLI_MCP_CONTRACT.md](CLI_MCP_CONTRACT.md) 记录了这个行为，所以这是需要重新决定的设计，不是疏漏。它与同一份代码里"凭据不进入标准输出和模型上下文"的做法相悖：令牌进入对话记录后，任何有 shell 的一方都可以直接调用 API，绕过所有 dry-run 闸门。

### 桌面外壳与 SSH

- **P2-12：SFTP 的"用户选定目录"由渲染层自报。**
  - 位置：[src-tauri/src/ssh/sftp.rs](src-tauri/src/ssh/sftp.rs#L767)、[session.rs](src-tauri/src/ssh/session.rs#L346)。
  - 影响：对话框在 JS 里打开，原生侧只检查路径是绝对路径、不含 `..`、存在且是目录。渲染层可以直接注册 `/` 或 `C:\`，再读写任意本地文件。CSP 是 `script-src 'self'`，前提是渲染层先被攻破，所以这是纵深防御问题，但它弱于 [SSH_DEVELOPMENT.md](SSH_DEVELOPMENT.md) 里的说法。
  - 建议：由原生命令打开对话框并直接登记结果。
- **P2-13：`http_download_to_file` 没有调用方，但仍然暴露。**
  - 位置：[src-tauri/src/lib.rs](src-tauri/src/lib.rs#L1322)。
  - 影响：URL 不校验协议和主机，没有超时、大小上限和取消。目标路径可以是应用数据目录下的任意文件，包括主机密钥信任库和运行时存储。出错时留下 `.part` 文件。
  - 建议：在补上鉴权头并接入调用方之前，先从命令列表里移除；接入时把允许的根目录收窄到下载目录。
- **P2-14：会话断开时不清理下载的 `.part`；`vscode-keys.json` 解析失败会被静默重置。**
  - 位置：[src-tauri/src/ssh/session.rs](src-tauri/src/ssh/session.rs#L1597)、[src-tauri/src/ssh/vscode.rs](src-tauri/src/ssh/vscode.rs#L57)。
  - 影响一：只有主动取消的分支会删除临时文件。关闭终端页或连接掉线时，传输任务被直接中止，按完整大小预分配的 `.part` 留在用户目录里。
  - 影响二：密钥记录文件无法解析时读成空列表，下一次授权或撤销只写回新的一条。哪些主机的 `authorized_keys` 里还留着 EasyConsole 公钥，这份清单就丢了。同目录的 `history.rs` 对同样的情况是返回错误，做法正确。
- **P2-15：Windows 上 SFTP 下载完成后的"打开文件夹"会被拒绝。**
  - 位置：[src-tauri/src/lib.rs](src-tauri/src/lib.rs#L1419)、[第 350 行](src-tauri/src/lib.rs#L350)。
  - 原因：传给 `validate_reveal_target` 的是规范化后的路径（[session.rs](src-tauri/src/ssh/session.rs#L378)）。Windows 上 `canonicalize` 返回 `\\?\C:\...` 形式，`is_unc_path` 把它判成网络共享。
  - 范围：依据标准库的文档行为推断，没有在 Windows 上实跑。

## 5. 低优先级与零碎

### 已复核

- [tools/easy-console/mcp-server.ts](tools/easy-console/mcp-server.ts#L11) 的版本号写死为 `0.2.1`，包版本是 0.4.27，`version:check` 不覆盖这一处。
- [src-tauri/src/scheduled_wake.rs](src-tauri/src/scheduled_wake.rs#L71) 的 Windows 唤醒任务每分钟触发一次，带 `WakeToRun`，每次启动一个 PowerShell 进程，"是否有到期计划"在唤醒之后才判断。机器能否保持睡眠、是否会闪出控制台窗口，需要在 Windows 上确认。
- [src-tauri/src/ssh/session.rs](src-tauri/src/ssh/session.rs#L1378) 的端口转发用 `JoinSet` 收纳每个连接，但全文件没有 `join_next`。长时间使用 SOCKS5 转发时，已结束连接的任务条目一直累积到规则停止。
- [src-tauri/src/ssh/sftp.rs](src-tauri/src/ssh/sftp.rs#L457)：远端大小为 0 或缺失时不发起读取，得到一个空文件并报告"已完成"。`/proc`、`/sys` 下的文件会遇到。
- [src/components/batch/verify-unknown-items.ts](src/components/batch/verify-unknown-items.ts#L28)：自动核实把不带时区的 `create_time` 按客户端本地时间解析，并要求落在批次开始时间的前后 30 分钟内。客户端与服务器时区不同时，刚建好的实例落在窗口外，该项被判成"确认未创建"，变成可重试。
- [src/lib/format.ts](src/lib/format.ts#L17) 的克隆命名给源名称追加 13 个字符的时间戳，创建表单没有名称长度校验。后端如果限制名称长度，克隆一个长名称的实例会在提交时才失败。
- `backup-crypto.ts` 和 `password-crypto.ts` 的 PBKDF2-SHA256 迭代次数是 15 万，低于当前常见建议值。调整前需要先解决 P2-8 里的参数读取问题。
- 上一轮的零碎项都还在：[package.json](package.json#L62) 的 `react` 下限仍是 `^19.0.0`，而 `DesktopWindowActions.tsx` 用了 19.2 才有的 `useEffectEvent`；[src/lib/download.ts](src/lib/download.ts#L78) 的 `void exists;` 没有删；带日期的审阅和验收文档仍堆在根目录；`TasksPage.tsx` 增长到 3131 行。

### 未复核

以下各项来自三份通读报告，主审阅没有逐条对照源码，处理前建议先确认：

- 定时任务的执行台账只在一次运行结束时写入。应用在发出创建请求后崩溃时没有台账记录，15 分钟后计划静默转为待确认。
- 循环计划的 `lastRemoteTaskId` 在推进后仍然保留。它会让一条结果未知的循环计划被当成"已完成"，提示信息里引用的是上一次运行的 ID。
- 任务页会用当前筛选后的这一页覆盖共享的任务快照，通知监听在任务页上停止轮询。任务自动刷新默认关闭，用户停在任务页时不会收到定时释放和失败提醒。
- 运行时存储删除一个值时写入墓碑，旧值留在同名的 `.bak` 里，直到该键下一次写入。凭据降级到本地文件存储的环境下，登出后明文仍在 `.bak` 中。
- Node 侧依赖的 `proper-lockfile` 回收过期锁时不做二次确认，释放锁是无条件的 `rmdir`。Rust 侧两处都有校验。触发条件是持锁进程崩溃且同时有两个等待者，概率很低。
- CLI 的 `task update` 要求提供名称，与契约里"更新不需要名称"不符；MCP 侧用的是单独的 schema，没有这个问题。
- CLI/MCP 的 `storage cat` 和下载都是整份传输完才做字节截断和路径检查。渲染层的 `readTextFile` 是同样的做法。
- SFTP 删除时用的是跟随符号链接的 `stat`，指向目录的链接和悬空链接都删不掉。
- VS Code 集成的另外几处：撤销某一台主机会删除旧版共享密钥，即使没有选择清理远端；公钥先装到主机再写本地配置，配置写入失败会留下一把不在清单里的授权密钥；配置块追加在文件末尾，前面的 `Host *` 会覆盖它，包括固定的 known-hosts 文件。
- 日志轮转策略是全部保留，不清理旧文件。
- 每日和每周计划在夏令时"跳过的那一小时"里触发后，之后的时间会永久偏移一小时。

## 6. 当前未提交改动的评估

改动共 29 个已修改文件（+832 / −272）和 5 个新文件，主体是任务表格的操作栏自定义。

### 结论

实现干净，测试覆盖到位，可以提交。具体确认过的点：

- **操作栏与"更多"菜单互补。**`stripActions` 取代了原来的三个布尔参数。默认配置和窄表格两种情况下，菜单内容与改动前一致。窄表格和手机卡片的"更多"里新增了"监控"，补上了之前窄表格下监控无入口的缺口。
- **折叠逻辑。**默认三个按钮时的折叠点仍是 1100px。按钮数为 0 时，窄区域仍会把用户拉宽过的操作列收回到 124px。
- **列宽的持久化与迁移。**老用户保存过的 232px 和默认三个按钮的宽度相等，升级后表现不变。改按钮数时列宽按差值调整，保留用户自己加的余量。
- **快捷键。**`n` 和 `c` 走了已有的两道保护：`g` 之后 800ms 内的第二个键不算行命令，所以 `g c` 不会触发克隆；有模态层打开时不响应。
- **"更多"菜单不会为空。**最多固定 6 个，而无条件出现的菜单项有 8 个。

### 提醒

- `httpStatusMessage` 对 HTML 错误页不生效，分类也没有跟着改，见 P1-2。这部分建议和 P1-2 一起修完再提交，或者先单独提交并在提交说明里注明范围。
- 克隆命名把实验同步格式里的下划线换成了连字符（`exp-run_2026…` 变成 `exp-run-2026…`），测试里是有意为之。名称长度见第 5 节。
- 仍建议按主题拆分提交：
  - 操作栏自定义、列设置和快捷键；
  - 确认对话框、仪表盘和设置页的文案与无障碍调整；
  - API 错误文案；
  - 克隆命名与验收 mock 的 `use_time` 单位。

## 7. 上一轮（11-12）问题的状态

| 编号 | 问题 | 状态 |
|---|---|---|
| P1-1 | 下拉框 Enter 提交创建表单 | 已修复（`a88f0b2`） |
| P1-2 | Vitest 收集旧 worktree 的测试 | 已修复（`fb2a624`） |
| P2-1 | 凭据静默降级为明文文件，界面无提示 | 未处理，见 [secure-storage.ts](src/lib/secure-storage.ts#L44) |
| P2-2 | 大文件下载整份进内存 | 未处理；本轮补充了 P2-13 |
| P2-3 | CLI/MCP 上传整份读入且不限制路径 | 未处理，升级为本轮 P1-5 |
| P3-1 | 关闭确认组件在 `ErrorBoundary` 内 | 未处理，见 [App.tsx](src/App.tsx#L121) |
| P3-2 | 网关 5xx 被当成确定失败 | 未处理，升级为本轮 P1-2 |
| P3-3 | 延长释放写入绝对时间 | 未处理，见本轮 P2-3 |
| D-1 | launchd 唤醒提交 `4f9a115` | 仍在独立 worktree，未合入 |
| D-2 | macOS 11–13 后台调度未验证 | 状态不变 |
| D-3 | 未提交改动按主题拆分 | 已拆分提交；之后又积累了新的一批，见第 6 节 |

## 8. 确认无问题的部分

本轮专门查过并确认处理正确的地方，后续改动时不必重复怀疑。

**定时创建**

- 认领是原子的：`mutateScheduledTasks` 走存储的 CAS 循环，原生侧在进程互斥锁和跨进程文件锁之下执行。
- 租约在任何网络请求之前落盘。过期租约转为待确认，不会回到待执行。
- 原生心跳注册成功后，JS 兜底定时器会被清除；重入由 `runningRef` 挡住。
- 网络错误和客户端超时进入待确认并记为结果未知。创建成功后本地保存失败不会再次创建。
- 没有任何自动重放：变更请求的重试次数为 0，API 客户端只在 401 刷新令牌后重发一次。
- 归属检查在认领锁内做一次，准备完载荷后再做一次。刷新令牌期间切换账号会丢弃刷新结果。

**闲置自动释放**

- 默认关闭，仅桌面端。
- 必须同时满足：实例运行中、有该任务的应用内 SSH 会话、整个窗口内每次 GPU 采样都不高于 5% 且采样间隔不超过 90 秒、探测到的 GPU 数量等于分配数量、CPU 与网络指标新鲜。
- GPU 探测是严格的：`nvidia-smi` 退出码为 0 且每行都能解析为 0 到 100，否则按错误处理并丢弃证据。
- 每个实例只认领一次。释放失败或结果不确定时不自动重试。

**CLI/MCP**

- 逐项列举了全部写操作，没有任何一个在缺少 `--yes` 或 `confirm: true` 时执行。字符串 `"true"` 会被拒绝。
- MCP 下载路径的限制完整：`..`、根目录之外的绝对路径、任一层的符号链接、最深已存在祖先的真实路径、已存在文件的覆盖，都会被拒绝。
- 明文 HTTP 的放行只来自命令行参数或环境变量；配置文件里的地址走同一检查。
- Node 与 Rust 两套存储实现在文件名、目录布局、锁目录、过期阈值（30 秒）、心跳（10 秒）、JSON 结构、墓碑和备份轮转上一致。

**Rust 外壳与 SSH**

- 系统终端启动没有注入点：主机、用户、端口走白名单并拒绝以 `-` 开头，三个平台都用参数数组和 `--`。全仓库没有 osascript。
- VS Code 配置块里的别名收敛到 `[a-z0-9_-]`，身份文件路径加了引号，`authorized_keys` 的安装和撤销脚本对公钥做了单引号转义。
- 主机密钥：未知或变更的密钥一律提示或拒绝；写入按预期指纹做比较后设置；状态按 `host:port` 建键；提示超时或取消即拒绝；确认绑定到发起的窗口。
- 密码和私钥不进日志，`Debug` 输出做了脱敏，错误字符串里没有密钥材料。
- IPC：非本地来源的调用会被 Tauri 拒绝，每个特权命令都有窗口标签或会话归属检查，`ssh-*` 和 `tray-menu` 的能力集很窄。
- SFTP 本地路径经过规范化并穿透符号链接校验；传输按 64 KiB 流式进行；上传用临时文件加重命名。
- 端口转发只绑定回环地址。没有跨 `.await` 持有标准库互斥锁，没有发现可由远端或渲染层输入触发的 panic。

**工程与发布**

- CI 在 Windows、macOS、Linux 三个平台上运行类型检查、lint、带覆盖率门槛的测试、Rust 检查、SSH 集成测试和 macOS 包冒烟测试，所有 Action 都固定到提交哈希。
- 发布标识（应用 ID、深链协议、更新端点、更新公钥）与 AGENTS.md 一致。CSP 为 `script-src 'self'`。

## 9. 建议的处理顺序

1. **P1-2 和 P1-3**：改动集中在错误分类和结果汇总上，改动量小，覆盖面最大，也顺带解决当前未提交的 `httpStatusMessage` 的不一致。
2. **P1-1**：在认领锁内加到期复核。临时用例已经写过，可以直接转成正式测试。
3. **P1-4**：区分"文件不存在"和其他读取错误，数据丢失风险最直接。
4. **P1-6 和 P1-5**：先把日志写入改成尽力而为并给回执加状态字段，再收紧上传路径、导入范围和 ID 编码。
5. **P1-7**：需要一台 Windows 机器确认后再改。
6. 提交当前的未提交改动（按第 6 节拆分）。
7. P2 按"计费与释放"、"存储与备份"、"CLI/MCP"、"桌面外壳与 SSH"的顺序排进后续迭代。P2-11 需要先决定是否修改契约。
8. 第 5 节"未复核"的各项先确认再定级。
