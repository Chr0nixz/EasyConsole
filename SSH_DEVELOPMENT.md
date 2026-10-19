# EasyConsole SSH 开发文档

> 文档状态：开发基线与路线图（Phase 0 止血项与第二批 P2 收尾已完成）
> 审阅快照：2026-10-05（第二轮迭代后更新）
> 产品定位：Tauri 桌面端优先，浏览器端提供降级展示和开发调试能力

本文档专门描述 EasyConsole 的 SSH 能力。内容同时覆盖当前实现审阅、技术约束、待修复问题和后续功能开发计划，供前端、Tauri/Rust、测试和发布工作共同使用。

## 1. 目标和边界

### 1.1 目标

SSH 子系统要让用户从任务详情或 SSH 工作区完成以下工作：

- 通过密码、私钥或后续扩展的认证方式建立交互式 SSH 会话。
- 在同一窗口维护多个会话，并在需要时弹出为独立窗口。
- 使用终端、SFTP 和端口转发完成日常运维操作。
- 清楚地看到连接阶段、主机密钥、认证、断开和传输错误。
- 在网络抖动、窗口切换、语言切换和应用退出时保持可预期的生命周期。
- 让凭据、主机密钥、端口监听和本地文件写入都有明确的安全边界。

### 1.2 当前非目标

以下能力目前不应通过临时 UI 或未经验证的后端字段“伪装支持”：

- 浏览器直接建立本地 SSH 连接。浏览器运行时只能展示 SSH 信息、复制命令或使用已有的 WebSSH 降级路径。
- 把 EasyConsole 做成完整的 PuTTY、SecureCRT 或 IDE 替代品。
- 在没有安全策略、审计和授权模型的前提下提供团队共享凭据。
- 默认接受未知或变化的主机密钥。

## 2. 当前实现总览

### 2.1 代码分层

| 层 | 主要文件 | 职责 |
| --- | --- | --- |
| 任务入口 | `src/components/tasks/TaskSshPanel.tsx` | 从任务字段生成 SSH 信息，提供应用内 SSH、系统终端和 VS Code 入口 |
| 会话容器 | `src/components/tasks/AppSshTerminalDialog.tsx` | 多标签、最小化、关闭确认、独立窗口和焦点管理 |
| 终端视图 | `src/components/tasks/SshTerminalTab.tsx` | xterm、PTY 尺寸、输入输出、搜索、录制、重连、SFTP 和端口转发面板 |
| SFTP 视图 | `src/components/tasks/SftpPanel.tsx` | 目录浏览、上传、下载、删除、重命名、新建目录、进度和取消 |
| 独立窗口 | `src/pages/SshTerminalPage.tsx` | 从 Tauri pending request 或 URL fallback 恢复连接请求 |
| 运行时适配 | `src/lib/runtime.ts` | 统一浏览器、Tauri 和 Node 的 SSH、通知、存储及事件边界 |
| 请求和设置 | `src/lib/ssh-info.ts`、`src/lib/app-settings.ts` | 任务字段归一化、认证模式、终端和转发设置 |
| 类型契约 | `src/lib/types.ts` | `SshConnectionRequest`、会话事件、SFTP 条目、转发规则 |
| Native 会话 | `src-tauri/src/ssh/session.rs` | `russh` 连接、认证、PTY、shell、事件分发和会话命令循环 |
| 主机密钥 | `src-tauri/src/ssh/host_key.rs` | TOFU、SHA-256 指纹、确认等待和 known host 管理 |
| SFTP | `src-tauri/src/ssh/sftp.rs` | SFTP 通道、文件操作、并行下载、进度和取消标志 |
| 端口转发 | `src-tauri/src/ssh/port_forward.rs` | 本地转发、SOCKS5 动态转发和 loopback 绑定校验 |
| 外部连接 | `src-tauri/src/ssh/terminal_spawn.rs`、`vscode.rs` | 系统终端和 VS Code Remote-SSH |
| 历史记录 | `src-tauri/src/ssh/history.rs` | 最近连接主机记录和清理 |

### 2.2 当前连接流程

1. 任务字段由 `buildTaskSshInfo` 提取主机、端口、用户名、密码和任务标识。
2. `TaskSshPanel` 生成 `SshConnectionRequest`，交给应用内终端或外部连接适配器。
3. `SshTerminalTab` 读取当前 SSH 设置，补充超时、keepalive、终端类型、私钥路径和认证模式。
4. Tauri `open_ssh_session` 创建随机 `sessionId`，记录所属窗口，并启动异步 `russh` 任务。
5. Native 层先建立 TCP、完成 SSH 握手和主机密钥检查，再执行密码或私钥认证。
6. 认证成功后请求 PTY 和 shell，通过 `ssh-session-event` 向所属 Webview 发送状态和输出。
7. SFTP 和端口转发复用同一 SSH 连接，但通过独立任务运行，避免长传输阻塞终端输出。
8. 终端卸载、用户关闭、窗口关闭或会话异常时发送关闭命令并清理相关资源。

