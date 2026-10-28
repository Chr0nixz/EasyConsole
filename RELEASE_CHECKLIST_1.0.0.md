# EasyConsole 1.0.0 发布前检查清单

> 编写日期：2026-10-28
> 基线：`a1c826a`（v0.4.27 之后）加上工作区中尚未提交的改动
> 依据：[PROJECT_REVIEW_2026-10-25.md](PROJECT_REVIEW_2026-10-25.md)、[SSH_REVIEW_2026-10-27.md](SSH_REVIEW_2026-10-27.md)、[FEATURE_ACCEPTANCE_2026-10-27.md](FEATURE_ACCEPTANCE_2026-10-27.md)、[REVIEW_FOLLOWUP_2026-10-27.md](REVIEW_FOLLOWUP_2026-10-27.md)、[MOBILE_REVIEW.md](MOBILE_REVIEW.md)、[PRODUCT.md](PRODUCT.md)

## 怎么用这份清单

1.0 不以功能数量衡量。它对团队的承诺是三件事：可以放心天天用；升级不会丢本地数据；脚本和 AI 依赖的 CLI/MCP 接口不会随便变。

取舍原则：**1.0 之后改起来代价大的，现在改；之后随时能改的，留到 1.x。** 第 8 节列出明确不阻塞 1.0 的事项。

- 除标"可选"的项以外，第 1–7 节每一项都阻塞 1.0。
- 每完成一项，在提交里把 `[ ]` 改成 `[x]`，并在行尾补上证据：提交号、CI 运行链接或验收记录。
- 真实环境验收只用专门的测试账号和测试实例，不提交任何凭据。

## 发布节奏

| 阶段 | 版本 | 目的 | 出口条件 |
|---|---|---|---|
| 1 | — | 工作区落盘 | 三平台 CI 与 Android CI 全绿 |
| 2 | 0.5.0 | 承载本地存储迁移 | 0.4.27 自动更新到 0.5.0 后本地数据完整 |
| 3 | 0.9.0 | 冻结对外契约 | 第 3、4 节完成 |
| 4 | 0.9.x | 真实环境验收与团队试用 | 第 5 节完成，试用期内无未关闭的 P0/P1 |
| 5 | 1.0.0 | 正式发布 | 代码与最后一个 0.9.x 相同 |

候选版本用 0.5.x / 0.9.x，不用 `1.0.0-rc.N`：

- Windows MSI 只接受纯数字的预发布标识，`rc.1` 会让 MSI 打包失败。
- 更新器读取 `releases/latest/download/latest.json`，GitHub 的 latest 会跳过预发布版本。rc 一旦被标成预发布，团队成员就收不到自动更新。

## 1. 工作区落盘

起始状态：main 上有 95 个文件、约 +5.2k / −1.2k 行改动尚未提交，其中包括本地存储迁移和 SSH 审阅的修复，都还没在远程 CI 上跑过。发布准备工作在 `codex/release-readiness-1-0` 分支推进。

