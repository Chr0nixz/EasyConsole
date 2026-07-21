---
timestamp: 2026-07-21
scope: EasyConsole 全项目四维审计（用户交互便捷性、功能丰富性和完整性、架构鲁棒性和稳定性、程序运行效率）
product_priority: Tauri 桌面端优先，CLI/MCP 为派生工具，Web 为开发与降级运行面
method: 源码静态审计 + 自动化验证 + 375x812 浏览器实测 + 定向逻辑复现
overall_score: 6.2/10
finding_count: P0 1 / P1 10 / P2 8 / P3 1
status: 具备完整产品骨架，但发布前仍需处理安全、调度、持久化和大文件链路风险
---

# EasyConsole 项目审计报告

## 1. 执行摘要

EasyConsole 已经不是简单的原控制台页面复刻，而是形成了以 Tauri 桌面端为主、Web 渲染端与 Node CLI/MCP 共用 API 能力的多运行时产品。任务详情、模板、定时任务、运行日志、通知、存储上传、桌面 SSH、运行时设置、账号保存和中英文切换等主干能力均已落地，TypeScript、Rust、桌面输入构建和现有自动化测试全部通过。

当前成熟度评为 **6.2/10**。主要问题不在“页面或入口太少”，而在已经存在的关键能力仍有正确性和边界可靠性缺口：默认 API 使用明文 HTTP；循环调度的 cron 与周循环计算存在确定性错误；调度执行缺少崩溃恢复与幂等保障；含凭据备份没有接入安全存储；断点续传、Tauri 存储降级和 Node 本地数据并发写入可能产生错误或数据丢失；桌面大文件传输仍采用整文件内存缓冲；后台通知轮询成本随任务总量线性增长。

本轮共记录 **20 项正式问题：P0 1 项、P1 10 项、P2 8 项、P3 1 项**。其中 P0 是带条件的发布阻断项：只要生产环境仍通过不可信网络访问默认 HTTP API，就不应发布或输入真实凭据。若部署层已经通过可信 VPN、反向代理或本机隧道强制加密，则应以部署证据关闭该项，而不是仅凭网络拓扑假设降级。

### 1.1 四维评分

| 维度 | 评分 | 当前判断 | 最主要限制 |
|---|---:|---|---|
| 用户交互便捷性 | **6.5/10** | 主流程清晰，桌面工作台密度合理，基础无障碍投入可见 | 小屏设置页横向溢出、部分控件缺少可访问语义、长表单与终端交互仍有摩擦 |
| 程序功能丰富性和完整性 | **6.0/10** | 任务、模板、调度、存储、镜像、日志、通知、SSH、CLI/MCP 已形成较完整能力面 | 循环调度与上传恢复“有入口但不完全正确”，备份与工具端确认语义不完整 |
| 项目架构鲁棒性和稳定性 | **6.5/10** | 运行时适配器、共享 API 工厂、错误映射和类型边界方向正确 | 明文传输、持久化分叉、跨进程写入、关键链路测试和生产诊断能力不足 |
| 程序运行效率 | **5.5/10** | 路由懒加载、手工分包和局部动态加载已实施 | 大文件整缓冲、全量通知轮询、查询取消/缓存复用不足、sidecar 重复打包 |
| **综合** | **6.2/10** | **可持续开发，但尚不适合作为“无需人工看护”的稳定桌面控制面发布** | **优先修复安全、调度、持久化与大文件路径** |

综合分按桌面优先产品风险加权计算：交互 25%、功能 25%、架构 30%、效率 20%，不是四项简单平均。

### 1.2 发布判断

- **不建议直接面向真实账号发布**：除非生产 API 已有可验证的 HTTPS/VPN/隧道保护。
- **不建议依赖当前循环调度执行重要任务**：cron、周循环和故障窗口均可能导致错时或重复创建。
- **不建议把“包含登录凭据”的备份作为可恢复承诺**：当前普通存储与 secureStorage 的数据路径不一致。
- **不建议用当前桌面传输链路处理超大文件**：下载和 SFTP 峰值内存与文件大小近似线性相关。
- 在封闭测试环境内，任务浏览、详情、模板、日志、普通设置、轻量存储和 SSH 入口可以继续迭代验证。

## 2. 审计口径

### 2.1 严重度

| 等级 | 定义 | 处理要求 |
|---|---|---|
| **P0 阻断** | 可能直接造成凭据泄漏、不可接受的数据损坏，或使核心任务无法安全完成 | 发布前立即修复或提供可审计的外部控制措施 |
| **P1 重大** | 核心流程可能产生错误结果、重复副作用、持久化丢失、明显资源失控或安全承诺失真 | 当前发布周期处理 |
| **P2 一般** | 有可行绕过方式，但显著影响效率、可访问性、维护成本或故障定位 | 下一迭代处理并加入回归测试 |
| **P3 优化** | 不影响核心正确性，主要影响安装体积、细节体验或长期成本 | 纳入后续优化 |

### 2.2 证据等级

| 标记 | 含义 |
|---|---|
| **S：源码确认** | 由当前工作区源码、配置或构建产物直接确认 |
| **B：浏览器实测** | 在本地页面运行环境中通过交互、尺寸或可访问性检查复现 |
| **L：逻辑复现** | 直接执行纯逻辑函数，以确定输入复现结果 |
| **V：自动验证** | 由 typecheck、lint、test、build 或 cargo 命令验证 |
| **U：待真实环境验证** | 受真实账号、服务器、网络、设备或签名环境限制，本轮未下结论 |

### 2.3 范围与限制