### 2.3 当前状态模型

前端使用 `ready`、`connected`、`failed`、`closed` 显示标签状态；Native 侧至少发送以下事件：

| 事件 | 关键字段 | 用途 |
| --- | --- | --- |
| `status` | `phase`、`message` | connecting、connected、exited 等阶段 |
| `output` | `data` | PTY 输出，前端写入 xterm |
| `error` | `phase`、`message` | 连接或写入错误 |
| `closed` | `phase`、`message` | 会话最终关闭 |
| `host-key-prompt` | `promptId`、`host`、`port`、`fingerprint` | 等待用户确认未知主机 |
| `sftp-progress` | `transferId`、`transferred`、`total` | 上传或下载进度 |
| `port-forward-status` | `ruleId`、`active`、`error` | 转发监听状态 |

事件已经按窗口定向发送，前端也有早到事件缓冲；后续应把这些事件正式化为版本化协议，而不是继续依赖自由字符串。

## 3. 当前功能矩阵

| 能力 | 当前状态 | 已实现内容 | 主要限制 |
| --- | --- | --- | --- |
| 任务 SSH 入口 | 可用 | 从任务字段生成连接请求；显示主机、端口、用户名、密码和命令 | 后端字段不稳定时仍需保留原始 JSON；默认端口未完全统一 |
| 手动打开会话 | 可用 | 主机、端口、用户名、密码；可新增标签 | 手动标签固定使用密码模式，不能直接选择私钥或 Agent |
| 密码认证 | 可用 | `russh` 密码认证；设置可保存默认密码 | Web 回退不是 OS keychain 级保护；需加强脱敏和生命周期 |
| 私钥认证 | 部分可用 | Native 支持私钥和可选 passphrase；设置支持路径 | 只支持文件路径；未支持 Agent、证书、keyboard-interactive；`~` 未在 Native 展开 |
| 主机密钥 | 可用但需产品化 | TOFU、SHA-256 指纹、未知主机确认、变化拒绝、设置中删除 | 使用自定义 JSON，不兼容 OpenSSH `known_hosts` 导入；策略粒度有限 |
| 交互式终端 | 可用 | xterm、PTY、shell、resize、UTF-8 分片处理、scrollback | 输入通道无界；高吞吐时缺少背压和批量策略 |
| 终端体验 | 可用 | 多标签、搜索、滚动跟随、录制、重连历史回放、暗/亮/自定义主题、WebGL 可选 | 页面卸载会结束会话；录制仍是本地内存缓冲；缺少会话中心 |
| SFTP 浏览 | 可用 | `~` 家目录、目录列表、排序、父目录、路径跳转 | 没有虚拟化、目录缓存、递归树和远端搜索 |
| SFTP 文件操作 | 可用但需加固 | 上传、下载、删除、重命名、新建目录、覆盖确认、进度、取消 | 上传取消可能留下远端半文件；下载失败可能留下 `.part`；本地路径 IPC 缺少纵深防御 |
| SFTP 性能 | 部分可用 | 大文件下载使用多句柄并行；下载完成后原子 rename | 没有断点续传、校验和、冲突策略、队列和统一任务句柄 |
| 本地端口转发 | 可用 | `-L`，只允许 `127.0.0.1`/`::1` 绑定，支持 host scope 和自动启动 | 子连接未统一跟踪；listener 异常后的状态回收需加强 |
| 动态转发 | 可用 | `-D` SOCKS5 CONNECT，拒绝 BIND | 无流量、连接数和目标审计；缺少代理配置引导 |
| 远程端口转发 | 未实现 | Native 明确返回暂不支持 | 需要独立的监听权限、生命周期和风险提示设计 |
| 系统终端 | 可用 | Windows Terminal/PowerShell、macOS Terminal、Linux 常见终端 | 认证依赖系统 SSH 配置；命令文本复制仍需严格 shell escaping |
| VS Code Remote-SSH | 可用但风险较高 | 生成本地密钥、远端写入 `authorized_keys`、写 SSH config、启动 VS Code | 没有撤销、过期、来源标记和远端清理；流程始终要求密码 |
| 独立 SSH 窗口 | 可用 | Tauri pending request 避免密码进入主流程 URL；窗口关闭会清理会话 | URL fallback 仍可携带 JSON 和密码；窗口级所有权校验还不完整 |
| Web/移动端 | 部分可用 | 移动 Tauri 可用应用内终端；Web 只展示/复制信息 | 浏览器不直接建立本地 SSH；移动端组合键仍需真实设备回归 |