- [x] 按主题拆成几次提交，例如：按 key 存储与跨进程锁（含 CLI/MCP 共享存储）；SSH 审阅修复；GPU 闲置检测与自动释放；定时任务唤起与错过执行策略；MCP resources；测试与覆盖率门槛；文档。证据：`c6302c5` 存储与归属、`48aac9e` SSH、`86e56d2` 闲置检测、`ed65a7e` 计划唤起、`6473dcd` MCP resources、`9198741` 任务/日志/存储流程、`b4ac834` CI 与覆盖率；文档在本提交统一落盘。
- [x] 最终提交状态通过 [AGENTS.md](AGENTS.md) 规定的全套本地检查。证据：2026-10-28 Windows 本地检查记录如下；代码保持 0.4.27，尚未制作候选安装包。
- [ ] 推送后 CI 三个平台（Windows、macOS arm64、Linux）全绿，包括覆盖率门槛、`cargo test --lib` 和 `ssh_integration`；Android CI 全绿。
- [x] 对照 [SSH_REVIEW_2026-10-27.md](SSH_REVIEW_2026-10-27.md) 第 7 节第 1、2 批的完成标准逐项核对。从代码看，SSH-P1-06/07/08、P2-12、P2-15、P3-13 已有对应改动；P2-13、P2-14 和其余 P3 需逐项确认。每一项要么有自动化测试，要么列入第 5.3 节的真机回归。证据：2026-10-28 [逐项复核记录（第 8 节）](SSH_REVIEW_2026-10-27.md#8-2026-10-28-发布准备复核)，35 项 Windows SSH 集成测试通过；真机项目继续保留。

### 2026-10-28 本地检查记录

| 检查 | 结果 |
| --- | --- |
| `npm.cmd run version:check` | 0.4.27 版本一致 |
| `npm.cmd run typecheck`、`npm.cmd run typecheck:tools` | 通过 |
| `npm.cmd run lint` | 通过，37 warnings / 0 errors，上限未提高 |
| `npm.cmd run test` | 116 个文件、856 项通过 |
| `npm.cmd run test:coverage` | 856 项通过；lines 65.09%、statements 62.61%、functions 55.36%、branches 56.45%，全部门槛通过 |
| `npm.cmd run build:desktop` | 两份 sidecar 与 Vite 渲染层构建通过 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过；额外启用 `ssh-test-internals` 的 clippy 也通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 83 项通过，1 项修改 OS 计划任务的测试按配置忽略 |
| `cargo test --manifest-path src-tauri/Cargo.toml --features ssh-test-internals --test ssh_integration` | Windows 35 项通过；Unix 额外符号链接用例等待 CI |
| Android arm64 `cargo check --target aarch64-linux-android`（在 `src-tauri/`，NDK 27） | 通过，未构建 APK、未做真机验收 |
| 三个 workflow 的 YAML / Action 引用校验 | YAML 解析通过；29 个 SHA、4 处显式 stable，Android PR 触发开启 |
| `git diff --check` | 通过 |

## 2. 0.5.0：承载本地存储迁移

这批改动把桌面本地存储从单个 `runtime-storage.json` 改成 `runtime-storage.d/` 按 key 分文件，CLI/MCP 也改为共享这份存储。迁移出错的后果是设置、账号、模板、定时任务、执行台账全部丢失，所以不能让 1.0 成为第一个执行迁移的版本。

### 2.1 准备旧数据

- [ ] 在一台干净的 Windows 上安装 0.4.27，造一份完整的本地数据：
  - 多个已保存账号，其中至少一个开启"记住密码"；
  - 运行时 URL、通知与闲置提醒设置；
  - 实例模板、资源预设；
  - 定时任务（启用、暂停、已执行各至少一个）、执行台账、变更清单、运行日志；
  - SSH 默认密码、VS Code 授权主机、已信任的主机密钥。
- [ ] 同一台机器上保留一份旧版 CLI 数据（`%USERPROFILE%\.easy-console\` 下的 `local-data.json` 和运行日志）。

### 2.2 升级验证

- [ ] 通过应用内自动更新从 0.4.27 升级到 0.5.0（不是卸载重装）。2.1 节的数据全部可见、可用，已保存账号可以一键登录。
- [ ] 应用数据目录下生成 `runtime-storage.d/`；旧 `runtime-storage.json` 保留为快照，内容未被修改。
- [ ] 运行新版 CLI：旧 CLI 数据只导入共享存储中不存在的 key，源文件不变，写入迁移标记；再次运行不重复导入。
- [ ] 桌面开着时用 CLI 创建模板，桌面不重启就能看到；MCP resource 能读到桌面刚建的模板。
- [ ] 大文件上传期间强制结束进程，再次启动后数据完整，或能从 `.bak` 恢复，不会静默清空。
- [ ] macOS 和 Linux 各走一次 0.4.27 → 0.5.0 自动更新，数据迁移和钥匙串读取正常。
- [ ] Android 从 0.4.27 应用内更新到 0.5.0 成功（对应 [MOBILE_REVIEW.md](MOBILE_REVIEW.md) 的 MOB-15）。
- [ ] 确认降级行为：0.4.27 只读得到迁移前的快照；降级期间的改动再次升级时是否迁入，以实测为准。不支持降级的话，在发布说明里写明。

### 2.3 发布

- [ ] 先用 `workflow_dispatch` 手动跑一次 Release 演练。它会生成 `manual-N` 草稿预发布，不影响团队的自动更新。确认 Windows、Linux、macOS arm64/x64 和 Android 全部出包，`latest.json` 内容正确。演练结束后删除草稿。
- [ ] 推送 `v0.5.0` tag。注意：tag 触发的 Release 会直接公开发布，不经过草稿。
- [ ] 团队使用 0.5.0 至少一周，没有数据丢失报告。

## 3. 0.9.0：冻结对外契约

### 3.1 Sidecar 布局

- [ ] 决定是否把 `easy-console-cli`（约 58MB）和 `easy-console-mcp`（约 60MB）合并成一个按子命令分派的可执行文件。合并能让 sidecar 体积减半；但 MCP 客户端配置里写的是可执行文件路径，1.0 之后再合并会让所有已有配置失效。要合就在这一阶段合。
- [x] 修正文档里的可执行文件名：[SKILL.md](skills/easy-console-ai/SKILL.md) 的命令替换说明和二进制清单统一为 `easy-console-cli.exe` / `easy-console-cli`，与 README 和 sidecar 构建输出一致。证据：2026-10-28 文档及 `build:desktop` 产物名核对。
- [ ] 写明各平台安装后 sidecar 的实际路径，MCP 接入示例直接使用这个路径。

### 3.2 CLI / MCP 接口

- [ ] 逐个审阅 54 个 MCP 工具的名称、参数和返回结构，该改名的现在改。1.0 之后改名或删除工具，要先保留旧名并标记弃用，到 2.0 才移除。
- [ ] 审阅 CLI 子命令、参数、退出码，以及 `--json` 的 `{ ok, data, error }` 输出格式。
- [ ] 所有变更类操作保持一致：CLI 默认 dry-run，需要 `--yes`；MCP 需要 `confirm: true`。
- [ ] MCP resource URI（`easyconsole://local/templates`、`easyconsole://local/resource-presets` 及单项 URI）纳入契约。
- [ ] 在 SKILL.md 和 README 里标明稳定性分级：stable（1.x 内兼容）和 experimental（可能变化）。

### 3.3 本地数据格式

- [ ] 定稿并记录各格式的当前版本：存储 manifest v1；本地备份 `LOCAL_DATA_BACKUP_VERSION = 1`（[local-data-backup.ts](src/lib/local-data-backup.ts)）；备份加密格式 `version: 1`（[backup-crypto.ts](src/lib/backup-crypto.ts)）；桌面与 sidecar 共用的 `.lock` 目录协议。1.x 内只做向前迁移。
- [ ] 把第 2 节造的 0.4.27 数据脱敏后存为测试 fixture，加一条"旧版数据迁移到当前版本"的回归测试。
- [ ] 1.0 能导入 0.4.x 导出的本地备份。

### 3.4 不可更改项

1.0 之后改动下面任何一项，已安装的用户都会失去本地数据、凭据或自动更新。确认现值，并写进 [AGENTS.md](AGENTS.md)：

- [ ] 应用标识 `com.easyconsole.desktop`：它决定应用数据目录和钥匙串服务名 `easy-console`。
- [ ] 更新器公钥和更新地址（[tauri.conf.json](src-tauri/tauri.conf.json) 的 `plugins.updater`）。
- [ ] deep link scheme `easyconsole://`。
- [ ] Android 包名和签名证书。
- [ ] `TAURI_SIGNING_PRIVATE_KEY` 及其口令、Android keystore 及其口令都已离线备份，并实际验证过备份可用。私钥丢失后，已安装的客户端再也收不到自动更新。

### 3.5 功能成熟度

- [ ] 下面这些功能在第 5.2 节真实验证通过之前，在界面和文档里标"实验性"：闲置自动释放、Windows 计划唤起、镜像更新与删除、定时释放延期（PATCH）。验证通过后再去掉标记。
- [ ] 闲置自动释放保持默认关闭。开启时的说明要写清楚：会释放实例，并销毁容器内的数据。

## 4. 发布链路

- [x] 把三个 workflow 里的第三方 Action 固定到 commit SHA，并保留版本注释。重点是持有签名私钥的 [release.yml](.github/workflows/release.yml)，涉及 `actions/checkout@v4`、`actions/setup-node@v4`、`actions/setup-java@v4`、`actions/cache@v4`、`actions/upload-artifact@v4`、`dtolnay/rust-toolchain@stable`、`Swatinem/rust-cache@v2`、`android-actions/setup-android@v4`、`tauri-apps/tauri-action@action-v0.6.2`。`dtolnay/rust-toolchain` 固定 SHA 后，要显式传 `toolchain: stable`。Dependabot 仍能更新固定了 SHA 的引用。证据：2026-10-28 从各官方仓库的 tag/branch 解析 commit（含 annotated tag 解引用）；三个 YAML 解析通过，29 处 Action 引用均为 40 位 SHA，4 处 Rust setup 均显式指定 stable。
- [ ] Windows Authenticode 签名：必须明确决定做不做，签名本身可选。不做的话，在 README 的安装说明里写明 SmartScreen 提示和放行方式。
- [ ] macOS 公证：同上。不做的话，写明被 Gatekeeper 拦截后怎么打开。
- [ ] [release.yml](.github/workflows/release.yml) 没有设置 `releaseBody`。确认 1.0 发布说明怎样进入 GitHub Release 正文和应用内的更新提示。
- [ ] 确认 Android `versionCode` 单调递增（tauri.conf.json 未显式设置时，由版本号推导）。1.0.0 的 `versionCode` 必须高于 0.9.x，否则无法覆盖安装。

## 5. 真实环境验收（0.9.x 安装包）

每项记录日期、平台、版本和结果。

### 5.1 基本流程

- [ ] 登录（含"记住密码"后的静默重登）、用户信息、多账号切换。
- [ ] 任务列表的筛选和搜索；用安全配置创建实例，查看日志，打开终端，释放实例。
- [ ] 存储：上传（含大文件断点续传和 0 B 文件）、下载、删除。
- [ ] 镜像列表。
- [ ] 中英文各走一遍上面的流程，确认新增界面没有漏翻。

### 5.2 尚未在真实后端验证的功能

来源：[PRODUCT.md:58](PRODUCT.md:58)、[FEATURE_ACCEPTANCE_2026-10-27.md](FEATURE_ACCEPTANCE_2026-10-27.md) 的"使用条件与后续实测"。

- [ ] 镜像更新与删除：用可删除的测试镜像验证权限和接口行为。
- [ ] 定时释放延期：后端接受 PATCH，服务端的释放时间确实改变，实例保持运行；后端不支持时界面明确报错。
- [ ] GPU 采样：真实主机上 `nvidia-smi` 能读到全部已分配的 GPU；监控字段（CPU、网络）的单位与界面显示一致。
- [ ] 闲置自动释放：在专门的测试实例上核验阈值，实际触发一次释放，确认执行台账记录正确。
- [ ] Windows 计划唤起：在安装包环境下，验证重启后、休眠唤醒后、安装路径变化后、控制台登录失效后的表现。

### 5.3 SSH 真机回归（至少 OpenSSH）

- [ ] vim、htop、tmux 全屏显示正常（SSH-P1-08）。
- [ ] 本地端口被占用导致转发失败后，界面显示错误；端口释放后能重新启动这条规则（SSH-P1-06）。
- [ ] VS Code 撤销只删除本机写入的那一行 `authorized_keys`；远端写入失败时原文件保持不变（SSH-P1-07）。
- [ ] 在连接、握手、认证阶段关闭标签页，会话不残留；页面重新加载后不留孤儿会话和转发监听（SSH-P2-12、P2-13）。
- [ ] 实例地址被回收、主机密钥变化时，能就地处理；VS Code 不再要求第二次首次信任（SSH-P2-15）。
- [ ] SFTP 上传下载、端口转发、打开系统终端、写入 VS Code Remote-SSH 配置。
- [ ] 连续高峰终端输出时 UI 保持可操作，隐藏标签仍能消费输出；暂停/恢复不丢内容，关闭不等待输出确认。记录 debug 日志中的批次、字节、在途峰值及背压计数（SSH-P3-02、SSH_DEVELOPMENT 第 8.4 节）。

### 5.4 Android 真机

来源：[MOBILE_REVIEW.md](MOBILE_REVIEW.md) 中"已修复，待真实设备回归"的各项。

- [ ] 安装与应用内更新（MOB-15）。
- [ ] 软键盘、safe-area、系统返回手势（MOB-01、MOB-02、MOB-05）。
- [ ] 320px 宽度下的远程存储选择器和任务详情页签（MOB-06、MOB-07）。
- [ ] SSH 多会话与辅助面板（MOB-03、MOB-04）。

### 5.5 其他桌面平台冒烟

- [ ] macOS arm64、macOS x64、Linux：安装、登录、SSH、托盘、系统通知、开机自启。

### 5.6 团队试用

- [ ] 团队使用 0.9.x 至少两周，期间只合并 bug 修复。
- [ ] 出口条件：没有未关闭的 P0/P1；第 5.1–5.5 节全部通过，或已在发布说明里列为已知限制。

## 6. 文档

- [ ] README 面向新成员：安装、首次登录、本地数据的存放位置、备份与恢复、接入 MCP、HTTP 实验室例外的说明。
- [ ] 按第 5.2 节的结果更新 [PRODUCT.md:58](PRODUCT.md:58) 的"尚未验证"一段。
- [ ] SKILL.md 的工具清单和稳定性分级与第 3.2 节一致。
- [ ] 1.0 发布说明写成产品全貌，不写成增量列表，包括：主要能力；从 0.4.x 升级的须知（数据迁移、是否支持降级）；1.x 的兼容性承诺（第 3 节的契约）；已知限制（非官方客户端、接口为逆向整理、实验性功能）。
- [ ] （可选）把根目录的审阅与验收报告移到 `docs/reviews/`，同步更新 PRODUCT.md、AGENTS.md 和本清单里的链接。

## 7. 发布 1.0.0

- [ ] 代码与最后一个 0.9.x 相同，只改版本号和发布说明。
- [ ] 同步修改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本号，更新 `package-lock.json` 和 `Cargo.lock`；`npm.cmd run version:check` 通过。
- [ ] 跑完 [AGENTS.md](AGENTS.md) 规定的全套检查，CI 全绿。
- [ ] 推送 `v1.0.0` tag。release.yml 会校验 tag 与版本号一致，然后直接公开发布。
- [ ] 发布后：在 Windows 上从 0.9.x 自动更新到 1.0.0 一次；`latest.json` 指向 1.0.0；Android APK 签名校验通过。
- [ ] 回滚预案：更新器不支持降级，1.0.0 出问题只能尽快发 1.0.1。保留 0.9.x 安装包，必要时手动重装。

## 8. 不阻塞 1.0 的事项

下面这些都值得做，但属于内部改动或新功能，1.0 之后随时可以做，不应挤进发版窗口：

- 拆分 `TasksPage.tsx`（2608 行）和 `SettingsPage.tsx`（2472 行）。
- 清理 39 个 lint 警告；ratchet 照常只降不升。
- 让 `.mjs` 构建脚本进入 lint 和类型检查；启用类型感知规则（如 `no-floating-promises`）。
- 实时日志的增量传输（10-25 审阅 P2-5，依赖后端接口能力）。
- SSH 审阅第 6 节的新功能：一键打开 Jupyter / TensorBoard（F-01）、持久会话与自动重连（F-02）、SSH 与任务生命周期联动（F-03）等。
- 10-25 审阅第 4 节中尚未开始的功能：日志关键词告警与外部通知、成本看板、SSH 命令片段与多实例广播、按实验归组。
