# CLI / MCP 的 1.x 契约候选

审阅日期：2026-10-29。基于当前 0.4.27 发布准备分支，逐项核对 `cli.ts` 的 55 个叶子命令、`createMcpToolDefinitions()` 的 54 个工具、共享 operations 和 MCP resources。0.9.0 冻结时再次核对本表；真实后端验收、安装路径验收与签名验证仍按发布清单执行。

## 稳定性与入口

- **stable**：1.x 保留命令/工具名称、参数名称、必填关系和本文明确的客户端返回字段；可增加可选参数及返回字段。后端原始字段、数量单位和服务端权限不由客户端保证。
- **experimental**：`task update` / `easyconsole_task_update`、`image update` / `easyconsole_image_update`、`image delete` / `easyconsole_image_delete`。真实服务尚未完成验收，行为和参数可能调整，调整须写迁移说明。闲置自动释放、Windows 计划唤起也属于实验性桌面功能。
- 所有已公布的工具名和可执行入口在 1.x 保留。改名或删除先保留旧名适配并标记 deprecated，到 2.0 才移除；实验性标记不授权静默执行变更。
- **Sidecar 决策：保留两个可执行文件** `easy-console-cli[.exe]` 与 `easy-console-mcp[.exe]`。CLI 与 stdio 服务的启动方式分开，保持既有 MCP 配置可用；当前接受两个 Node 可执行文件的体积。将来即使复用内部打包，旧入口仍须保留。
- CLI 帮助中的程序名为 `easy-console`；源码使用 `npm.cmd run ec --`，安装包使用 `easy-console-cli`。MCP 安装包入口是 `easy-console-mcp`，无需附加 `mcp` 子命令，不要求另装 Node。

安装包中 sidecar 不带构建时的 target-triple 后缀。常见布局如下，**默认目录与实际安装结果仍需演练/安装验收核对**，用户自选安装目录以实物为准：

| 包格式 | MCP 入口布局 |
| --- | --- |
| Windows NSIS / MSI | 与 `EasyConsole.exe` 同目录的 `easy-console-mcp.exe`；默认目录随安装范围变化 |
| macOS app | `EasyConsole.app/Contents/MacOS/easy-console-mcp`，例如 `/Applications/EasyConsole.app/Contents/MacOS/easy-console-mcp` |
| Linux deb / rpm | 系统可执行文件目录中的 `easy-console-mcp`；演练时核对包清单，安装后用 `command -v easy-console-mcp` 确认 |
| Linux AppImage | AppImage 内的可执行目录；临时挂载路径不能写入长期 MCP 配置。可将同版本 sidecar artifact 解压到固定目录后配置 |
| 独立 sidecar artifact | 解压目录内的 `easy-console-mcp[.exe]`；保持版本和架构与桌面一致 |