## 4. 已具备的工程基础

以下实现值得保留，并应作为后续开发的约束：

1. **运行时适配边界清晰。** 页面代码通过 `browserRuntime` 调用 Native 能力，避免把 Tauri API 直接散落到页面。
2. **事件按窗口隔离。** Rust 使用 `emit_to` 将输出、SFTP 进度和主机密钥提示发给所属 Webview，减少跨窗口串流风险。
3. **主机密钥默认不是无条件接受。** 首次连接要求用户确认，指纹变化会拒绝连接并提示删除记录后重试。
4. **输出处理考虑了真实字节流。** UTF-8 多字节字符跨 SSH chunk 时会保留不完整尾部，避免中文输出被替换字符破坏。
5. **SFTP 已考虑长任务隔离。** 传输在独立任务中执行，进度事件节流到约 100ms，并用 `transferId` 支持精确取消。
6. **大文件下载已经使用临时文件。** 下载完成后才 rename 到目标路径，减少半成品覆盖正式文件的概率。
7. **桌面凭据存储已经有迁移路径。** Tauri 的默认 SSH 密码可进入 OS secure storage，旧版明文设置会尝试迁移并从普通设置 JSON 移除。
8. **交互层已经有较完整的状态反馈。** 包括连接状态、关闭确认、主机密钥弹窗、SFTP 错误重试、上传覆盖确认和终端断线提示。

## 5. 当前问题与风险分级

级别定义：P0 表示发布阻断或高概率造成安全/数据损失；P1 表示核心流程错误、安全承诺失真或严重资源问题；P2 表示有绕过方式但影响稳定性、效率或维护成本；P3 表示体验和长期演进优化。

### 5.1 P1：发布前必须处理

#### SSH-P1-01：SSH 设置存在“可保存但不生效”的字段

`src/lib/app-settings.ts` 定义了 `defaultPort`、`defaultCols`、`defaultRows` 和 `maxHistoryEntries`，但当前调用链没有完整使用它们：

- 手动新增标签页在 `AppSshTerminalDialog` 中直接使用端口 `22`。
- Native 会话仍以 `22`、`120x32` 作为缺省值。
- Rust 历史记录使用固定的 `MAX_SSH_HISTORY_ENTRIES = 20`。
- 任务信息提取在缺少端口时返回 `-`，没有统一经过 SSH 设置解析。

这会让用户认为设置已生效，却在不同入口得到不同结果。应新增唯一的 `resolveSshConnectionRequest`，所有任务、手动标签、独立窗口、系统终端和 VS Code 入口都使用同一解析结果；设置为 `0` 的 keepalive 必须明确映射为禁用，而不是 `Duration::from_secs(0)`。

#### SSH-P1-02：认证入口不一致

当前私钥认证在 `SshTerminalTab` 到 Native 的路径可用，但：

- 手动新增标签页强制 `authMode: "password"`。
- VS Code 配置函数固定使用密码登录，再把生成的公钥写到远端。
- 没有统一的“认证提供者”抽象，导致设置、任务字段和外部工具的行为不同。

应先统一 `AuthMethod`/`AuthProfile` 契约，再实现密码、私钥、Agent、keyboard-interactive 和证书认证。连接界面必须显示当前实际采用的认证方式及其失败原因。

#### SSH-P1-03：VS Code 免密密钥缺少撤销和远端生命周期

`vscode.rs` 会生成本地私钥，并把公钥追加到远端 `authorized_keys`。当前没有：

- EasyConsole 专属 key 标记或唯一 key id。
- “撤销本机配置”操作。
- 远端条目删除或过期时间。
- 失败回滚和重复配置的审计记录。

这会留下长期有效的远端访问凭据。短期应为每个安装生成带注释的 key、记录 fingerprint、支持撤销和远端清理，并在 UI 中明确“本操作会修改远端 `authorized_keys`”。长期应允许用户选择已有 Agent/私钥，减少自动写远端文件。

#### SSH-P1-04：会话生命周期缺少统一管理器

会话、SFTP 传输、转发 listener、主机密钥等待和弹出窗口请求分别在不同模块维护。虽然已有窗口关闭清理和显式关闭确认，但仍存在以下风险：

- 页面卸载、路由切换或登出会直接卸载终端组件，连接和录制内容可能丢失。
- SFTP 上传/下载只保存取消标志，不统一保存外层 `JoinHandle`；网络读写卡住时取消不能立即终止任务。
- 端口转发的子连接任务没有统一跟踪。
- IPC 命令主要通过 `sessionId` 定位会话，没有再次校验调用窗口是否为 owner。

