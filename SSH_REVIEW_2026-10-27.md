# EasyConsole 内置 SSH 审阅（2026-10-27）

> 审阅日期：2026-10-27
> 审阅范围：当前工作区（含未提交改动）中的内置 SSH：`src-tauri/src/ssh/*`、`lib.rs` 中的 SSH 接线与窗口事件、`src/lib/runtime.ts` 的 SSH 适配层、`SshTerminalTab`、SSH 工作区、SFTP 面板、`ssh-info.ts`、`capabilities/default.json`
> 审阅性质：静态代码审阅加现有自动化测试；**没有修改产品源码**，也没有连接真实 SSH 主机
> 相关文档：[SSH_DEVELOPMENT.md](SSH_DEVELOPMENT.md)（SSH 开发基线与路线图）、[PROJECT_REVIEW_2026-10-25.md](PROJECT_REVIEW_2026-10-25.md)

问题编号接着 [SSH_DEVELOPMENT.md](SSH_DEVELOPMENT.md) 第 5 节往下排，级别定义沿用该文档：

- **P1**：核心流程出错、安全承诺失真或严重资源问题。
- **P2**：有绕过方式，但影响稳定性、效率或维护成本。
- **P3**：体验和长期演进优化。

## 1. 结论摘要

SSH 子系统的工程底子很好，前两轮 P1/P2 的止血项基本都落地了，包括：

- 会话归属按窗口校验。
- 事件只发给所属窗口。
- 主机密钥首次信任，校验失败时默认拒绝。
- 端口转发只能绑定回环地址。
- SFTP 本地路径必须落在用户选过的目录里。
- 上传先写临时文件再原子改名。
- 输入队列有上限。
- 有本地模拟 SSH 服务器做集成测试。

本轮新发现 **3 个 P1**，修复成本都很低：

1. **SSH-P1-06**：端口转发绑定失败后，这条规则在本会话里再也启动不了，前端还把错误吞掉了。
2. **SSH-P1-07**：撤销 VS Code 免密登录的脚本，在磁盘满等情况下可能清空远端 `authorized_keys`，删除范围也比文档承诺的大。
3. **SSH-P1-08**：终端开了 `convertEol: true`，vim、htop、tmux 等全屏程序会显示错乱。

另外还有 4 个 P2（页面重新加载留下孤儿会话、连接中途无法取消、依赖服务端消息顺序、主机密钥与实例回收冲突）和 13 个 P3。

第 6 节列出了 10 个建议新增的功能。这些功能结合了"GPU 云实例控制台"这个场景，优先级最高的是：

- 一键访问远端 Web 服务（Jupyter、TensorBoard 等）。
- 持久会话加自动重连。
- SSH 与任务生命周期联动。
- 主机密钥变更就地处理。

## 2. 验证结果与范围限制

| 检查 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --features ssh-test-internals --lib ssh::` | 29 项全部通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --features ssh-test-internals --test ssh_integration` | 16 项全部通过 |
| `vitest`：ssh-info、ssh-terminal-input、ssh-terminal-follow、SshWorkspaceProvider、AppSshTerminalDialog、SshTerminalTab.i18n、runtime | 7 个文件、51 项全部通过 |

范围限制：

- 本轮没有连接真实 SSH 主机（OpenSSH、Dropbear 等），也没有在真实服务器上执行 VS Code 撤销脚本。
- SSH-P1-08 和 SSH-P2-14 的结论基于协议、终端语义和代码推断，修复时应在真实主机上复测。
- 现有集成测试没有覆盖以下场景：
  - 端口被占用时绑定失败。
  - 服务端先发 EOF 再发退出码。
  - 连接途中关闭。
  - 页面重新加载。

## 3. 架构速览

分层和事件模型见 [SSH_DEVELOPMENT.md](SSH_DEVELOPMENT.md) 第 2 节，本轮审阅确认现状与该节一致。数据流如下：

```text
SshTerminalTab ──invoke──▶ open_ssh_session ──spawn──▶ run_russh_session
   ▲   │ ssh_write ─────▶ 有界输入队列 ─▶ 专职写入任务 ─▶ channel.data
   │   │ ssh_resize/close/sftp_*/port_forward ─▶ 无界命令队列 ─▶ 会话主循环 select!
   └── ssh-session-event（emit_to 所属窗口）◀── 输出(16ms/8KiB 合并) / status / sftp-progress / port-forward-status
```

关键状态的归属：

| 状态 | 所在位置 |
| --- | --- |
| 会话注册表（含所属窗口、SFTP 允许目录） | `SshSessionState` |
| 待确认的主机密钥提示 | 全局 `OnceLock` |
| 弹出窗口的连接请求 | `PendingSshWindows` |
| SFTP 传输、端口转发监听 | 会话主循环的局部变量 |

## 4. 做得好的地方（应保留的约束）

1. **IPC 归属校验**：`with_owned_entry` 校验调用窗口，跨窗口读写、关闭会话都会被拒绝，并有集成测试覆盖。
2. **事件定向**：后端用 `emit_to`，前端监听也指定了同一窗口作为目标，避免终端输出广播到其他窗口。
3. **主机密钥默认拒绝**：
   - 首次连接要确认，超时视为拒绝。
   - 指纹变化直接拒绝。
   - VS Code 这类无交互流程不弹提示，直接拒绝未知主机。
   - `known-ssh-hosts.json` 的读改写有锁，文件损坏时回退到备份，仍然是默认拒绝。