本报告审查 `src/`、`tools/easy-console/`、`src-tauri/`、构建配置、现有测试及产品/设计文档。浏览器实测用于验证渲染、响应式和无障碍问题，但产品判断仍以 Tauri 桌面工作流为第一优先级。

本轮没有使用真实账号或生产 token，也没有修改远端任务、存储或 SSH 主机。所有涉及真实后端行为的结论均明确标为 U；不能把“源码路径存在”写成“线上行为已经通过”。

## 3. 风险总览

| ID | 级别 | 维度 | 问题 | 证据 |
|---|---|---|---|---|
| SEC-01 | **P0** | 架构 | 默认 HTTP 传输暴露可重放的密码摘要与 Bearer token | S |
| SCH-01 | **P1** | 功能 | cron、星期字段和 weekly 下一次执行计算错误 | S + L |
| SCH-02 | **P1** | 功能 | 后端创建与本地调度状态更新非原子，缺少幂等 | S |
| BAK-01 | **P1** | 功能 | “包含登录凭据”备份没有读取实际 secureStorage 凭据 | S |
| UPL-01 | **P1** | 功能 | 断点续传假设已上传分片连续，硬崩溃前无恢复记录 | S |
| UPL-02 | **P1** | 功能 | 上传队列可能在子项失败时报告成功，失败计数读取旧状态 | S |
| CLI-01 | **P1** | 功能 | CLI/MCP 创建本地计划绕过 mutation 确认约束 | S |
| STO-01 | **P1** | 架构 | Tauri 存储写入降级后，成功 IPC 读取不会合并 fallback | S |
| DAT-01 | **P1** | 架构 | Node 本地数据整文件直写且无锁，并发进程可互相覆盖 | S |
| IO-01 | **P1** | 效率 | HTTP 下载和 SFTP 传输采用整文件内存缓冲 | S |
| POL-01 | **P1** | 效率 | 通知观察器每 10 秒顺序扫描最多 5000 个任务 | S |
| UX-01 | **P2** | 交互 | 375px 宽度下设置页扩张至约 530px，页面整体横向滚动 | B + S |
| A11Y-01 | **P2** | 交互 | select、Tabs、范围按钮和图表缺少完整可访问语义 | B + S |
| UX-02 | **P2** | 交互 | 全局方向键、长表单离开和遮罩关闭的交互状态不安全 | S |
| UX-03 | **P2** | 交互 | 任务表缺少排序、页码跳转和翻页旧数据保留 | S |
| AUTH-01 | **P2** | 交互 | 默认记住密码、无显隐切换，改密后旧密文仍保留 | S |
| TERM-01 | **P2** | 交互 | 终端强制滚到底部且录制输出无界增长 | S |
| ARCH-01 | **P2** | 架构 | 超大模块、关键测试缺口与生产日志不足叠加变更风险 | S + V |
| PERF-01 | **P2** | 效率 | 查询键碎片化且 API 查询未传递 AbortSignal | S |
| PKG-01 | **P3** | 效率 | 安装包携带两份独立 Node runtime sidecar | S |

## 4. 用户交互便捷性

### 4.1 已经做好的部分

- 桌面工作台采用稳定的侧栏、紧凑工具栏、表格、抽屉、对话框和状态徽标，符合高频运维任务的扫描习惯。
- 任务状态和释放条件使用“颜色 + 文本”，没有只用颜色表达状态。
- 已提供任务详情路由、搜索防抖、焦点可见样式、跳过导航链接、对话框焦点陷阱、粗指针 44px 点击尺寸和 `prefers-reduced-motion` 降级。
- 关键文本对比度实测约为 **5.6:1 至 16.6:1**，当前抽样范围满足 WCAG AA；设计 token 与语义色分工清晰。
- 桌面专属 SSH 行为与 Web 降级入口有明确运行时边界，没有假装浏览器可以直接打开本地终端。

**界面反模式结论：通过。** 当前产品界面没有发现渐变文字、装饰性玻璃拟态、营销式 hero、重复卡片墙、过度圆角或无意义动效等明显生成式设计痕迹；信息密度、组件语汇和克制的配色符合运维工作台定位。后续整改应保留这种熟悉、安静、以任务为中心的产品表达，不要为了“现代化”把功能页改造成展示页。

### 4.2 UX-01：设置页在窄屏发生整页横向溢出

**级别：P2｜证据：B + S｜影响：响应式、移动/窄窗口可用性**