应建立 Native `SessionManager`，由它拥有会话、子任务、取消 token、窗口 owner 和最终清理逻辑。所有命令接收 `sessionId + ownerToken` 或由 Tauri command 从当前窗口推导 owner，跨窗口调用必须拒绝。

#### SSH-P1-05：SFTP 取消和临时文件契约不完整

当前下载使用 `${localPath}.part`，成功后 rename；但 worker 错误或取消的分支可能留下 `.part`。上传直接创建/截断远端目标，取消时可能留下半截正式文件。需要统一传输状态：`queued`、`running`、`canceling`、`completed`、`failed`、`canceled`，并规定：

- 上传写入远端临时名，成功后原子 rename；目标冲突策略由 UI 选择。
- 下载失败、取消和会话断开都清理临时文件，除非用户主动选择保留以便续传。
- 取消同时设置 token、终止任务句柄并关闭当前 SFTP handle。
- 每个传输返回最终结果和清理结果，不能只依赖进度事件推断成功。

### 5.2 P2：下一迭代必须处理

第二轮迭代已消化除 SSH-P2-10 外的全部 P2（修复说明见 §7.1 与 §10）。P2-10（OpenSSH known_hosts 导入）留作下一批候选。

| ID | 问题 | 影响 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| SSH-P2-01 | keepalive 设置为 0 仍创建零秒 interval | 可能产生错误的保活行为或立即超时 | `0` 映射为 `None`，并补网络断开测试 | ✅ |
| SSH-P2-02 | URL fallback 可携带完整连接 JSON | 密码可能进入 URL、历史或诊断信息 | Tauri 外只接受无密码 request；密码改为一次性 IPC/本地安全存储引用 | ✅ |
| SSH-P2-03 | 私钥路径支持 `~` 的 UI 提示，Native 不展开 | 默认路径在部分环境无法加载 | Native 使用平台 home 目录展开并验证路径归属 | ✅ |
| SSH-P2-04 | 浏览器 secureStorage 回退到 localStorage | Web 环境的 SSH 默认密码不是 OS keychain 保护级别 | 浏览器默认不持久化 SSH 密码，或必须显式确认风险 | ✅ |
| SSH-P2-05 | 复制的 SSH 命令没有统一 shell escaping | 异常主机、用户名或端口可能生成危险文本 | 复制命令使用结构化参数渲染，并标注仅供人工检查 | ✅ `formatSshCommand` 校验后裸拼，非法字段拒绝渲染 |
| SSH-P2-06 | 移动端 Ctrl 组合键存在普通字符与控制字符重复发送风险 | `Ctrl+C` 等操作可能同时输入 `c` 和 ETX | 用统一输入状态机拦截原字符，补 Android/iOS 设备测试 | ✅ 代码层修复；真机回归待做 |
| SSH-P2-07 | 输入使用无界 channel | 粘贴大量数据时内存和延迟不可控 | 使用有界 channel、批量写入和丢弃/背压策略 | ✅ 有界输入队列 + 专职 writer task |
| SSH-P2-08 | 端口转发 listener 异常退出后规则状态可能残留 | UI 显示 active，但实际端口已失效 | 任务退出自动回收 map，监听结束必发 inactive/error | ✅ 子连接 JoinSet 回收 + panic watcher |
| SSH-P2-09 | SFTP IPC 接受任意本地路径 | 渲染层被注入时可绕过文件选择器 | Native 校验路径、目标类型、覆盖意图和允许目录；限制符号链接逃逸 | ✅ 允许根注册 + 规范化/符号链接校验 |
| SSH-P2-10 | 自定义 known host 不支持 OpenSSH 文件 | 既有运维环境无法迁移 | 支持导入、显示算法、备份和按 host:port 删除 | ⬜ 下一批候选 |
| SSH-P2-11 | 页面级会话关闭，没有全局会话中心 | 用户切换任务后难以找回连接 | 把会话提升到 AppShell 层，页面只引用 session id | ✅ 全局会话中心（AppRoot 挂载，路由切换不掉会话） |

### 5.3 P3：产品化优化

- 终端布局分屏、标签收藏、工作区和会话分组。
- 命令片段、最近命令、批量发送和危险命令确认；片段中禁止默认保存明文秘密。
- 终端录制元数据、可搜索回放、大小上限和加密存储选项。
- SFTP 预览、远程编辑、拖放、批量操作和冲突策略。
- 连接诊断时间线：DNS/TCP/握手/主机密钥/认证/PTY 各阶段耗时。
- SSH 审计日志和可脱敏导出诊断包。