构建依据是本仓库 `bundle.externalBin`、`build-sidecars.mjs` 与 [Tauri sidecar 约定](https://v2.tauri.app/develop/sidecar/)。本表不把构建输入路径 `src-tauri/binaries/` 当成安装路径。

## 确认、输出与错误

- 请求的远程变更、本地记录变更、文件写入和凭据写入：CLI 默认 dry-run，执行需 `--yes`；MCP 需布尔 `confirm: true`。包含 CLI 登录、令牌刷新、下载、备份写文件；`"true"` 字符串不是 MCP 确认。
- 读取时的数据迁移、锁文件和审计日志属于运行时维护，不表示执行了预览中的业务变更。dry-run 可以读取影响列表或本地文件以验证输入；不能创建/释放实例、写目标文件或替换凭据。
- CLI 成功的 `--json` 输出为 stdout 一行 `{ "ok": true, "data": ..., "error": null }`；操作/用法错误为 stderr 一行 `{ "ok": false, "data": null, "error": { "message": ..., "code"?: ..., "status"?: ..., "kind"?: ... } }`。正常/预览退出码为 0，错误为非零（当前为 1）。`--help` 属于文本帮助，退出码 0，即使同时传了 `--json` 也不作为业务 JSON。
- `task wait` 的 `outcome: "failed" | "timeout"` 和批量操作中的失败项仍是成功读取到的业务结果，退出码可为 0。调用者必须检查 outcome 或逐项 results，不能只看顶层 ok。
- MCP 成功及工具处理器错误使用上述 JSON envelope，放在 `content[0].text`；处理器错误另带 `isError: true`。JSON-RPC/协议层和 SDK 入参校验错误遵循 MCP 协议，不保证经过客户端 envelope。stdio stdout 只用于协议，诊断写 stderr。
- 常见变更结果 `Mutation`：预览有 `dryRun: true, action, payload, message`，部分批量预览还有 impact；执行有 `dryRun: false, action, payload, result`。登录、令牌刷新、日志清空及 CLI 文件写入的执行结果另见下表，不强行包装为 Mutation。
- `Id` 是字符串或数字。CLI 仅把规范且安全的十进制数字转换为 number，超出安全整数或带前导零的 ID 保留原字符串。任务接口的 `taskId` 与本地计划接口的字符串 `taskId` 不是同一种实体。
- 日志/远程文本默认最多 200000 字节，返回 `text, bytes, limitBytes, truncated`。下载默认拒绝覆盖，需另传 `overwrite` / `--overwrite`；MCP 目标限定在 `EASY_CONSOLE_DOWNLOAD_DIR`（默认 `~/.easy-console/downloads`）内，CLI 显式 `--output` 可选任意本地路径。

## 54 个 MCP 工具

下表输入中 `?` 表示可选；所有变更项的 `confirm?` 默认 false。除上面列出的三个 experimental 工具外，其余接口归类 stable。后端数据/原始响应保持可检查，不将尚未确认的服务端字段写成客户端必填字段。

| 工具名 | 输入 | data / 执行结果 |
| --- | --- | --- |
| `easyconsole_task_list` | `page?, page_size?, keyword?, name?, status?` | `items, total?, raw`；默认第 1 页、每页 500 |
| `easyconsole_task_log` | `taskId, limitBytes?` | 任务标识及有字节上限的文本 |
| `easyconsole_task_get` | `taskId` | `task, statusText, ssh, monitorUrl`；ssh 摘要不含密码，task 保持后端原始字段 |
| `easyconsole_task_wait` | `taskId, statuses?, timeoutSeconds?, intervalSeconds?` | `task, outcome, status, statusText, elapsedMs`；目标默认 `[2]`，超时默认 300s/最大 900s，间隔默认 10s/最小 5s |
| `easyconsole_task_create` | `payload, confirm?` | Mutation；payload 的 name 必填 |
| `easyconsole_task_release` | `taskId, confirm?` | Mutation；停止计费并销毁容器内数据 |
| `easyconsole_task_release_batch` | `taskIds: Id[], confirm?` | 预览 impact；执行 result 含 `batchId, count, results` |
| `easyconsole_task_delete` | `taskId, confirm?` | Mutation；删除实例记录 |
| `easyconsole_storage_list` | `path?` | 存储列表，path 默认 `/` |
| `easyconsole_storage_read_text` | `path, limitBytes?` | `path` 及有字节上限的文本 |
| `easyconsole_storage_download` | `path, outputPath?, overwrite?, confirm?` | Mutation；result 含 `remotePath, path, bytes` |
| `easyconsole_storage_mkdir` | `path, confirm?` | Mutation |
| `easyconsole_storage_delete` | `path, confirm?` | Mutation |
| `easyconsole_image_list` | `query?` | `custom, system, items` |
| `easyconsole_image_set_default` | `imageId, confirm?` | Mutation |
| `easyconsole_image_update` | `imageId, payload, confirm?` | experimental Mutation；name/description/tag 可选，未知扩展字段保留 |
| `easyconsole_image_delete` | `imageId, confirm?` | experimental Mutation；不可撤销 |
| `easyconsole_user_info` | 无 | 后端用户信息 |
| `easyconsole_resource_list` | 无 | 后端资源规格 |
| `easyconsole_price_list` | 无 | 后端价格数据 |
| `easyconsole_monitor_url` | `taskId` | `task, url` |
| `easyconsole_task_update` | `taskId, payload, confirm?` | experimental Mutation；PATCH only，payload 的 name 可省略 |
| `easyconsole_task_delete_batch` | `taskIds: Id[], confirm?` | 预览 impact；执行 result 含 `batchId, count, results` |
| `easyconsole_task_check_name` | `name` | 后端名称可用性结果 |
| `easyconsole_task_download` | `taskId, outputPath?, overwrite?, confirm?` | Mutation；result 含 `path, bytes` |
| `easyconsole_dashboard_stats` | `query?` | 后端统计数据 |
| `easyconsole_dashboard_cost` | `query?` | 后端费用统计 |
| `easyconsole_dashboard_cost_month` | 无 | 后端月费用数据 |
| `easyconsole_dashboard_monitor_index` | `query?` | 后端监控数据；单位须按真实服务核验 |
| `easyconsole_image_system` | `query?` | 系统镜像列表 |
| `easyconsole_image_detail` | `imageId` | 后端镜像详情 |
| `easyconsole_image_download` | `imageId, outputPath?, overwrite?, confirm?` | Mutation；result 含 `path, bytes` |
| `easyconsole_image_commit` | `payload, confirm?` | Mutation；提交容器环境为镜像 |
| `easyconsole_storage_upload` | `localPath, remoteDirectory, confirm?` | Mutation |
| `easyconsole_storage_info` | 无 | 后端存储用量信息 |
| `easyconsole_account_change_password` | `payload, confirm?` | Mutation |
| `easyconsole_account_refresh_token` | `confirm?` | 预览不含凭据；执行返回 `refreshed, token` 并写本地 config |
| `easyconsole_template_list` | 无 | 本地实例模板数组 |
| `easyconsole_template_create` | `template, confirm?` | Mutation；result 是新模板 |
| `easyconsole_template_update` | `templateId: string, template, confirm?` | Mutation；result 是更新后的模板 |
| `easyconsole_template_apply` | `templateId: string, variableValues?, confirm?` | 预览生成的 impact；执行 result 含 `batchId, created, results` |
| `easyconsole_template_delete` | `templateId: string, confirm?` | Mutation |
| `easyconsole_schedule_list` | 无 | 本地定时任务数组 |
| `easyconsole_schedule_create` | `name, scheduleTime, payload, description?, recurrence?, confirm?` | Mutation；执行后另含本地调度说明 |
| `easyconsole_schedule_update` | `taskId: string, patch, confirm?` | Mutation |
| `easyconsole_schedule_pause` | `taskId: string, confirm?` | Mutation |
| `easyconsole_schedule_resume` | `taskId: string, confirm?` | Mutation |
| `easyconsole_schedule_run` | `taskId: string, confirm?` | Mutation；验证已知账号归属，执行结果含计划和远程结果 |
| `easyconsole_schedule_delete` | `taskId: string, confirm?` | Mutation |
| `easyconsole_backup_export` | 无 | v1 非机密备份对象；不提供 includeSecrets 参数 |
| `easyconsole_backup_import` | `backupText, sections?: string[], confirm?` | Mutation；拒绝 token/savedAccounts sections |
| `easyconsole_run_log_list` | `limit?, source?, channel?, result?, keyword?` | 过滤后的日志数组 |
| `easyconsole_run_log_export` | 无 | JSON 日志导出对象 |
| `easyconsole_run_log_clear` | `confirm?` | 预览；执行返回 `dryRun: false, action, cleared: true` |

创建/更新 payload 保留后端拼写 `releace_conditions`、`releace_time`。MCP 对已知资源字段的校验：cpu 为正数，gpu 为非负整数，memory 为正整数，数量可为数字字符串；释放条件为 1/2/3。MCP 创建 name 去空白后不可为空，更新 name 可选。CLI 字段选项解析数字；原始 payload JSON 不使用 MCP 的 schema，创建时过滤空值并要求非空字符串 name，资源约束仍由后端核验。未知后端扩展字段透传，不用猜测出的字段覆盖 raw。

## CLI 命令与参数

全局参数：`--api-base-url, --token, --config, --run-log-path, --allow-insecure-http, --lang, --json, --help`。文件配置默认 `~/.easy-console/config.json`；显式 CLI 参数覆盖环境和文件。`--lang` 优先于 `EASY_CONSOLE_LANG`、系统语言和英语兜底。

下列全部变更命令另支持 `--yes`，包括下载、login、refresh-token 和 backup export 的文件输出。

| 命令 | 位置参数及选项 |
| --- | --- |
| `login` / `whoami` | login：必填 `--username`，执行时 `--password` 或 `--password-stdin`；预览不读 stdin。whoami 无专用参数 |
| `task list` | `--page, --page-size, --keyword, --name, --status` |
| `task log` / `task get` | `<taskId>`；log 另有 `--limit-bytes` |
| `task wait` | `<taskId>, --for`（逗号分隔状态）, `--timeout, --interval`；时限规则同 MCP |
| `task create` / `task update` | update 有 `<taskId>`；`--payload-json` 或下方字段选项 |
| `task release` / `task delete` / `task check-name` | 前两者 `<taskId>`，check-name 为 `<name>` |
| `task release-batch` / `task delete-batch` | `<ids>`，逗号分隔 |
| `task download` | `<taskId>, --output, --overwrite` |
| `storage ls` | `[path]`，默认 `/` |
| `storage cat` | `<path>, --limit-bytes` |
| `storage download` | `<path>, --output, --overwrite` |
| `storage mkdir` / `storage delete` | `<path>` |
| `storage upload` | `<localPath> <remoteDir>` |
| `storage info` | 无专用参数 |
| `image list` / `image system` | 无专用参数 |
| `image detail` / `image set-default` / `image delete` | `<imageId>` |
| `image update` | `<imageId>, --name, --description, --payload-json` |
| `image download` | `<imageId>, --output, --overwrite` |
| `image commit` | `--payload-json` 或 `--pod-name, --user` |
| `resource list` / `price list` | 无专用参数 |
| `monitor-url` | `<taskId>` |
| `dashboard stats` / `dashboard cost` / `dashboard monitor-index` | `--query-json` |
| `dashboard cost-month` | 无专用参数 |
| `account change-password` | `--payload-json` 或 `--old, --new` |
| `account refresh-token` | 无其他专用参数 |
| `template list` | 无专用参数 |
| `template create` / `template update` | `--template-json` 必填；update 有 `<templateId>` |
| `template apply` | `<templateId>, --variables-json` |
| `template delete` | `<templateId>` |
| `schedule list` | 无专用参数 |
| `schedule create` | 必填 `--name, --schedule-time, --payload-json`；可选 `--description, --recurrence-json` |
| `schedule update` | `<taskId>, --schedule-json` 必填 |
| `schedule pause` / `schedule resume` / `schedule run` / `schedule delete` | `<taskId>`，本地计划 ID |
| `backup export` | `--include-secrets, --output`；无 output 时只读导出，无机密 JSON 到 stdout；含机密须给 output，写文件须 --yes |
| `backup import` | `<file>, --sections`（逗号分隔）, `--include-secrets`；导入凭据还需显式 include-secrets |
| `run-log list` | `--limit, --source, --channel, --result, --keyword` |
| `run-log export` / `run-log clear` | 无其他专用参数 |

create/update 字段选项：`--name, --image-id, --price, --cpu, --gpu, --memory, --storage-path, --mount-path, --release-condition, --release-time, --work-directory, --script-path, --env`（可重复的 KEY=VALUE）, `--experiment-id`。原始 `--payload-json` 优先于字段选项；更新不需要重复创建时的 name。

## MCP resource URI

稳定 URI 为 `easyconsole://local/templates`、`easyconsole://local/resource-presets` 及各自 `/{id}`。集合返回新鲜读取的 JSON 数组，单项返回对应本地对象；`contents[].mimeType` 为 `application/json`，JSON 放在 `contents[].text`。单项 ID 只做一次 percent 编码/解码，缺失项返回 MCP InvalidParams。使用 `resources/list` 获取单项 URI。

Resources 不读取远程 API，不要求 token 或远程 HTTP opt-in，不额外读取桌面钥匙串。模板、预设、计划、非机密设置和默认日志共用桌面存储；CLI/MCP 凭据独立。本地计划由 sidecar 保存后不会自行运行，桌面需验证归属；手动 run 校验已知账号和 API 域。

## 本次审阅的兼容变化

在 1.0 冻结前补齐确认门：CLI login、account refresh-token、三种 download、backup export --output，以及 MCP account_refresh_token。旧 0.4.x 脚本要添加 `--yes` / `confirm: true`。工具名称保持 54 个，未新增别名；MCP task_update 纠正为接受不含 name 的 PATCH；CLI 不再对长 ID 舍入，用法错误在 --json 下也返回 JSON。

自动化证据位于 cli / mcp-tools / mcp-resources 测试；安装包、真实服务与旧数据 fixture 的验收边界继续参见 [发布清单](RELEASE_CHECKLIST_1.0.0.md)。