4. **超时分层**：TCP 连接、握手（包含 120 秒的主机密钥确认）、认证（至少 15 秒）各有各的预算；`keepalive_max = 3` 能识别已经断掉的连接。
5. **字节流正确性**：`drain_utf8` 会保留被拆到两个数据块里的中文字符，不会出现乱码替换符。
6. **SFTP**：
   - 上传先写 `.ecpart-<id>` 临时文件，再原子提交，优先用 `posix-rename`。
   - 下载用 4 个句柄并行读不同区间，先写 `.part`，完成后再改名。
   - 取消时先设标志再中止任务，命令的返回值由主循环统一给出。
7. **端口转发**：只允许回环地址；子连接挂在每条规则的 `JoinSet` 上，规则一停，所有隧道一起关闭。
8. **凭据边界**：
   - 弹出窗口的连接请求只能被目标窗口读取一次。
   - 窗口销毁时会清掉还没读取的请求。
   - 连接历史不记录密码。
9. **系统终端参数**：主机、用户名、端口都过白名单；Windows Terminal 的标题会过滤 `;` 等字符。

## 5. 问题清单

### 5.1 总表

| ID | 级别 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| SSH-P1-06 | P1 | 端口转发绑定失败后规则卡死，手动启动的错误被吞掉 | [session.rs:1085](src-tauri/src/ssh/session.rs:1085)、[SshTerminalTab.tsx:983](src/components/tasks/SshTerminalTab.tsx:983) |
| SSH-P1-07 | P1 | VS Code 撤销脚本可能清空 `authorized_keys`，删除范围过大 | [vscode.rs:748](src-tauri/src/ssh/vscode.rs:748) |
| SSH-P1-08 | P1 | 终端 `convertEol: true` 导致全屏程序显示错乱 | [SshTerminalTab.tsx:287](src/components/tasks/SshTerminalTab.tsx:287) |
| SSH-P2-12 | P2 | 页面重新加载后，原生会话和转发监听变成孤儿 | [lib.rs:1666](src-tauri/src/lib.rs:1666) |
| SSH-P2-13 | P2 | 连接、握手、认证阶段收到的关闭请求不生效 | [session.rs:633](src-tauri/src/ssh/session.rs:633) |
| SSH-P2-14 | P2 | 依赖服务端"先发退出码、后发 EOF"的顺序 | [vscode.rs:668](src-tauri/src/ssh/vscode.rs:668)、[session.rs:1288](src-tauri/src/ssh/session.rs:1288) |
| SSH-P2-15 | P2 | 主机密钥记录与实例回收冲突；VS Code 又让 OpenSSH 首次信任一遍 | [host_key.rs:99](src-tauri/src/ssh/host_key.rs:99)、[vscode.rs:499](src-tauri/src/ssh/vscode.rs:499) |
| SSH-P3-01 | P3 | SOCKS5 在通道打开之前就回复成功 | [port_forward.rs:155](src-tauri/src/ssh/port_forward.rs:155) |
| SSH-P3-02 | P3 | 终端输出没有流控 | [session.rs:1249](src-tauri/src/ssh/session.rs:1249) |
| SSH-P3-03 | P3 | GPU 采样超时后不关闭通道 | [gpu.rs:34](src-tauri/src/ssh/gpu.rs:34) |
| SSH-P3-04 | P3 | 密码和口令被 `trim()` | [session.rs:575](src-tauri/src/ssh/session.rs:575) 等 |
| SSH-P3-05 | P3 | `ssh_write` 改为异步后不保证执行顺序 | [session.rs:1462](src-tauri/src/ssh/session.rs:1462) |
| SSH-P3-06 | P3 | SFTP 校验过的规范路径没有被使用；`.part` 路径没有校验 | [sftp.rs:769](src-tauri/src/ssh/sftp.rs:769) |
| SSH-P3-07 | P3 | `confirm_known_host` 不校验调用窗口 | [host_key.rs:297](src-tauri/src/ssh/host_key.rs:297) |
| SSH-P3-08 | P3 | 并发传输仍共用同一个 `SftpSession` | [sftp.rs:378](src-tauri/src/ssh/sftp.rs:378) |
| SSH-P3-09 | P3 | RSA 签名算法写死；不支持 keyboard-interactive 认证 | [session.rs:690](src-tauri/src/ssh/session.rs:690) |
| SSH-P3-10 | P3 | `ssh-*` 弹出窗口拿到完整的能力集 | [default.json](src-tauri/capabilities/default.json) |
| SSH-P3-11 | P3 | 系统终端的 ssh 参数没有在目标前加 `--` | [terminal_spawn.rs:27](src-tauri/src/ssh/terminal_spawn.rs:27) |
| SSH-P3-12 | P3 | 说明注释挂错了函数 | [session.rs:1447](src-tauri/src/ssh/session.rs:1447) |
| SSH-P3-13 | P3 | `SshConnectionRequest` 自动派生 `Debug`，打印时会带出密码 | [session.rs:38](src-tauri/src/ssh/session.rs:38) |

### 5.2 P1：建议本迭代修复

#### SSH-P1-06：端口转发绑定失败后规则卡死

**现象**

- `StartPortForward` 把监听任务放进后台后，立即返回成功（[session.rs:1219](src-tauri/src/ssh/session.rs:1219)），并把规则写进 `port_forward_handles`（[session.rs:1197](src-tauri/src/ssh/session.rs:1197)）。
- 后台任务绑定本地端口失败时，只发一条 `active:false` 事件就 `return` 了（[session.rs:1094-1110](src-tauri/src/ssh/session.rs:1094)），没有从这个映射里移除规则。
- 守护任务只在 panic 时才回收规则。

**影响**