## 6. 开发约束和接口契约

### 6.1 连接请求解析

建议将所有入口归一化为如下逻辑对象，页面不得自行拼接默认值：

```ts
type ResolvedSshConnection = {
  host: string;
  port: number;
  username: string;
  auth: {
    mode: "password" | "private-key" | "agent" | "keyboard-interactive" | "certificate";
    secretRef?: string;
    keyPath?: string;
  };
  cols: number;
  rows: number;
  termType: string;
  connectTimeoutSec: number;
  keepaliveIntervalSec?: number;
  taskId?: string;
  taskName?: string;
};
```

解析规则：

1. 主机、用户名、端口先做格式和范围校验，再进入 Native。
2. 任务字段优先于全局默认值，但不能覆盖用户选择的认证策略。
3. 密码、passphrase 和 token 只通过安全引用传递；不进入 URL、普通日志或错误堆栈。
4. `keepaliveIntervalSec = 0` 表示禁用，不能传入零秒定时器。
5. PTY 尺寸由终端实际 fit 结果优先，设置中的默认尺寸只作为首次建立前的 fallback。

### 6.2 会话命令和事件

Native 会话命令应统一经过 `SessionManager`，建议至少包含：

```text
Open { request, owner }
Write { bytes }
Resize { cols, rows }
Close { reason }
Reconnect
StartTransfer { request }
CancelTransfer { transferId }
StartForward { rule }
StopForward { ruleId }
```

事件增加协议版本和单调序列号：

```json
{
  "version": 1,
  "sessionId": "...",
  "sequence": 42,
  "kind": "status",
  "phase": "connected",
  "message": "SSH connected",
  "timestamp": 0
}
```

输出事件仍可以单独使用 `data` 字段，但必须提供最大 chunk、丢弃策略和关闭时的 flush 语义。前端收到重复或过期序列号时应忽略，而不是重复写入终端。

### 6.3 主机密钥策略

默认策略保持严格：

- 已知指纹匹配：继续连接。
- 未知主机：显示主机、端口、算法和 SHA-256 指纹，用户确认后写入。
- 已知指纹变化：拒绝连接，要求用户在设置中显式删除旧记录后重试。
- VS Code 无交互流程：未知主机直接拒绝，不能隐式接受。

后续扩展策略时必须区分“本次接受”和“永久信任”，并为自动化环境提供受控的指纹预置，而不是增加全局 `acceptAnyHostKey` 开关。

### 6.4 SFTP 传输状态

每个传输必须有独立 `transferId`、明确的目标路径和最终结果。进度事件只用于展示，不能作为成功判据。建议结果结构：

```json
{
  "transferId": "...",
  "operation": "upload",
  "source": "...",
  "destination": "...",
  "status": "completed",
  "bytes": 1048576,
  "total": 1048576,
  "checksum": { "algorithm": "sha256", "value": "..." }
}
```

### 6.5 端口转发安全边界

- 默认只允许 loopback 绑定；放开局域网绑定必须单独的高风险确认和设置项。
- 本地、动态和远程转发使用不同的类型和值校验，不能仅依赖字符串 `forward_type`。
- 每条规则和每个子连接都有取消路径；SSH 会话关闭时必须先停止 listener，再等待子连接退出。
- UI 显示实际监听地址、端口、目标和当前连接数；失败状态不能停留在 active。

## 7. 分阶段开发计划

### Phase 0：发布前止血（1-2 个迭代）

目标：让现有密码/私钥终端、基本 SFTP 和本地转发在受控桌面环境中可靠运行。