在 **375×812** 视口下，独立设置页内容宽度扩张到约 **530px**，导致整个页面横向滚动，而不是仅让确实需要宽度的局部内容滚动。根因集中在网格/弹性子项缺少 `min-w-0`、长 URL/路径缺少断行约束，以及部分双列布局没有在小屏彻底退化。入口见 [SettingsPage.tsx:795](file:///D:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L795)。

这会让保存按钮、字段标签和错误提示离开可视区，用户需要来回横移才能完成配置；对桌面端来说，窄窗口、窗口贴靠和远程桌面场景同样受影响。

**整改要求**：为所有可收缩 grid/flex 子项补 `min-w-0`；URL、路径和代码值使用 `overflow-wrap:anywhere` 或局部滚动容器；在 320、375、768、1024px 进行页面级截图回归，验收标准是 `documentElement.scrollWidth <= clientWidth`，表格等明确允许横向滚动的局部区域除外。

### 4.3 A11Y-01：交互控件语义不完整

**级别：P2｜证据：B + S｜影响：键盘与读屏用户、状态可理解性**

已确认的缺口包括：

- 设置页三处通知模式 `<select>` 没有可访问名称，见 [SettingsPage.tsx:1492](file:///D:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L1492)。
- 任务详情页签缺少 `role="tablist"`、`role="tab"`、`aria-selected` 以及页签与面板的关联，见 [TaskDetailPage.tsx:168](file:///D:/Projects/EasyConsole/src/pages/TaskDetailPage.tsx#L168)。
- Dashboard 时间范围按钮没有 `aria-pressed` 或等价选择状态，见 [DashboardPage.tsx:87](file:///D:/Projects/EasyConsole/src/pages/DashboardPage.tsx#L87)。
- 图表仅提供视觉曲线，没有同数据的文本摘要或表格替代，见 [DashboardPage.tsx:139](file:///D:/Projects/EasyConsole/src/pages/DashboardPage.tsx#L139)。

**整改要求**：所有表单控件必须通过 `<label for>`、`aria-label` 或 `aria-labelledby` 获得稳定名称；页签实现 WAI-ARIA Tabs 键盘模型；范围选择使用单选组或 pressed 状态；每张图表提供可折叠数据表或至少包含当前值、极值和变化趋势的可访问摘要。加入 Testing Library + axe（或等价规则）的聚焦测试。

### 4.4 UX-02：键盘选择、未保存状态和对话框关闭策略不一致

**级别：P2｜证据：S｜影响：误操作、键盘工作流、长表单数据丢失**

任务页全局拦截 ArrowUp/ArrowDown 并更新“视觉选中行”，但没有把 DOM 焦点同步到对应行或操作控件，见 [TasksPage.tsx:1289](file:///D:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1289)。当焦点位于输入框、菜单或其他可编辑控件时，全局快捷键还可能与原生行为冲突。

设置、计划任务和模板等长表单没有统一 dirty-state 导航保护；通用 Dialog 默认允许点击遮罩关闭，见 [ui.tsx:183](file:///D:/Projects/EasyConsole/src/components/ui.tsx#L183)。用户在编辑过程中切换路由或误点遮罩会无提示丢失输入。

**整改要求**：把方向键监听限制在显式聚焦的表格区域，采用 roving tabindex 或 `aria-activedescendant`，并跳过 input/textarea/select/contenteditable；建立共享 `useUnsavedChanges` 边界；包含有效输入或进行中操作的对话框禁止无确认遮罩关闭。验收需覆盖键盘、鼠标和路由跳转三条路径。

### 4.5 UX-03：任务表的高频检索效率仍不足

**级别：P2｜证据：S｜影响：大量任务下的定位与比较效率**

任务页已有搜索、筛选、列可见性和分页，但表头不能按创建时间、状态、时长等常用字段排序，分页只提供顺序翻页而没有页码跳转；切换查询时也没有保留上一页数据，导致表格在网络抖动时闪回 loading。相关实现见 [TasksPage.tsx:1202](file:///D:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1202) 和 [TasksPage.tsx:1883](file:///D:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1883)。

**整改要求**：先确认后端支持的排序字段并把排序写入 URL query；已知总数时提供页码与跳页，未知总数时显示“已加载范围”而不是伪造总页数；React Query 使用 `placeholderData/keepPreviousData` 并保留明确的后台刷新指示。排序与筛选组合必须可深链接和恢复。

### 4.6 AUTH-01：保存密码的默认值与生命周期不够保守

**级别：P2｜证据：S｜影响：共享设备风险、登录排错和密码轮换**

登录页“记住密码”默认为选中，且密码框没有显隐切换，见 [LoginPage.tsx:38](file:///D:/Projects/EasyConsole/src/pages/LoginPage.tsx#L38)。用户在设置页修改密码后，已保存账号中的旧密码密文没有同步删除或更新，见 [SettingsPage.tsx:287](file:///D:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L287)，后续静默重登会重复尝试旧密码。

**整改要求**：记住密码默认关闭并清楚标识 Web 仅为弱保护、桌面使用系统安全存储；增加带可访问名称的显隐按钮；改密成功后立即失效该账号的旧密码密文，只有用户再次明确选择时才保存新密码。为“改密后 token 失效 -> 静默登录 -> 回退密码表单”增加集成测试。

### 4.7 TERM-01：终端输出策略破坏阅读位置并可能无界占用内存

**级别：P2｜证据：S｜影响：长会话可用性与稳定性**

SSH 终端每次收到输出都会强制滚动到底部，用户向上查看历史时会被新输出拉回，见 [SshTerminalTab.tsx:316](file:///D:/Projects/EasyConsole/src/components/tasks/SshTerminalTab.tsx#L316)。同时，会话录制/输出缓冲没有明确上限，长时间日志流会持续增加 renderer 内存。

**整改要求**：仅当用户原本位于底部阈值内时自动跟随，离开底部后显示“回到底部/有新输出”按钮；把显示回滚和录制数据分别设置字节/行数上限；需要完整审计记录时流式落盘到 Tauri 文件命令，而不是保存在 React 状态中。

## 5. 程序功能丰富性和完整性

### 5.1 能力面评价

当前功能面已经覆盖日常控制台的主要工作：登录与账号切换、Dashboard、任务列表和详情、创建/克隆/批量操作、模板、计划任务、存储、镜像、运行日志、通知、监控链接、WebSSH、桌面内 SSH、系统终端与 VS Code Remote-SSH。CLI/MCP 复用了同一 API 工厂，并对大部分远端 mutation 实施 dry-run/confirm 约束。

因此本维度的重点不是继续堆入口，而是修正“看起来已支持、在边界条件下却给出错误结果”的功能。调度、备份和断点续传都属于这一类。

### 5.2 SCH-01：循环调度计算存在多处确定性错误

**级别：P1｜证据：S + L｜影响：任务错时、漏执行或执行频率失控**

界面向用户推荐 `*/30` 形式的 cron 表达式，见 [ScheduledTasksPage.tsx:592](file:///D:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L592)，但当前解析器只接受单值/枚举/范围，不接受 step 表达式，见 [task-recurrence.ts:48](file:///D:/Projects/EasyConsole/src/lib/task-recurrence.ts#L48)。实际执行 `*/30 * * * *` 会抛出 `Invalid cron field "*/30" at position 1`。

DOM/DOW 判断也不符合标准 cron 语义：从周二计算 `0 0 * * 1`，当前返回周三而不是下周一。周循环 UI 又没有提供星期选择，在缺少 weekdays 时下一次执行计算返回 `null`。创建入口见 [ScheduledTasksPage.tsx:307](file:///D:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L307)，核心计算见 [task-recurrence.ts:98](file:///D:/Projects/EasyConsole/src/lib/task-recurrence.ts#L98)。

**整改要求**：不要继续扩展自写 cron 解析器；采用经过验证的 cron 库，并明确支持的方言、时区、夏令时策略和 DOM/DOW 规则。weekly 必须要求至少选择一个星期，表单预览未来 5 次触发时间；非法规则在保存前阻断。为 step、range/list、月底、跨年、时区/DST 和 weekly 空选择建立表驱动测试。

### 5.3 SCH-02：调度执行缺少幂等和崩溃恢复边界

**级别：P1｜证据：S｜影响：重复创建远端实例**

后台 runner 先调用后端创建任务，再计算并保存下一次调度时间，见 [BackgroundScheduledTaskRunner.tsx:68](file:///D:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L68)。如果后端创建成功后，本地 recurrence 计算或持久化失败，计划会被标记失败但仍保持到期；下一轮或应用重启后可能再次创建相同实例。

这是跨“远端副作用 + 本地状态”的非原子流程。单纯把 `setStatus(completed)` 移到前面也不能解决问题，因为崩溃可能发生在任意两个写入之间。

**整改要求**：为每个触发点生成稳定的 execution key（计划 ID + 计划触发时间），调用前持久化 `running` lease，成功后持久化远端 task ID 与下一次触发；重启时对 `running` 记录执行对账而不是直接重放。若后端支持幂等键必须传递；若不支持，至少在本地提供可审计的“结果未知，需人工确认”状态。验收标准是对每个故障注入点重启后，同一 execution key 最多产生一个远端任务。

### 5.4 BAK-01：凭据备份入口与安全存储实际数据源不一致

**级别：P1｜证据：S｜影响：恢复承诺失真，或诱导采用不安全实现修补**

设置页提供“包含登录凭据”的导出选项，见 [SettingsPage.tsx:658](file:///D:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L658)。备份模块从普通 runtime storage 读取/写入账号段，见 [local-data-backup.ts:56](file:///D:/Projects/EasyConsole/src/lib/local-data-backup.ts#L56) 和 [local-data-backup.ts:120](file:///D:/Projects/EasyConsole/src/lib/local-data-backup.ts#L120)；真实桌面凭据则由认证上下文通过 secureStorage/系统钥匙串保存，见 [auth-context.tsx:73](file:///D:/Projects/EasyConsole/src/lib/auth-context.tsx#L73)。因此桌面导出可能不包含用户以为会包含的密文，导入也不会恢复到认证实际读取的位置。

**整改要求**：先定义明确产品策略。推荐默认永不导出凭据；如确需可迁移备份，必须通过 secureStorage 专用接口读取，使用用户单独输入的备份口令和带 KDF 参数的版本化加密包，导入时再写回 secureStorage。普通设置备份与凭据备份应分成两个明确动作，不能静默混用。需要覆盖桌面与 Web 的 round-trip、错误口令、旧 schema、部分导入和撤销场景。

### 5.5 UPL-01：断点续传偏移计算和持久化时机不可靠

**级别：P1｜证据：S｜影响：分片错位、重复传输、硬崩溃后无法恢复**

恢复偏移使用 `uploadedChunks.length * chunkSize`，见 [api-factory.ts:335](file:///D:/Projects/EasyConsole/src/lib/api-factory.ts#L335)，这隐含假设已上传分片从 0 开始连续。如果服务端返回稀疏分片集合，后续 `Content-Range` 会从错误位置继续。页面只在捕获上传失败后持久化 upload ID，见 [StoragePage.tsx:196](file:///D:/Projects/EasyConsole/src/pages/StoragePage.tsx#L196)；进程崩溃、断电或强制退出不会进入 catch，因此没有可恢复记录。

**整改要求**：上传会话创建成功后、发送第一片前立即落盘 `{uploadId, file fingerprint, chunkSize, completed indices}`；每片确认后原子更新 checkpoint；恢复时与服务端状态对账，按第一个缺失连续片或精确索引集合补传，不能按数组长度推断。文件 fingerprint 至少包含路径/名称、大小、mtime 和内容摘要策略。增加稀疏分片、服务器状态回退、硬退出和文件被替换的测试。

### 5.6 UPL-02：上传队列最终状态可能错误报告成功

**级别：P1｜证据：S｜影响：用户误以为文件已经上传完成**

队列完成提示没有以最终队列快照为唯一事实源；失败计数读取运行前捕获的旧 items，且单文件失败不一定阻止队列级成功消息，见 [StoragePage.tsx:243](file:///D:/Projects/EasyConsole/src/pages/StoragePage.tsx#L243)。这使“部分失败”可能表现为总体成功，破坏存储操作的可信度。

**整改要求**：让 `runUploadQueue` 返回不可变结果 `{succeeded, failed, cancelled, items}`，UI 只依据该结果显示汇总；任何失败都不得使用成功 toast；成功后保留后端列表复核，无法看到目标文件时降级为“上传完成但尚未确认”。为全成功、部分失败、全部失败、取消、重试后成功和列表未出现建立测试。

### 5.7 CLI-01：计划创建绕过工具端 mutation 确认规范

**级别：P1｜证据：S｜影响：脚本或 AI 调用可无确认改变本地自动执行状态**

仓库规范要求 CLI mutation 默认 dry-run 并使用 `--yes`，MCP mutation 要求 `confirm: true`。但 `schedule create` 在 CLI 中直接写入本地计划，见 [cli.ts:702](file:///D:/Projects/EasyConsole/tools/easy-console/cli.ts#L702)；对应 MCP 工具也没有强制确认，见 [mcp-tools.ts:542](file:///D:/Projects/EasyConsole/tools/easy-console/mcp-tools.ts#L542)。计划会在后台触发真实远端创建，风险不低于直接 mutation。

**整改要求**：CLI 默认输出规范化计划和未来触发预览，仅 `--yes` 后持久化；MCP schema 强制 `confirm: true`，未确认时返回 dry-run payload。运行日志记录调用渠道、确认状态、计划 ID 和 execution key。为 CLI 与 MCP 各加未确认不写、确认后只写一次的测试。

### 5.8 功能扩充建议（正确性修复之后）

以下不是本轮正式缺陷计数的一部分，但能提高完整度，优先级应低于 SCH/BAK/UPL/CLI 系列：

- 为计划任务提供可检索的执行历史、失败重试策略、暂停原因和“下 5 次执行”预览。
- 为任务列表增加当前筛选结果 CSV 导出，便于交接、核对和离线分析。
- 为模板增加搜索、标签、变量化参数和执行前 payload 预览，避免批量创建只能依赖名称后缀区分。
- 为通知增加持久化历史中心，使错过的系统通知可以回看并关联到任务详情。
- 为镜像和远程存储补齐适合桌面端的详情/进度视图，但不要在后端契约未确认前承诺不存在的操作能力。

## 6. 项目架构的鲁棒性和稳定性

### 6.1 已经做好的部分

- [runtime.ts](file:///D:/Projects/EasyConsole/src/lib/runtime.ts) 把 storage、fetch、WebSocket、通知、剪贴板、外链、下载和桌面命令隔离在运行时适配器中，页面没有大面积泄漏平台全局对象。
- [api-client.ts](file:///D:/Projects/EasyConsole/src/lib/api-client.ts) 与 [api-factory.ts](file:///D:/Projects/EasyConsole/src/lib/api-factory.ts) 统一处理 envelope、鉴权、业务错误和领域 API，Web、CLI、MCP 复用方向正确。
- 已有 ErrorBoundary、登录失效映射、token 规范化、blob 响应分支、运行日志脱敏、通知状态转换和密码密文异常拒绝等保护。
- TypeScript 与 Rust 编译检查通过；现有 **53 个测试文件、267 项测试**全部通过；Rust **4 项单元测试**通过。
- Rust 命令普遍返回结构化错误而非依赖 panic，SSH 主机密钥与 SOCKS 辅助逻辑已有基础测试。

### 6.2 SEC-01：默认生产路径仍使用明文 HTTP

**级别：P0（条件阻断）｜证据：S｜影响：账号凭据、token 与所有控制操作的机密性/完整性**

默认 API 基址是 `http://116.172.93.164:28080/api`，见 [api-client.ts:4](file:///D:/Projects/EasyConsole/src/lib/api-client.ts#L4)。登录虽然发送 SHA-256 hex 密码，见 [api-factory.ts:104](file:///D:/Projects/EasyConsole/src/lib/api-factory.ts#L104)，但该摘要本身就是可重放的登录材料；后续 Bearer token 同样通过明文 HTTP 传输。哈希不能替代 TLS，攻击者不需要还原原密码即可重放摘要或 token。

**整改要求**：生产环境必须使用证书有效的 HTTPS/WSS。若后端暂时不能直接启用 TLS，应由受控反向代理、VPN 或本机隧道提供端到端加密，并在 Tauri 生产构建中拒绝非 loopback 的 `http://` API；设置页对不安全 URL 给出阻断而不是普通提示。验收需要抓包证明登录、刷新、任务、存储和 WebSSH 凭据在不可信链路上均不可见，并覆盖证书错误与降级攻击。

### 6.3 STO-01：Tauri 存储降级会形成双数据源

**级别：P1｜证据：S｜影响：设置、计划、模板或账号元数据“写入成功但读取不到”**

Tauri IPC 写入失败时适配器回退到 `localStorage`；后续 IPC 恢复后，如果原生读取成功但返回 `null`，当前实现不会再查询 fallback，见 [runtime.ts:89](file:///D:/Projects/EasyConsole/src/lib/runtime.ts#L89)。这样同一个 key 可能同时存在于 `runtime-storage.json` 与 WebView localStorage，读写来源随 IPC 状态变化，造成数据回退、丢失或界面与后台 runner 看到不同状态。

**整改要求**：定义单一权威源与迁移协议。建议 Tauri 以原生存储为主：读到 null 时检查 fallback 并原子迁移；写失败时明确标记 pending migration；删除使用 tombstone 防止旧值复活。不要无提示吞掉 IPC 错误。测试必须模拟写失败、读恢复、删除失败、双边冲突和多窗口读取。

### 6.4 DAT-01：Node 本地数据存储不具备崩溃与跨进程安全性

**级别：P1｜证据：S｜影响：CLI/MCP 并发写导致计划、模板或运行日志丢失/损坏**

[local-data-store.ts:10](file:///D:/Projects/EasyConsole/tools/easy-console/local-data-store.ts#L10) 使用进程内整文件缓存和直接覆盖写入，没有文件锁、版本比较、临时文件 + 原子 rename，也没有跨进程事务。CLI 与 MCP sidecar 可同时运行：两个进程读取同一旧快照后分别写入时，后写者会覆盖先写者；进程在写入中断还可能留下截断 JSON。

**整改要求**：短期使用同目录临时文件、flush/fsync、原子 rename，并加入跨进程锁与 revision 冲突重试；中期可统一迁移到 SQLite（WAL 模式）并定义 schema migration。每次 mutation 必须在锁内重新读取最新数据，不能依赖长期进程缓存。增加多进程并发压测、写入中途终止、磁盘满和损坏恢复测试。

### 6.5 ARCH-01：关键链路复杂度增长快于测试与可观测性

**级别：P2｜证据：S + V｜影响：修改一个页面或命令时容易产生跨功能回归**

当前 [TasksPage.tsx](file:///D:/Projects/EasyConsole/src/pages/TasksPage.tsx) 约 **1969 行**，[SettingsPage.tsx](file:///D:/Projects/EasyConsole/src/pages/SettingsPage.tsx) 约 **1610 行**，[src-tauri/src/lib.rs](file:///D:/Projects/EasyConsole/src-tauri/src/lib.rs) 约 **2699 行**。这些文件同时承担数据编排、持久化、交互状态和渲染/命令实现，职责边界开始模糊。

现有 267 项测试数量可观，但风险最高的 `task-recurrence`、上传恢复、备份、Tauri fallback、Node 跨进程写、SFTP 大文件、调度崩溃/幂等，以及 TaskDetail/ScheduledTasks/TaskTemplates 集成仍缺少针对性覆盖；没有 E2E 套件和覆盖率门槛。Tauri 日志插件只在 debug 构建启用，见 [lib.rs:2462](file:///D:/Projects/EasyConsole/src-tauri/src/lib.rs#L2462)，生产故障难以定位。

**整改要求**：按领域拆出 page controller/hooks、纯状态机、表单 schema 和展示组件；Rust 按 storage/ssh/sftp/external/update 命令模块拆分，但保持 Tauri command 接口稳定。先为 P0/P1 增加失败路径测试，再设核心模块覆盖率门槛和 3 至 5 条桌面冒烟 E2E。生产日志采用滚动文件、分级和严格脱敏，默认不得记录 token、密码、SSH 私钥或完整敏感 payload。

## 7. 程序运行效率

### 7.1 已经做好的部分

- 页面路由已懒加载，xterm 等较重能力采用动态加载；Vite `manualChunks` 已把 React、TanStack、xterm 和通用 vendor 分离。
- 搜索已具备防抖，共享 helper 对远程文本/日志读取设置字节上限，避免默认无限返回。
- 任务表具有服务端分页和列可见性，不会把全部任务一次性渲染到单页 DOM。
- 桌面输入构建成功，当前主要 chunk 规模可见且可监控：`vendor-xterm` 约 504 KB、通用 vendor 约 401 KB、React vendor 约 222 KB、TanStack vendor 约 108 KB（均为未压缩近似值）。

### 7.2 IO-01：大文件传输使用整文件内存缓冲

**级别：P1｜证据：S｜影响：大文件时内存峰值、OOM、复制开销与 UI 卡顿**

HTTP 下载先累积响应 chunk 形成 Blob，见 [runtime.ts:165](file:///D:/Projects/EasyConsole/src/lib/runtime.ts#L165)，随后又把完整 Blob 转成 ArrayBuffer 再交给写文件命令，见 [download.ts:31](file:///D:/Projects/EasyConsole/src/lib/download.ts#L31)。这会在 renderer/Tauri 边界产生至少一次完整文件副本。Rust SFTP 上传与下载同样整文件读入内存，见 [lib.rs:1302](file:///D:/Projects/EasyConsole/src-tauri/src/lib.rs#L1302)。

**整改要求**：桌面端把 URL/SFTP 到文件的传输下沉到 Rust，采用固定大小 buffer 流式读写，通过事件只回传进度、速度和可取消句柄；上传也由 Rust 从本地路径分块读取。临时文件完成后原子 rename，失败/取消清理 `.part` 文件并支持恢复。验收以至少 5GB 稀疏/测试文件执行，证明 renderer 内存不随文件大小线性增长，并覆盖网络中断与磁盘不足。

### 7.3 POL-01：通知观察器高频全量扫描任务

**级别：P1｜证据：S｜影响：后台网络、服务端压力、耗电和通知延迟**

通知观察器每 **10 秒**调用全量分页 helper，helper 最多顺序请求 **50 页 × 100 条 = 5000 条任务**，见 [fetch-all-tasks.ts:4](file:///D:/Projects/EasyConsole/src/lib/fetch-all-tasks.ts#L4)、[fetch-all-tasks.ts:29](file:///D:/Projects/EasyConsole/src/lib/fetch-all-tasks.ts#L29) 和 [TaskNotificationWatcher.tsx:27](file:///D:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L27)。窗口不可见或缩到托盘后仍可能保持同样频率；任务越多，每分钟请求数和 JSON 解析量越高。

**整改要求**：优先使用后端增量事件/SSE/WebSocket；如果后端只能轮询，则只查询活动/近期任务，保存 `updatedAt/cursor`，前台 10 至 30 秒、后台指数退避到 1 至 5 分钟，并对失败加 jitter。分页请求设置总时间预算与并发上限，避免一次轮询未完成下一次又启动。记录每轮任务数、页数、耗时和跳过原因，用 100/1000/5000 任务基准验收。

### 7.4 PERF-01：查询取消与缓存复用不完整

**级别：P2｜证据：S｜影响：重复请求、过期响应覆盖新状态、页面切换浪费**

Images、Scheduled Tasks 和 Create Task 对相同镜像 API 使用不同 query key，导致无法共享缓存和失效策略；多个 React Query `queryFn` 没有把 `AbortSignal` 传到 API client，快速切换筛选、路由或账号时旧请求仍会完成。相关入口见 [ImagesPage.tsx](file:///D:/Projects/EasyConsole/src/pages/ImagesPage.tsx)、[ScheduledTasksPage.tsx](file:///D:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx) 和 [CreateTaskDialog.tsx](file:///D:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx)。

**整改要求**：建立按领域集中的 query key factory；相同资源、相同参数必须生成相同 key。`queryFn({signal})` 一路传到 fetch；账号/API base 切换时显式取消并清理隔离域缓存。用 MSW 或等价 mock 验证快速切换时旧响应不会覆盖新查询，重复挂载只产生一次网络请求。

### 7.5 PKG-01：两个 sidecar 重复携带 Node runtime

**级别：P3｜证据：S｜影响：安装包与更新下载体积**

Tauri 配置同时打包 CLI 和 MCP 两个独立 sidecar，见 [tauri.conf.json:33](file:///D:/Projects/EasyConsole/src-tauri/tauri.conf.json#L33)。当前构建近似为 CLI **55.43 MiB**、MCP **56.83 MiB**，合计约 **112 MiB**，主体是重复 Node runtime。

**整改要求**：在不破坏命令行兼容性的前提下评估单一 sidecar 多入口、共享 runtime、原生 Rust launcher 或按需安装 MCP 工具。以最终安装包、增量更新包和冷启动时间作为决策指标；该项不得先于 P0/P1 正确性工作。

## 8. 系统性问题归纳

### 8.1 “本地功能”已经成为分布式状态问题

计划、模板、账号、运行日志和上传 checkpoint 看似都是本地数据，但实际横跨 renderer、Tauri 原生存储、系统钥匙串、CLI 与 MCP 多进程。当前风险的共同根因是缺少统一的权威源、revision、原子写入和迁移协议。继续为每个 key 添加独立 fallback 会放大分叉。

建议建立一份本地数据契约：每类数据明确 owner、schemaVersion、敏感级别、事务边界、跨进程访问方式、迁移和损坏恢复策略。普通设置、敏感凭据和高频运行日志不应共用同一持久化假设。

### 8.2 “已支持”与“已验证”需要分开

代码中已存在 refresh token、断点续传状态查询、监控 URL、SSH/SFTP 等路径，但真实后端或目标主机尚未验证。产品文案与发布记录应使用三态：已测试、实验性、不可用；不能仅根据接口封装存在就声明完整支持。

### 8.3 失败路径覆盖落后于功能增长

现有测试主要证明纯 helper 和常规输入，P0/P1 多集中在跨边界失败：网络成功后本地写失败、IPC 暂时失败后恢复、多个进程同时写、上传状态稀疏、进程在两个步骤之间退出。后续测试投入应从“再增加正常路径样例”转向故障注入、重启恢复、并发和大数据量。

## 9. 验证结果

### 9.1 已通过

| 命令/检查 | 结果 | 说明 |
|---|---|---|
| `npm.cmd run typecheck` | 通过 | Renderer TypeScript |
| `npm.cmd run typecheck:tools` | 通过 | CLI/MCP TypeScript |
| `npm.cmd run test` | 通过 | 53 个测试文件，267 项测试 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 | Tauri Rust 编译检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 通过 | 4 项 Rust 测试 |
| `npm.cmd run build:desktop` | 通过 | sidecar、应用类型检查与 Vite 桌面输入构建 |
| `npm.cmd run version:check` | 通过 | 版本一致性检查 |
| `npm.cmd run lint` | 通过但有警告 | 0 errors，35 warnings |
| 375×812 页面检查 | 部分不通过 | 设置页存在约 530px 宽的整页横向溢出 |
| 关键颜色对比度抽样 | 通过 | 约 5.6:1 至 16.6:1 |
| recurrence 定向逻辑复现 | 不通过 | `*/30` 抛错；星期 cron 错算；weekly 空星期返回 null |

### 9.2 Lint 警告说明

35 条 warning 主要来自 effect 内同步 setState、effect dependency、Fast Refresh 导出方式和 TanStack “incompatible library” 提示。它们目前没有阻断构建，但不能长期作为固定基线忽略。应逐条分类为：真实闭包/依赖风险、架构性 false positive、允许但需注释的例外；目标是新代码不增加 warning，并为现存 warning 建立清理清单。

### 9.3 依赖安全审计未完成

`npm.cmd audit --omit=dev --json` 因 npm registry TLS 连接在建立前终止而失败。因此本报告**不能声明依赖无漏洞**。应在网络可用或组织镜像源上重新执行，并保留 lockfile 对应的 JSON 结果；若发布桌面安装包，还应补 Rust 依赖审计与许可证检查。

## 10. 未验证的真实环境边界

以下项目均为 **U**，必须在隔离测试账号、测试任务和可回收资源上验证：

- 真实登录、`userinfo`、token 过期与 `/user/refresh_token` 行为。
- 任务创建、编辑能力边界、释放、删除、批量操作和错误码映射。
- 分片上传状态接口、0B 文件、真实断点恢复、上传完成后的列表一致性。
- Grafana iframe/外链的认证、CSP、`var-pod` 和时间范围行为。
- WebSSH、应用内 SSH、系统终端、VS Code Remote-SSH、主机指纹变更与 SFTP 大文件。
- 系统通知权限在 Windows 实机的拒绝、恢复、托盘和后台行为。
- `npm.cmd run tauri:build` 生成的实际安装包、签名、升级和卸载数据保留。
- Android 生成工程和真实设备行为；当前产品优先级为桌面，不应由“工程目录存在”推断移动端可发布。

建议建立单独的 `LIVE_VALIDATION.md` 或发布检查单，记录时间、应用版本、API 环境、脱敏账号、测试资源、预期、实际和清理结果。任何真实凭据和 token 都不得进入仓库或测试快照。

## 11. 分阶段整改路线图

### Phase 0：发布阻断与调度正确性

1. **SEC-01**：提供 HTTPS/WSS 或可审计的加密隧道，并在生产构建阻断非本机明文 API。
2. **SCH-01**：替换 cron 解析，修正 weekly/DOM/DOW/时区语义，增加未来执行预览和表驱动测试。
3. **SCH-02**：引入 execution key、运行 lease、结果对账与故障注入测试。
4. **BAK-01**：拆分普通备份与凭据迁移，统一 secureStorage 的导入导出契约。

**阶段出口**：安全链路可证明；所有 recurrence 反例通过；任意故障点重启不重复创建；凭据备份承诺与实际 round-trip 一致。

### Phase 1：持久化与 mutation 安全

1. **UPL-01 / UPL-02**：重建 checkpoint 与队列结果模型，覆盖硬退出、稀疏分片和部分失败。
2. **STO-01**：确定 Tauri 本地数据权威源，加入 fallback 迁移与冲突测试。
3. **CLI-01**：计划创建统一 dry-run/`--yes`/`confirm: true` 语义。
4. **DAT-01**：Node 存储采用原子写和跨进程并发控制，评估 SQLite。

**阶段出口**：崩溃、IPC 恢复和双进程并发均不丢数据；所有 mutation 无确认不落盘、不触发远端副作用。

### Phase 2：大文件、轮询与交互质量

1. **IO-01**：桌面 HTTP/SFTP 流式传输、取消、临时文件和恢复。
2. **POL-01 / PERF-01**：活动任务增量轮询、后台退避、请求取消和 query key 统一。
3. **UX-01 / A11Y-01**：修复 320/375px 溢出，补齐表单、Tabs、范围控件和图表语义。
4. **UX-02 / UX-03 / AUTH-01 / TERM-01**：完善键盘模型、dirty guard、任务表效率、密码生命周期和终端回滚策略。

**阶段出口**：5GB 文件传输 renderer 内存近似恒定；5000 任务后台请求量有上限；关键页面通过键盘/读屏冒烟和窄屏截图回归。

### Phase 3：工程治理与分发成本

1. **ARCH-01**：按领域拆分超大模块，增加调度、上传、存储、备份和桌面 E2E 覆盖。
2. 启用脱敏的生产滚动日志和可导出的诊断包。
3. **PKG-01**：合并或共享 Node sidecar runtime，建立安装包体积预算。
4. 恢复 npm/Rust 依赖安全审计并纳入发布门禁。

**阶段出口**：核心链路有覆盖门槛与桌面冒烟测试；生产故障可定位；安装包和更新体积有稳定预算。

## 12. 复审验收标准

下次复审至少应满足：

- 所有 P0 清零，P1 有代码修复、自动化回归和迁移说明，不以“暂未复现”关闭。
- 生产 API/WSS 全链路加密，应用拒绝不安全的远程 HTTP 配置。
- cron/weekly 在时区、DST、星期与 step 表达式测试中结果正确，调度崩溃恢复不会重复创建。
- 普通备份和凭据备份分别 round-trip；错误口令、旧版本和部分损坏均可恢复或明确拒绝。
- 上传 checkpoint 在硬退出后可恢复，稀疏分片不会错位，部分失败不会显示总体成功。
- Tauri fallback 与 Node 多进程写在故障注入下保持一致且不产生截断文件。
- 5GB 下载、SFTP 上传/下载的 renderer 与 Rust 峰值内存受固定 buffer 约束。
- 任务通知在 5000 条数据规模下有请求/耗时预算，窗口后台时显著退避。
- 320、375、768、1024 和常用桌面窗口尺寸无非预期整页横向滚动。
- 关键页面完成键盘、焦点恢复、accessible name、Tabs、图表替代信息检查。
- `typecheck`、`typecheck:tools`、`lint`、测试、`build:desktop`、`cargo check/test`、依赖审计和实际 `tauri:build` 全部有可追溯结果。

## 13. 最终结论

EasyConsole 的基础架构方向和功能覆盖已经足以支撑正式产品化，当前也保留了不少值得继续沿用的工程实践：多运行时适配边界、共享 API 层、桌面优先能力、可理解的状态 UI、设计 token、错误映射和较好的纯逻辑测试基础。

下一阶段不应优先继续扩张页面数量，而应把现有核心能力从“可操作”提升为“结果可信”：先保证传输安全和调度不重复，再保证本地数据、断点续传和跨进程写入不会丢失，随后解决大文件与后台轮询的规模问题，最后补齐可访问性、E2E、生产诊断和安装体积治理。完成 Phase 0 与 Phase 1 后，项目才具备进入真实账号受控试运行的稳健基础。