- 规则留在映射里，再次启动会被当成"已在运行"拒绝。界面上显示的是"已停止"和"启动"按钮，所以用户也不会去点"停止"。
- 手动启动按钮的 `.catch(() => {})`（[SshTerminalTab.tsx:983](src/components/tasks/SshTerminalTab.tsx:983)）把这个错误吞掉了，用户点了没有任何反应。
- 唯一的出路是关闭整个会话。

**触发**

- 本地端口已被占用（最常见）。
- 两个标签页自动启动同一条没有限定主机的规则。
- 页面重新加载后，旧监听还在（见 SSH-P2-12）。

**修复建议**

1. 在命令处理里先 `await TcpListener::bind`（耗时可以忽略），失败就直接返回 `Err`，不写入映射；成功后再把已经绑定好的监听交给后台任务。
2. 响应里带回实际绑定到的端口。这样就能支持 `local_port = 0`，由系统自动分配空闲端口，这也是功能 F-01 的前提。
3. 前端手动启动失败时，把错误写进 `portForwardStatuses`，和自动启动的处理方式一致。

**应补测试**：先占用一个端口，启动规则，断言返回错误；释放端口后用同一个规则 id 重新启动，断言成功。

#### SSH-P1-07：VS Code 撤销脚本可能清空 `authorized_keys`，删除范围过大

**现象**：远端撤销脚本（[vscode.rs:748-750](src-tauri/src/ssh/vscode.rs:748)）的核心是：

```sh
t=$(mktemp); awk '...' "$f" > "$t" || true; cat "$t" > "$f"; rm -f "$t"; chmod 600 "$f"
```

**问题 1：可能把文件清空**

- 磁盘满（训练机上常见）时，`awk` 写入 `$t` 会失败或只写了一半。`|| true` 吞掉了这个错误，接着 `cat` 用残缺的内容覆盖 `authorized_keys`。
- `mktemp` 失败时 `t` 为空，`cat "" > "$f"` 会先把文件截成空的，再报错。
- 两种情况都会把远端其他公钥一起删掉（包括平台注入的 key），用户可能被锁在外面。
- 脚本最后一条命令是 `chmod`，退出码总是 0，所以客户端会报"撤销成功"。

**问题 2：删除范围过大**

- 过滤条件是 `$NF !~ /^easyconsole-vscode:/`，会删掉这个账号下所有 EasyConsole 写入的 key，包括其他任务的，以及同事在别的机器上装的（同一个任务在不同机器上的注释后缀相同）。
- 这和 [vscode.rs:20-22](src-tauri/src/ssh/vscode.rs:20) 的注释、以及 SSH_DEVELOPMENT 第 7.1 节里"不伤及其他 key"的说法都不一致。

**修复建议**

1. 按本机公钥的类型加 base64 内容精确匹配，而不是按注释后缀匹配；注释只作为辅助展示。本地公钥丢失时，退回到按注释后缀匹配，但要先把将要删除的行列给用户确认。
2. 改成失败即停、原子替换的写法，例如：

   ```sh
   set -e; umask 077; f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0
   t=$(mktemp "$HOME/.ssh/.authorized_keys.XXXXXX")
   trap 'rm -f "$t"' EXIT
   awk -v k="$BLOB" '{ for (i = 1; i <= NF; i++) if ($i == k) next; print }' "$f" > "$t"
   chmod 600 "$t"; mv -f "$t" "$f"
   ```

   临时文件和目标放在同一目录，保证 `mv` 是原子操作。任何一步失败都会让脚本以非 0 退出，原文件保持不变。
3. 这条路径本来就被列为"需要真机验证"（SSH_DEVELOPMENT 第 10 节）。建议在模拟服务器上加一个 exec 处理器，用真实的 `sh` 跑这段脚本（Windows CI 可以跳过），至少覆盖"只删除本机那一行"和"写入失败时原文件不变"两个场景。

#### SSH-P1-08：终端开了 `convertEol: true`

**现象**：[SshTerminalTab.tsx:287](src/components/tasks/SshTerminalTab.tsx:287) 开启了 `convertEol`，xterm.js 会把每个 `\n` 当成 `\r\n` 处理。xterm.js 文档说明，这个选项只适用于不经过 PTY 的数据源；经过 PTY 时，换行转换由远端终端驱动负责。

**影响**

- 会话请求了 PTY。全屏程序进入 raw 模式后会关闭换行转换，并按 terminfo 用单独的 `\n` 表示"光标下移一行"（`xterm-256color` 的 `cud1=^J`）。
- 开着 `convertEol` 时，光标还会额外回到行首，导致 vim、htop、tmux、less、nvtop 等程序的画面错位。
- 普通 shell 输出本来就带 `\r\n`，所以平时看不出问题。

**修复建议**：改成 `convertEol: false`。本地写入的状态文本已经使用 `writeln` 或显式的 `\r\n`，历史回放也是按 `\r\n` 拼接的，不受影响。修复后在真实主机上用 vim、htop、tmux 分屏回归一遍。

### 5.3 P2：建议下一迭代修复

#### SSH-P2-12：页面重新加载后留下孤儿会话

**现象**

- 只有标签以 `ssh-` 开头的窗口在销毁时会调用 `close_sessions_for_window`（[lib.rs:1666-1676](src-tauri/src/lib.rs:1666)）。
- 主窗口重新加载时，React 的清理逻辑不会执行，后端也没有对应的清理。会触发重新加载的地方有：导入带密钥的备份（[SettingsPage.tsx:1170](src/pages/SettingsPage.tsx:1170)）、ScheduledTasksPage 和 TaskTemplatesPage 错误页上的"重新加载"按钮，以及开发时的热重载和 F5。

**影响**