| 顺序 | 工作项 | 交付物 | 完成标准 | 状态 |
| --- | --- | --- | --- | --- |
| 0.1 | 建立 `SessionManager` | 会话、传输、转发、窗口 owner 的统一 registry | 关闭窗口、登出、路由切换不会遗留任务；跨窗口 IPC 被拒绝 | ✅ owner 校验 + 统一清理（含传输 JoinHandle 跟踪） |
| 0.2 | 统一请求解析 | `resolveSshConnectionRequest` 和默认值测试 | 所有入口使用相同端口、尺寸、认证、超时、keepalive | ✅ 任务/手动/弹窗/系统终端/VS Code 全部接入 |
| 0.3 | 修复认证路径 | 手动标签支持私钥；VS Code 显示并使用明确认证方式 | 不再出现“设置选择私钥但入口强制密码” | ✅ 手动标签新增认证方式选择 |
| 0.4 | 收紧凭据边界 | 删除带密码 URL fallback；Web 默认不持久化 SSH 密码 | URL、run log、错误和诊断包无明文凭据 | ✅ Tauri 移除 URL fallback；Web 会话级内存 + 清理存量 |
| 0.5 | VS Code 撤销机制 | key fingerprint、远端标记、撤销命令、失败回滚 | 用户可以列出并删除 EasyConsole 写入的 key | ✅ 按主机独立 key + `list/revoke_vscode_ssh` + 设置页列表 |
| 0.6 | SFTP 传输管理 | `JoinHandle`、取消、超时、临时文件清理、上传原子提交 | 取消后无正式半文件；失败清理结果可见 | ✅ 取消即 abort + 临时文件清理 + 上传临时名原子提交 + 结果结构 |
| 0.7 | keepalive、`~`、Ctrl 修复 | Native 归一化和移动端输入测试 | 0 秒禁用；常见私钥路径可用；Ctrl 组合键只发送一次 | ✅ |
| 0.8 | 回归测试和质量门禁 | Rust mock SSH server、React runtime fake、IPC owner 测试 | 关键路径在 CI 中可重复执行 | ✅ 见第 10 节（注意运行命令需带 feature） |

### 7.1 第二批：P2 收尾 + 全局会话中心（已完成）

| 项 | 交付物 | 完成标准 | 状态 |
| --- | --- | --- | --- |
| SSH-P2-07 有界输入 | 独立有界输入队列（16KiB × 64 块 ≈ 1MiB）+ 专职 channel writer task；`ssh_write` 分块入队并在队列满时向调用方背压 | 大粘贴不再阻塞命令循环（Close/Resize/SFTP 控制即时响应），集成测试用“服务端拒读 + 8MiB 粘贴 + Close”验证 | ✅ |
| SSH-P2-08 转发回收 | 子连接收进每规则 JoinSet（listener 结束即 abort 全部隧道）；panic watcher 在监听任务异常退出时发 `ForwardListenerDied` | stop 规则后隧道 socket 关闭、端口立即可重绑；mock server 支持 direct-tcpip 并挂住通道 | ✅ |
| SSH-P2-09 本地路径校验 | `sftp_register_local_root` 允许根注册（canonicalize）；upload/download 校验绝对路径、无 `..`、规范解析（穿透 symlink 与未存在尾巴）后必须落在允许根内；SftpPanel 每次对话框选路径后注册父目录 | 渲染层被注入时不能读/写任意本地文件；单测覆盖相对路径/`..`/根外/symlink 逃逸 | ✅ |
| SSH-P2-05 命令加固 | `formatSshCommand`/`quoteSshArg`：字段过白名单后裸拼，非法字段拒绝渲染返回 null；TaskSshPanel 接入 `findSshConnectionIssue`（失败禁用入口并提示） | 复制文本永远不含未校验的 API 字段 | ✅ |
| posix-rename 原子覆盖 | 覆盖提交先尝试 `posix-rename@openssh.com`（独立 RawSftpSession 通道），不支持时回落 remove+rename | mock server 可开关该扩展；集成测试断言扩展路径被实际使用 | ✅ |
| 旧版 VS Code key 清理 | 撤销远端改用 awk 按注释末字段精确匹配（裸 marker 与 `marker:<suffix>` 一次清除，不伤及其他 key）；本地清理命令删除旧 `easyconsole_vscode_ed25519` 文件并移除引用它的 config 块；设置页提供一次性“清理旧版共享密钥” | 旧版安装的共享 key 可被发现、本地清理；远端条目随对应主机撤销清除 | ✅（远端 awk 路径需真机验证） |
| SSH-P2-11 全局会话中心 | `use-ssh-workspace` store + `SshWorkspaceProvider`/`SshWorkspaceGate` 挂载于 AppRoot；`AppSshTerminalDialog` 变为消费全局 store 的单例视口；TasksPage/TaskSshPanel/TerminalDialog 改走 workspace | 路由切换不再杀会话；登出自动关闭全部会话并重置状态；弹窗最小化/恢复、关闭确认、弹独立窗口行为保留 | ✅ |

### Phase 1：可靠性和认证能力（2-4 个迭代）

目标：从“可用终端”升级为可管理的 SSH 工作区。

