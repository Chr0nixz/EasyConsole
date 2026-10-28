# 新功能收尾与本地验收（2026-10-27）

本报告对应 [2026-10-25 审阅](PROJECT_REVIEW_2026-10-25.md)第 4 节中已经开始实现的五项功能。代码基线为 `a1c826a`，包含本轮尚未提交的工作区修改。

按用户要求，本轮没有使用真实账号，也没有连接真实控制台或 GPU 主机。下文“通过”指本地模拟 API、模拟 SSH、Windows 系统接口和 Tauri 开发态界面的验收；真实服务兼容性单列为待实测。

## 功能结果

| 功能 | 本轮收尾 | 本地验收结果及边界 |
|---|---|---|
| 闲置检测、提醒与可选释放 | 复用主窗口现有 SSH 会话，以固定只读 `nvidia-smi` 命令采样所有可见 GPU；保留 CPU／网络提醒作为降级路径；补齐默认关闭的自动释放选项 | 通过。自动释放要求全部已分配 GPU 的完整连续采样窗口、CPU 低负载、网络零流量，以及相同账号和 API 域。数据缺失、设备数量不符、采样间断或账号切换均阻止释放。提交前持久化意图，未知结果不自动重试 |
| 定时释放提醒与延长 | 核验提醒去重、延长入口、成功后刷新及失败反馈；移除危险的 PUT 编辑回退 | 通过。桌面界面实际提交到本机模拟服务，只产生一次 PATCH，实例保持运行。真实后端必须支持安全的 PATCH 编辑；不支持时明确报错 |
| 定时任务可靠运行 | 补 Windows 计划任务兜底：每分钟检查桌面本地计划，到期且应用未运行时启动应用；保留自启、托盘、错过执行和账号归属检查 | 通过真实 Windows 任务注册、查询、删除及幂等删除；临时任务已移除。实际执行脚本验证了旧数据、迁移后数据、暂停、未来时间、删除标记，且删除计划不会从旧快照复活。需要交互式系统登录及有效控制台登录；其他系统仍使用自启／托盘 |
| CLI／MCP 增强 | 增加模板、资源预设的集合与单项 MCP resources；加强资源数量和释放条件校验，保留未知后端扩展字段 | 通过 MCP 协议发现、读取、URI 编码、更新后的重新读取及缺失项报错；CLI 的 get／wait、镜像 dry-run 和 `--yes` 经过本地 HTTP 验证 |
| 镜像更新、删除 | 补 UI 成功／失败／重试、系统镜像动作限制、删除确认及刷新验证；修复失败时未处理的 rejection 和对话框布局 | 通过共享 HTTP 包装、CLI、MCP 工具及组件测试；桌面检查了列表、编辑表单、焦点和 Escape 返回。真实后端更新／删除行为仍待测试账号验证 |

## 验收中修复的问题

- 原控制台以 `PUT /instance/task/{id}` 释放实例，旧编辑逻辑在 PATCH 不可用时会回退到该请求。本轮改为只使用 PATCH，按 API 地址记录编辑能力，避免延期变成释放或跨服务复用能力判断。
- 默认全局快捷键被其他进程占用时，插件初始化会令应用启动失败。现改为启动后尝试注册，冲突只记录警告；独立验收实例可与已安装的应用并存。
- 非默认应用标识使用独立钥匙串命名空间，默认安装继续使用原服务名。验收配置使用 `com.easyconsole.acceptance`，没有复用日常安装的账号和数据目录。
- 通知设置保存后立即更新后台观察器；禁用时不再依赖路由切换才能生效。系统通知失败会降级为应用内提醒。
- 镜像和延期表单在提交期间保护关闭操作；镜像错误保留输入，删除错误明确提示并保留重试入口。

## 自动化结果

| 检查 | 结果 |
|---|---|
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run typecheck:tools` | 通过 |
| `npm.cmd run lint` | 通过，0 errors / 39 既有 warnings，未提高上限 |
| `npm.cmd run test` | 111 个文件、782 项全部通过 |
| `npm.cmd run build:desktop` | 通过，包含 CLI／MCP sidecar 打包及渲染层生产构建 |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` | 66 项通过；另 1 项修改 OS 状态的用例默认忽略，已单独执行通过 |
| Windows `windows_task_registration_roundtrip -- --ignored` | 通过，临时 OS 任务已清理 |
| `cargo check --offline --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通过 |
| `cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| SSH 集成测试（`--features ssh-test-internals`） | 16 项全部通过；包含独立 GPU exec 通道与终端输入输出共存 |
| 界面检测 | Impeccable detector 对本轮界面文件无发现；已检查 Windows Tauri 设置、镜像表单和延期表单 |

没有执行安装包签名、公证或安装器升级验收，本轮构建结果为桌面输入与 sidecar。

开发热更新期间曾出现共享 Context 模块的 Fast Refresh 告警；冻结代码后的独立 Tauri 冷启动正常。相关混合导出的既有 lint 警告未在本轮清理。

## 复现桌面验收

先启动只监听回环地址的模拟控制台：

```powershell
node --import tsx tools/acceptance/mock-console.ts
```

另开一个终端启动隔离的 Tauri 实例：

```powershell
npm.cmd run tauri:dev -- --config tools/acceptance/tauri.conf.json --no-watch
```

模拟 API 使用 `127.0.0.1:28991`，开发页面使用 `127.0.0.1:1429`。启动脚本仅为未使用的验收配置播种合成登录状态；应用目录和钥匙串均与默认安装隔离。结束后退出该实例并停止模拟服务。

## 使用条件与后续实测

- GPU：需要主窗口已有可用 SSH 连接、目标机存在 `nvidia-smi`，且能读取全部已分配 GPU。真实 GPU 主机、真实监控字段单位和通知权限仍待实测。
- 自动释放：网络单位未确认，因此提醒允许低流量启发式判断，自动释放额外要求零流量。首次执行前应使用专门测试实例核验阈值和实际释放结果。
- 延期：需要用专门测试实例验证后端 PATCH 的支持情况、返回错误及服务端释放时间是否确实改变。
- 镜像：需要用可删除的测试镜像验证真实更新／删除权限与接口行为。
- Windows 唤起：已验证任务注册及脚本分支；跨重启、休眠唤醒、实际安装路径变更和登录失效恢复仍应在安装包环境验收。
- 数据互通：本次早期验收时 CLI／MCP 与桌面使用各自的存储。2026-10-28 后续整改已改为共享按 key 存储，见 [续办记录](REVIEW_FOLLOWUP_2026-10-27.md)；匹配版本可直接读取模板与资源预设。CLI／MCP 新建计划仍需在桌面核验归属后才能自动运行。

MCP resources URI：

```text
easyconsole://local/templates
easyconsole://local/templates/{id}
easyconsole://local/resource-presets
easyconsole://local/resource-presets/{id}
```

审阅文档中尚未开始的 Jupyter／TensorBoard 预设、日志关键词与外部通知、成本看板、SSH 命令片段与广播、实验归组不在本轮范围内。