- 原生会话靠 keepalive 一直存活到应用退出，持续占用远端资源。
- 转发监听继续占着本地端口，重新加载后自动启动同一条规则会撞上 SSH-P1-06。
- 孤儿会话的输出会进入前端的早到事件缓冲，每个会话最多 64 条。量不大，但属于泄漏。

**修复建议**：在 Rust 侧注册 `Builder::on_page_load`，在 `PageLoadEvent::Started` 时对这个窗口调用 `close_sessions_for_window`。窗口首次加载时也会触发，但那时没有会话，没有副作用。HashRouter 的路由切换不会触发页面加载，不会误伤正常使用。

#### SSH-P2-13：连接、握手、认证阶段无法取消

**现象**：命令队列 `rx` 要等 shell 打开、进入主循环（[session.rs:832](src-tauri/src/ssh/session.rs:832)）之后才开始读取。在这之前的 TCP 连接、握手（含最长 120 秒的主机密钥确认）、认证、PTY 和 shell 请求阶段，`ssh_close` 和窗口关闭发出的关闭命令只会排队。

**影响**

- 用户在"连接中"关掉标签页后，后台照样完成认证、打开 shell，然后才关闭。
- 如果正在等待主机密钥确认，会一直挂到 120 秒超时。
- 这个问题也会妨碍后续"自动重连"（F-02）实现干净的取消。

**修复建议**：在 `SshSessionEntry` 里放一个取消信号（`watch` 或取消令牌），由 `ssh_close` 和 `close_sessions_for_window` 触发。连接前的每个阶段都和这个信号一起放进 `tokio::select!`，被取消时同时清掉对应的主机密钥提示。

#### SSH-P2-14：依赖服务端"先发退出码、后发 EOF"的顺序

**现象**

- `exec_remote_command`（[vscode.rs:668](src-tauri/src/ssh/vscode.rs:668)）收到 `Eof` 就停止读取，随后用 `exit_status.unwrap_or(1)` 判断成败。
- 协议没有规定 `exit-status` 和 EOF 的先后顺序，实际顺序取决于服务端实现和时机，例如子进程先关闭 stdout 再退出。
- 一旦 EOF 先到，就拿不到退出码，成功的 VS Code 配置或撤销会被报告为失败。
- 会话主循环（[session.rs:1288](src-tauri/src/ssh/session.rs:1288)）也是收到 EOF 就退出，可能丢掉"进程退出状态码"的提示。
- 测试服务器固定先发退出码、后发 EOF（[test_server.rs:167-172](src-tauri/src/ssh/test_server.rs:167)），所以测不出来。[gpu.rs](src-tauri/src/ssh/gpu.rs) 的写法（一直读到 `wait()` 返回 `None`）是对的。

**修复建议**

- `exec_remote_command` 改成一直读到 `Close` 或 `None` 为止。
- 主循环收到 EOF 时只标记"远端输出已结束"，等到 `Close` 再退出。
- 给测试服务器加一个"先发 EOF"的开关，并补一个对应的测试。

#### SSH-P2-15：主机密钥记录与实例回收冲突

**现象**

- 已知主机按"主机:端口"只存一个 SHA-256 指纹。云平台回收实例后，同一个地址和端口会分配给新任务；新容器的主机密钥不同，连接会被当成"密钥不符"直接拒绝。错误提示让用户去设置页删除记录（[host_key.rs:99-107](src-tauri/src/ssh/host_key.rs:99)）。
- VS Code 配置块写的是 `StrictHostKeyChecking accept-new`（[vscode.rs:499](src-tauri/src/ssh/vscode.rs:499)），没有使用应用里已经确认过的指纹，等于让 OpenSSH 再首次信任一遍。地址被回收后，用户的 `~/.ssh/known_hosts` 也会报 "REMOTE HOST IDENTIFICATION HAS CHANGED"。

**影响**：在这个产品里，这是会频繁出现的正常场景，而不是罕见的攻击信号。用户会被训练成看到警告就去删记录，警告也就失去了意义。

**修复建议**：见功能 F-04。这会修改 SSH_DEVELOPMENT 第 6.3 节"必须在设置中删除旧记录"的策略，建议同步更新该节。

### 5.4 P3：优化项