1. **认证扩展**：SSH Agent、keyboard-interactive、证书认证、私钥 passphrase 对话框和平台密钥链引用。
2. **主机配置档案**：Host Profile 保存主机、端口、用户、认证引用、标签和备注；支持导入 OpenSSH config 与 known_hosts。
3. **跳板和代理**：实现 `ProxyJump`/`-W` 等受控链路，展示每一跳状态，限制目标和凭据暴露。
4. **自动重连**：指数退避、最大次数、手动重连、网络恢复提示；保留滚动历史，但不自动重放未知输入。
5. **SFTP 传输队列**：递归目录、断点续传、校验和、并发上限、冲突策略、暂停/恢复和失败重试。
6. **端口转发完善**：实现 `-R`，跟踪 listener 和子连接，提供规则诊断与自动清理。
7. **全局会话中心**：从 AppShell 管理会话、标签、连接阶段、转发和传输，页面卸载不再丢失连接。
8. **连接诊断**：将 DNS、TCP、握手、主机密钥、认证、PTY 分段耗时写入本地运行日志，默认脱敏。

### Phase 2：产品化工作区（1-2 个季度）

目标：提高重复运维工作的效率，同时保持安全和可审计。

- 工作区、分屏、会话收藏、主机分组和最近连接。
- 命令片段、参数模板、批量发送和危险命令确认。
- SFTP 远程预览、编辑、拖放、批量重命名和本地/远端差异查看。
- 终端录制加密、索引、回放和按会话导出。
- SSH 审计时间线、脱敏诊断包、连接失败统计和传输指标。
- 管理员策略：主机 allowlist、算法策略、本地绑定策略、明文传输禁用策略。
- 在有可信 relay、鉴权、审计和速率限制的前提下，单独评估浏览器 WebSSH；不能把 Tauri 本地能力直接复制到浏览器。

## 8. 测试和验收计划

### 8.1 单元测试

- 请求解析：默认端口、端口范围、用户名/主机校验、认证模式、keepalive `0`。
- 凭据边界：密码不出现在 URL、普通设置 JSON、run log 和错误字符串。
- 主机密钥：首次未知、匹配、变化、拒绝、超时、并发写入不丢记录。
- 会话事件：早到事件、重复序列号、窗口隔离、关闭时 flush。
- SFTP：路径解析、冲突策略、取消状态、`.part` 清理、原子提交。
- 转发：loopback 校验、端口冲突、规则停止、listener 异常回收、SOCKS5 错误码。
- 历史记录：按设置限制条目数、并发读改写和清理。

### 8.2 Native 集成测试

使用本地临时 SSH server 或测试用 `russh` server，覆盖：

1. 密码和私钥认证成功、错误密码、错误密钥、passphrase 错误。
2. 主机密钥首次确认、指纹变化、连接超时和认证超时。
3. PTY resize、UTF-8 分片、大量输出、网络中断和重连。
4. 单文件和大文件 SFTP 上传/下载、取消、断开、恢复和校验。
5. 本地、动态、远程端口转发及规则/子连接清理。
6. 多窗口 owner 隔离和窗口强制关闭后的资源回收。

### 8.3 UI 和设备测试

- 多标签切换、最小化、弹出窗口、关闭确认和焦点恢复。
- 语言切换不杀死活跃会话，终端搜索和滚动跟随状态稳定。
- SFTP 覆盖确认、取消、重试、错误提示和本地文件夹打开。
- Windows、macOS、Linux 桌面终端启动；Android/iOS 移动键盘和 Ctrl 组合键。
- 键盘导航、屏幕阅读器标签、主机密钥 alertdialog 焦点陷阱和状态文本。

### 8.4 性能与安全门槛

建议在发布前固定以下指标：

- 终端输出高峰期间 UI 主线程不持续占满，事件批量和背压有可观测计数。
- 1 GB 文件传输不会把完整文件读入渲染层内存。
- 取消操作在可控 I/O 下 2 秒内进入最终状态；会话断开时所有子任务最终退出。
- 所有 session、transfer、forward 在关闭后从 registry 消失。
- 静态扫描和测试确认密钥、密码、passphrase 不出现在 URL、日志和诊断包。
- 主机密钥变化绝不自动接受；远程 `authorized_keys` 修改必须可追踪和撤销。

## 9. 发布和回滚策略

1. Phase 0 先以桌面实验室环境灰度，默认关闭远程转发自动启动和 VS Code 远端写 key。
2. 新的认证方式、跳板和 `-R` 使用独立 feature flag，不与现有密码连接路径同时大范围切换。
3. SFTP 断点续传启用前，先发布只读恢复索引和清理工具，避免旧版本留下的 `.part` 被误当作完整文件。
4. 主机密钥格式迁移必须保留旧 JSON 读取能力，导入失败不能覆盖原文件。
5. 每次版本发布记录 SSH 协议变更、Native sidecar 版本、迁移结果和已知限制。
6. 出现会话泄漏、凭据暴露、主机密钥误接受或文件覆盖问题时，优先关闭对应 feature flag，再修复数据和资源清理。

## 10. 当前验证记录和限制