| ID | 问题与影响 | 建议 |
| --- | --- | --- |
| SSH-P3-01 | 在 `channel_open_direct_tcpip` 之前就回复 SOCKS5 成功（[port_forward.rs:155](src-tauri/src/ssh/port_forward.rs:155)），目标连不上时客户端看到的是"连接成功后马上断开"；不管客户端支持哪些认证方式都回复"免认证" | 把握手拆成"读请求"和"回复结果"两步，通道打开后再回复成功，失败时回复 REP=1/4/5；客户端没有提供 `0x00` 方法时回复 `0xFF` |
| SSH-P3-02 | 输出不限流地推给页面，`cat` 一个大文件或运行 `yes` 时界面可能卡住（SSH_DEVELOPMENT 第 8.4 节把这一点列为发布门槛） | 给每个事件设上限（例如 64KiB）；前端按 xterm.js 推荐的水位线做流控，超过水位时通知后端暂停读取，靠 SSH 窗口反压 |
| SSH-P3-03 | GPU 采样 5 秒超时后通道没有关闭（[gpu.rs:34](src-tauri/src/ssh/gpu.rs:34)）。`nvidia-smi` 卡住时，每 60 秒（[IdleInstanceWatcher.tsx:18](src/components/IdleInstanceWatcher.tsx:18)）就多占一个通道，达到 sshd 每个连接 10 个会话的默认上限后，SFTP 和端口转发都打不开 | 超时后显式关闭通道；同一个会话同时只允许一个采样在跑 |
| SSH-P3-04 | 密码和私钥口令被 `trim()`（[session.rs:575](src-tauri/src/ssh/session.rs:575)、[vscode.rs:123](src-tauri/src/ssh/vscode.rs:123)、[ssh-info.ts:150](src/lib/ssh-info.ts:150)），首尾带空格的凭据会认证失败 | 只用 `trim()` 判断是否为空，传原值 |
| SSH-P3-05 | `ssh_write` 是异步命令，每次调用都会单独起一个任务，执行顺序不再由消息到达顺序保证。人手打字几乎不会遇到，高频输入（按住按键、鼠标上报）理论上可能乱序 | 在 `runtime.ts` 里按会话串行发送（例如用 Promise 链） |
| SSH-P3-06 | `ensure_sftp_local_path_allowed` 返回的规范路径被丢弃，传输时用的仍是原始字符串（[sftp.rs:769](src-tauri/src/ssh/sftp.rs:769)、[sftp.rs:796](src-tauri/src/ssh/sftp.rs:796)）；下载的临时文件 `{local}.part` 没有经过校验（[session.rs:932](src-tauri/src/ssh/session.rs:932)） | 把规范路径传给传输任务；对 `.part` 路径也做一次允许目录校验 |
| SSH-P3-07 | `confirm_known_host` 不校验调用窗口（[host_key.rs:297](src-tauri/src/ssh/host_key.rs:297)），和其他命令的归属校验不一致。提示 id 是 UUID v4，并且只发给所属窗口，实际风险很低 | 命令接收 `window` 参数，比对 `PendingHostKeyPrompt.window_label` |
| SSH-P3-08 | 每次传输结束都会重置共享的 SFTP 会话，用来规避 russh-sftp 的竞争（[sftp.rs:378](src-tauri/src/ssh/sftp.rs:378)），但同时进行的传输仍拿着同一个会话 | 每次传输独占一个 SFTP 通道；列目录、改名等小操作继续共用 |
| SSH-P3-09 | RSA 密钥固定用 `HashAlg::Sha256`，没有用 `best_supported_rsa_hash()` 协商；服务端只开 PAM（keyboard-interactive）时，密码模式会失败 | 先接入 keyboard-interactive（把密码作为第一个提示的回答），这是 SSH_DEVELOPMENT Phase 1 第 1 项的一部分，建议提前 |
| SSH-P3-10 | `ssh-*` 弹出窗口和主窗口拿到同样完整的能力集（任意 HTTP、写文件、更新、进程、自启动等） | 为 `ssh-*` 窗口单独建一个最小能力集 |
| SSH-P3-11 | `validate_host` 允许以 `-` 开头，而系统终端的 ssh 参数里，目标前没有 `--`（[terminal_spawn.rs:27](src-tauri/src/ssh/terminal_spawn.rs:27)） | 拒绝以 `-` 开头的主机和用户名，并在目标前加 `--` |
| SSH-P3-12 | "写入终端输入"的说明注释挂在 `ssh_gpu_utilization` 上（[session.rs:1447](src-tauri/src/ssh/session.rs:1447)） | 移回 `ssh_write` 上方 |
| SSH-P3-13 | `SshConnectionRequest` 自动派生了 `Debug`，打印时会把密码一起输出，目前没有打印它的地方 | 手写 `Debug`，把 `password` 脱敏 |

## 6. 建议新增的功能

[SSH_DEVELOPMENT.md](SSH_DEVELOPMENT.md) 第 7 节的路线图已经覆盖了 Agent、证书、Host Profile、ProxyJump、`-R`、SFTP 队列和断点续传、分屏、命令片段、审计等。下面的功能**主要是路线图之外**、结合"GPU 云实例控制台"场景的补充；与路线图重叠的部分会注明。

工作量：S 不超过 2 天，M 约 3 到 7 天，L 超过 1 周。

### 6.1 总表

| ID | 功能 | 优先级 | 工作量 | 依赖 |
| --- | --- | --- | --- | --- |
| F-01 | 一键访问远端 Web 服务（Jupyter、TensorBoard、Gradio 等） | 高 | M | SSH-P1-06 |
| F-02 | 持久会话（tmux/screen）加自动重连 | 高 | M | SSH-P2-13 |
| F-03 | SSH 与任务生命周期联动 | 高 | S～M | — |
| F-04 | 主机密钥变更就地处理，按任务区分记录 | 高 | M | — |
| F-05 | 中文和 emoji 字符宽度正确（Unicode 11） | 中 | S | — |
| F-06 | 终端状态条：GPU、显存、磁盘、延迟 | 中 | M | SSH-P3-03 |
| F-07 | SFTP 与终端目录联动，拖放上传 | 中 | S～M | — |
| F-08 | CLI/MCP 远程执行与文件传输 | 中 | L | SSH-P2-14 |
| F-09 | trzsz（`trz`/`tsz`）文件传输 | 低 | M | — |
| F-10 | 应用重启后恢复 SSH 工作区 | 低 | M | F-02 |

### 6.2 功能说明

#### F-01：一键访问远端 Web 服务

**场景**：GPU 实例上最常见的操作之一，是在本地浏览器里打开远端的 Jupyter（8888）、TensorBoard（6006）、Gradio 或 SD WebUI（7860）、Streamlit（8501）、ComfyUI（8188）或推理服务的 API（8000）。

现在的做法是：先去设置页建一条全局转发规则，自己挑一个本地端口，再打开浏览器。本地端口被占用时会撞上 SSH-P1-06。

**方案**

1. 终端工具栏加一个"打开服务"菜单，提供常用服务的预设和自定义远端端口。
   - 本地端口用 `0`，由系统分配。依赖 SSH-P1-06 修复后能返回实际绑定的端口。
   - 建立转发后，打开系统浏览器访问 `http://127.0.0.1:<port>`。
   - 这类规则只属于当前会话，不写入设置，随会话关闭一起清理。
2. 识别终端输出里的链接：给 WebLinks 插件加一个自定义处理函数，遇到 `http://localhost:<port>`、`127.0.0.1`、`0.0.0.0` 或实例 IP 加端口的链接时，弹出"转发并打开"，并保留 Jupyter 链接里的 `?token=`。
   - 直接在本地打开这类链接，访问的是用户本机的服务，结果是错的，甚至有风险。所以识别到这类链接时，不能直接打开。
3. 可选：执行一条固定的 `ss -ltnH` 命令列出远端正在监听的端口作为候选，做法和 GPU 采样一样，只读且不拼接用户输入。

**安全**

- 继续只绑定回环地址。
- token 不写进运行日志和连接历史。

#### F-02：持久会话加自动重连

**场景**：训练任务跑在交互式 shell 里，网络抖动、电脑休眠或 SSH 断开都会让 shell 收到挂断信号，把任务杀掉。这是 GPU 用户最常遇到的事故之一。

路线图 Phase 1 第 4 项有"自动重连"，但如果远端会话本身不能持久，重连回来看到的只是一个新的 shell。

**方案**

1. 新增设置"持久会话"，可选：关闭、tmux、screen、自动。
   - 开启后，打开 PTY 时不再请求普通 shell，而是执行一条固定命令：

     ```sh
     command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s ec-<task短ID> || exec "${SHELL:-/bin/sh}" -l
     ```

   - 远端没有 tmux 时自动回退到普通 shell，并在状态栏提示。
2. 自动重连：
   - keepalive 判定连接已断开后，进入"重连中"状态，按 1s、2s、5s、10s 退避，最多重试 N 次。
   - 重连复用现有的历史回放逻辑，并重新进入同一个 tmux 会话。
   - 不重放任何未确认的用户输入。
   - 以下情况立即停止重试：认证失败、主机密钥不符、任务已经不在运行（见 F-03）。
3. 交互细节：tmux 的历史不在 xterm 的滚动缓冲里，状态栏要提示"tmux 内翻页用 Ctrl+B ["。不能擅自修改用户的 `tmux.conf`。

#### F-03：SSH 与任务生命周期联动

**场景**：应用已经在轮询任务状态，并在状态变化时发通知，但 SSH 标签页对此一无所知。

**方案**

1. 任务离开"运行中"状态（已释放、已停止、失败）时：
   - 对应的 SSH 标签页显示"实例已释放"。
   - 停止自动重连，关闭这个会话的端口转发。
   - 标签页上显示任务状态徽标（带文字，不能只用颜色区分）。
2. 手动释放任务前，如果还有打开的终端、进行中的 SFTP 传输或在用的转发，在确认框里列出来，例如"2 个终端、1 个上传进行中"。
3. 闲置自动释放加一个本地否决条件：本机有进行中的传输，或者窗口期内有终端输入，就不自动释放。现有判定已经要求网络流量为 0，但代码注释承认流量指标的单位还没有验证过，这一条作为多一层保险。

#### F-04：主机密钥变更就地处理，按任务区分记录

**方案**

1. 已知主机的记录从"主机:端口 → 指纹"升级为结构化记录：完整公钥、密钥算法、指纹、首次信任时间、`task_id`。升级时保留旧格式的读取能力，并先做备份。
2. 指纹不符时，不再让用户去设置页删除，而是直接弹窗，并排显示旧指纹和新指纹。
   - 记录的 `task_id` 与本次不同（地址被回收给了新任务）：说明"该地址此前属于任务 X，现在分配给任务 Y，指纹变化符合预期"，用户确认后替换记录。
   - `task_id` 相同但指纹变了：显示强警告，默认焦点放在"拒绝"上，需要勾选"我已核实"后才能替换。
   - 无论哪种情况，都不能自动接受。这一点与 SSH_DEVELOPMENT 第 6.3 节的原则一致，只是把"去设置页删除"改成了"就地明确确认"。
3. VS Code：既然存了完整公钥，就可以在配置块里写一个由应用管理的 `UserKnownHostsFile`，并把 `StrictHostKeyChecking` 改为 `yes`，彻底去掉 OpenSSH 的第二次首次信任。旧记录只有指纹，没有完整公钥，在用户下次通过应用内 SSH 连接、补齐公钥之前，暂时保持 `accept-new`。
4. 这项可以和 SSH-P2-10（导入 OpenSSH known_hosts）一起做，两者共用升级后的存储结构。

#### F-05：中文和 emoji 字符宽度正确

引入 `@xterm/addon-unicode11`，并设置 `terminal.unicode.activeVersion = "11"`。

xterm.js 默认按 Unicode 6 计算字符宽度，emoji 和部分全角符号会算错，导致 tqdm、rich 进度条以及带 emoji 的日志对不齐。这对中文用户为主的产品收益明显。插件版本要选与 `@xterm/xterm@6` 匹配的版本。

#### F-06：终端状态条

在终端标题栏右侧用小标签显示：

- 每张卡的 GPU 利用率和显存使用：`nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total`。
- 工作目录所在磁盘的占用：`df -P`。磁盘写满是训练机上最常见的故障之一，也是 SSH-P1-07 的触发条件。
- 连接延迟（RTT）和最后一次收到数据的时间。

只在当前激活的标签页上采样，间隔 10 到 15 秒。命令是固定的，同一个会话同时只跑一个采样。采样结果也同时提供给闲置提醒使用。前提是先修复 SSH-P3-03。