第二轮迭代（P2 收尾 + 全局会话中心）完成后，基于当前工作树已执行的验证：

- `npm.cmd run typecheck` / `npm.cmd run typecheck:tools`
- `npm.cmd run test`：80 个文件 463 项（含新增：命令格式化/校验、workspace store、全局会话中心卸载保持与登出清理等用例）
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml`：30 项 Rust 单元测试 + `tests/ssh_integration.rs` 16 项 SSH 集成测试（本地 mock SSH server；新增大粘贴阻塞、转发隧道回收、posix-rename 原子覆盖三项）
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `npm.cmd run build:desktop`
- `npm.cmd run lint`：通过，上限保持 49（只降不升）

首轮迭代（Phase 0 止血闭环）的验证记录：

- `npm.cmd run typecheck` / `npm.cmd run typecheck:tools`
- `npm.cmd run test`（含新增：解析器、移动端 Ctrl 输入、SFTP 取消态、Web 密码不持久化等用例）
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml`：25 项 Rust 单元测试 + `tests/ssh_integration.rs` 13 项 SSH 集成测试（本地 mock SSH server）
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `npm.cmd run lint`：通过，上限保持 49（只降不升）

集成测试说明：

- 运行方式：`cargo test --manifest-path src-tauri/Cargo.toml --features ssh-test-internals`。
  该 feature 仅启用测试基建（本地 mock SSH server），不进入发布产物。
- 测试目标使用 `harness = false` 的自定义 main：每个测试在独立子进程中运行
  （EC_TEST_SINGLE 环境变量由父进程注入），避免 russh 会话的残留状态互相干扰。
  `build.rs` 会为测试可执行文件嵌入 comctl32 v6 manifest（Windows 上 tao/muda
  需要，否则测试进程加载即崩）。
- 已知偶发问题：russh-sftp 2.3 在回环 client/server 组合下极少数情况下会错误
  分发一次响应，导致单个传输挂起直至超时。harness 对失败的测试会在新进程中
  重试两次；如需排查，可用 `EC_TEST_DEBUG=1` 打开 russh 报文日志。

本轮实现留存的已知限制（下一迭代候选）：

- SSH-P2-10：自定义 known host 仍为指纹 JSON，不支持 OpenSSH `known_hosts`
  导入（hashed hostname、`[host]:port`、`@cert-authority`/`@revoked` marker）。
- 旧版共享 VS Code key 的远端 `authorized_keys` 条目由 awk 按注释末字段精确
  匹配清除，但该路径无法在 mock server 上自动化，需要在真实主机上验证。
- 全局会话中心目前覆盖应用内多标签；弹出独立窗口（`/ssh-terminal`）仍是
  独立会话，不进入同一会话列表。
- 全部已完成流程仍缺少真实 SSH 主机与真实移动设备的回归（见下）。

尚未完成的验证：

- 没有使用真实 SSH 主机或真实账号执行连接、SFTP、端口转发和 VS Code 撤销流程。
- 没有在真实 Android/iOS 设备上回归移动键盘、Ctrl 组合键和窗口生命周期。
- 没有执行生产桌面安装包、签名、公证和升级迁移验证。

## 11. 迭代建议

首轮迭代（已完成）只完成以下闭环，并以测试结果作为合并门槛：

1. 实现统一的请求解析器，接通端口、尺寸、认证、超时、keepalive 和历史上限设置。
2. 引入 Native `SessionManager` 的 owner 校验与统一清理，先覆盖窗口关闭、路由卸载和登出。
3. 修复 SFTP 取消、临时文件和上传原子提交，加入本地测试 SSH server。
4. 移除带密码 URL fallback，禁止 Web 默认持久化 SSH 密码。
5. 给 VS Code key 安装增加 fingerprint、标记、撤销和失败清理。
6. 增加跨平台和移动端输入回归测试，再决定是否开启自动重连和更高阶功能。

第二批迭代（已完成）按 §7.1 收尾了除 SSH-P2-10 外的全部 P2，并把会话提升为全局会话中心。

下一批建议（优先级从高到低）：

1. 真实主机验证：连接、SFTP 上传/下载/覆盖、端口转发、VS Code 撤销与旧版 key 清理（awk 路径）。
2. SSH-P2-10：OpenSSH `known_hosts` 导入（解析 hashed hostname 与 `[host]:port`、存储结构升级带备份、设置页导入 UI）。
3. 自动重连与 SFTP 传输队列（Phase 1 第 4、5 项），两者都依赖现在稳定的会话与传输生命周期。
4. 认证扩展（SSH Agent / keyboard-interactive / 证书）与 Host Profile，先统一 `AuthMethod`/`AuthProfile` 契约再扩展。