#### F-07：SFTP 与终端目录联动，拖放上传

- **"在终端中打开此目录"**：用户主动点击时，向终端发送 `cd -- '<转义后的路径>'`。
- **"SFTP 跟随终端目录"**：
  - 通过 `terminal.parser.registerOscHandler(7, ...)` 解析远端 shell 发出的 OSC 7 目录通知。
  - 远端 shell 默认不一定会发 OSC 7，要提供一段可复制的 `PROMPT_COMMAND` 配置。
- **拖放上传**：使用 Tauri 的拖放事件拿到本地路径，先注册允许目录，再上传到 SFTP 面板的当前目录。路线图 Phase 2 提到的"拖放"可以提前做。
- **复制远端路径**。

#### F-08：CLI/MCP 远程执行与文件传输

项目的定位是"桌面应用加上由它派生的 CLI/MCP 工具"，但 SSH 目前只有桌面应用能用。建议按项目现有的变更约定开放：

- `ec ssh exec <task> -- <cmd>`：默认只预演，加 `--yes` 才真正执行。对应的 MCP 工具 `ssh_exec` 必须带 `confirm: true`。
- 输出默认限制字节数并返回截断信息，有超时，结果写入运行日志并脱敏。
- 主机密钥只读应用已经信任过的记录，CLI 不提供首次信任；也可以通过 `--host-key-fingerprint` 显式传入指纹。
- 凭据走现有的令牌和安全存储，不接受明文参数。
- 第二阶段再做 `ssh_upload` 和 `ssh_download`。

Node 侧需要引入 SSH 库（例如 `ssh2`），并和桌面应用共用已知主机文件。这项依赖 SSH-P2-14 修复退出码的处理。

#### F-09：trzsz 文件传输

国内运维用户习惯 `rz`/`sz`。trzsz 兼容这种用法，能穿过 tmux 和跳板机，并且有现成的 xterm.js 集成。传输的数据经过 base64 编码，所以不受后端按 UTF-8 解码输出的影响。

不建议做原始 ZMODEM：它传的是二进制，需要把整条输出通道改成二进制安全。

下载落盘同样要经过允许目录校验。直连实例的场景下 SFTP 已经够用，所以优先级定为低。

#### F-10：应用重启后恢复 SSH 工作区

退出时只保存标签页的目标信息（主机、端口、用户名、`taskId`、认证方式），不保存任何密码。

下次启动时询问"恢复上次的 N 个会话？"。密码重新从任务信息和安全存储中获取；配合 F-02，可以直接回到原来的 tmux 会话。已经不在运行的任务会被跳过，并说明原因。

### 6.3 已在路线图中、建议提前的项

| 路线图项 | 建议提前的原因 |
| --- | --- |
| Phase 1 第 1 项：SSH Agent 和 keyboard-interactive | 只开 PAM 的服务器上，密码登录直接失败（SSH-P3-09）；Windows 用户普遍在用 OpenSSH Agent 或 Pageant |
| Phase 1 第 5 项：SFTP 递归目录、断点续传、校验和 | 数据集和模型检查点是主要的传输对象，而且常常是目录或几十 GB 的大文件 |
| Phase 2：批量发送到多个标签页 | 多节点训练需要在多台实例上执行同一条命令；可以复用批量操作那套"预览影响范围加逐项结果"的交互 |
| Phase 1 第 8 项：连接诊断时间线 | 能把"连不上"的问题定位到 DNS、TCP、握手、主机密钥、认证、PTY 中的某个阶段，降低实验室环境的排障成本 |

## 7. 修复与开发路线

| 批次 | 内容 | 完成标准 |
| --- | --- | --- |
| 第 1 批（本迭代） | SSH-P1-06、P1-07、P1-08，以及 SSH-P3-12、P3-13 两个顺手可修的小项 | 新增集成测试：绑定冲突后能重新启动；服务端先发 EOF；撤销脚本在写入失败时原文件不变。真机回归：vim、htop、tmux 显示正常，VS Code 撤销只删除本机那一行 |
| 第 2 批 | SSH-P2-12、P2-13、P2-14，SSH-P3-03、P3-04、P3-05 | 页面重新加载和连接途中关闭后，会话注册表里不留残余；GPU 采样卡住时通道数不再增长 |
| 第 3 批 | F-03、F-04（含 SSH-P2-15 和 SSH-P2-10）、F-05 | 地址回收后可以就地完成确认；VS Code 不再进行第二次首次信任 |
| 第 4 批 | F-01、F-02、F-06 | 一键打开 Jupyter/TensorBoard；断网后自动重连并回到原来的 tmux 会话 |
| 之后 | F-07、F-08、F-09、F-10，以及第 6.3 节中提前的路线图项 | 按 SSH_DEVELOPMENT 第 8 节的测试计划验收 |

每一批完成后，都按 [AGENTS.md](AGENTS.md) 跑完整的检查清单：typecheck、lint、test、`build:desktop`、`cargo check`、`fmt`、`clippy`。SSH 集成测试的运行命令必须带 `--features ssh-test-internals`。

## 8. 2026-10-28 发布准备复核

以上为原审阅结论；本节记录整改后的行为和证据。自动化基于本地 russh 测试服务器，不代表 OpenSSH、安装包或移动真机验收通过。发布清单第 5.3 节继续保留这些实测门槛。

| 条目 | 复核结果与自动化证据 | 仍需真机验证 |
| --- | --- | --- |
| SSH-P1-06 | 绑定后登记并返回实际端口；`port_forward_rules_track_their_lifecycle` 覆盖端口冲突、释放后同规则重启、端口 0 和停止 | 第 5.3 节转发冲突重启 |
| SSH-P1-07 | 按算法/公钥精确删除，临时文件完成后原子替换；`revoke_script_removes_only_matching_public_keys`、`revoke_script_preserves_original_file_when_staging_or_filtering_fails`（Unix） | 第 5.3 节撤销及失败保护 |
| SSH-P1-08 | `convertEol: false`，SshTerminalTab 测试锁定配置 | 第 5.3 节 vim、htop、tmux |
| SSH-P2-12 | 页面 Started 事件清理窗口所属会话；`page_reload_cancels_owned_sessions` | 第 5.3 节重载后无孤儿会话/转发 |
| SSH-P2-13 | TCP、握手/主机确认、认证、PTY、shell 均可取消；`cancel_*_ssh_session`、`cancel_waiting_for_host_key_confirmation` 及 PAM 取消测试 | 第 5.3 节连接中关闭 |
| SSH-P2-14 | EOF 后继续读取状态码；`channel_eof_before_exit_status_is_handled` 同时覆盖终端和 VS Code exec 的成功/非零退出 | 第 5.3 节终端与 VS Code 流程 |
| SSH-P2-15 | 兼容旧指纹，补全公钥和任务归属；`legacy_known_host_is_upgraded_after_matching`、`changed_host_key_is_rejected`、`changed_host_key_for_recycled_task_can_be_confirmed`；VS Code 单元测试验证严格信任文件 | 第 5.3 节地址回收与 VS Code 信任 |
| SSH-P3-01 | 远端 direct-tcpip 打开后才回复 SOCKS5 成功；`dynamic_forward_reports_remote_open_failure` | 第 5.3 节端口转发 |
| SSH-P3-02 | xterm 解析回调 ACK，最多 16 批；`terminal_output_backpressure_preserves_bytes` 验证高吞吐暂停、拒绝未来 ACK、恢复及 UTF-8 内容完整；`paused_terminal_output_can_close` 验证 2 秒内关闭；前端测试验证解析前/卸载后不 ACK | 第 5.3 节高峰输出下 UI 负载与隐藏标签 |
| SSH-P3-03 | GPU 探测总期限、关闭超时通道、同会话单飞；`gpu_probe_timeout_closes_channel_and_allows_later_probe` 与 runtime GPU 请求测试 | 第 5.2 节真实 GPU |
| SSH-P3-04 | 密码与 passphrase 保留首尾空格；`password_with_surrounding_whitespace_authenticates`、PAM 及 ssh-info/VS Code 单元测试 | 第 5.3 节认证 |
| SSH-P3-05 | 每会话串行输入，关闭取消积压且不影响其他会话；`runtime-ssh.test.ts`，`large_input_cannot_block_session_control` | 第 5.3 节终端输入 |
| SSH-P3-06 | 规范路径进入传输命令，拒绝越界和 `.part` 符号链接；`sftp_commands_forward_canonical_local_paths`、Unix 符号链接用例 | 第 5.3 节 SFTP；Unix 用例待跨平台 CI |
| SSH-P3-07 | 主机确认核对窗口归属；`host_key_prompt_confirms_first_connection` 验证越权请求不消耗提示；跨窗口关闭不清除拥有者状态 | 第 5.3 节首次信任 |
| SSH-P3-08 | 每传输独立 SFTP 通道；`concurrent_sftp_transfers_use_dedicated_channels` 验证并发内容与通道数量 | 第 5.3 节 SFTP |
| SSH-P3-09 | `best_supported_rsa_hash()` 协商；`rsa_key_auth_negotiates_server_signature_hash` 验证 SHA512；PAM 测试覆盖正确/错误密码、空提示、OTP、回显、多提示、重复提示及额外认证；`cancel_keyboard_interactive_authentication` | 第 5.3 节 OpenSSH/PAM；通用 MFA/Agent/证书仍属后续功能 |
| SSH-P3-10 | 三类窗口的 capability/启动树隔离，特权命令校验窗口，弹窗仅有设置快照；`ssh_window_capability_excludes_main_app_privileges`、`privileged_window_commands_are_restricted_to_their_owner_window` 和跨窗口会话测试 | 第 5.3 节弹窗、SFTP 文件选择、外部链接 |
| SSH-P3-11 | 拒绝 `-` 开头的主机/用户名，系统 SSH 目标前有 `--`；terminal_spawn、session 与 ssh-info 测试 | 第 5.3 节系统终端 |
| SSH-P3-12 | `ssh_write` 注释归位；代码核对通过，无运行行为变更 | 无独立实测要求 |
| SSH-P3-13 | Debug 中的密码/口令脱敏；`connection_request_debug_redacts_password_and_key_passphrase` | 无独立实测要求 |

本地 Windows 自动化结果：前端/工具 116 个文件、856 项通过；覆盖率门槛通过（lines 65.09%、statements 62.61%、functions 55.36%、branches 56.45%）；Rust 单元测试 84 项通过、1 项系统计划任务测试按配置忽略；SSH 集成测试 35 项通过。typecheck、typecheck:tools、lint（37 warnings、0 errors）、桌面输入构建均通过。最终本地检查记录见发布清单。

首轮 Linux CI 暴露测试服务器 `realpath` 的平台差异：返回本地临时目录后，Unix 上再次映射远端根目录，导致四个 SFTP 用例找不到文件。现统一使用虚拟 POSIX 根目录；新增 `sftp_realpath_uses_remote_paths_independent_of_the_host_os` 验证家目录与后续路径解析，Windows SFTP 回归通过。产品 SFTP 路径解析没有为绕过测试而修改；跨平台重跑结果见发布清单。
