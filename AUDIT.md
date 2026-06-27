---
timestamp: 2026-06-26
scope: 全项目四维度审计（用户交互便捷性 / 功能丰富性和完整性 / 架构鲁棒性和稳定性 / 运行效率）
method: 源码静态审查 + 代码引用定位
---

# EasyConsole 项目审计报告

本报告从**用户交互便捷性**、**程序功能丰富性和完整性**、**项目架构鲁棒性和稳定性**、**程序运行效率**四个维度对 EasyConsole 进行系统性审查，记录当前不足与改进方向。所有引用均附 `file:///` 链接与行号，基于当前磁盘状态。

## 整体评价

**优势面**：
- 架构分层清晰，适配器模式（`runtime.ts`）让 Web/Tauri/Node 三端边界干净。
- 本地运行时数据模型（模板/定时任务/运行日志/已保存账号）完整。
- SSH 桌面化（russh 应用内 SSH、VS Code Remote-SSH、系统终端）显著超越原始控制台。
- `src/lib` 测试覆盖充分（25+ 测试文件），CI 矩阵覆盖三平台。
- Rust 错误处理规范，无 `unwrap`/`expect` 滥用。
- manualChunks 拆分、路由 lazy、xterm 动态导入等基础优化到位。

**核心短板**：
- **错误恢复韧性**：无 ErrorBoundary、无 API 重试、AuthProvider 无 catch、SSH connect 无超时。
- **凭据安全**：明文 token、无盐哈希、capabilities 过宽。
- **并发持久化**：runtime-storage.json 无锁全量读写，run log 追加放大 4 倍 IO。
- **CLI/MCP 与 Web 能力对齐**：模板/定时任务/存储上传/镜像提交等多处缺口。
- **核心功能完整性**：任务编辑、循环调度、token 刷新、断点续传均缺失。
- **列表性能**：无虚拟化、搜索无防抖、双重轮询、纯 JS MD5 阻塞主线程。

多数缺口可通过补齐 API 调用与 UI 入口解决，无需重大架构调整；安全与韧性相关问题建议优先处理。

---

## 一、用户交互便捷性

### 1.1 导航与信息架构

- **无面包屑导航**：[AppShell.tsx:454-457](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L454) 顶栏仅显示单级标题与固定副标题，用户在多层级操作中容易迷失。
- **无任务详情深链接**：路由扁平为 8 个一级页面（[App.tsx:43-52](file:///d:/Projects/EasyConsole/src/App.tsx#L43)），无 `/tasks/:id` 详情路由，无法分享/收藏单个任务上下文。CommandPalette 搜到任务后只能跳到 `/tasks?keyword=...`（[CommandPalette.tsx:74](file:///d:/Projects/EasyConsole/src/components/CommandPalette.tsx#L74)）。
- **标题匹配脆弱**：[AppShell.tsx:41-50](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L41) 用 `location.pathname` 精确匹配，未来嵌套路由或尾斜杠会回退到默认标题。
- **菜单无分组/无层级**：8 个 navItem 平铺（[AppShell.tsx:27-36](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L27)），"实例模板/定时任务/运行日志/设置"与"任务实例/存储/镜像"没有视觉分组，认知负载随功能增加线性上升。
- **无"最近访问"或常用置顶**：侧栏顺序固定，无法按使用频率调整。

**改进建议**：增加面包屑组件（至少 "控制台 / 当前页"）；标题匹配改为 `startsWith` 或路由匹配；为任务增加 `/tasks/:id` 详情路由（聚合日志/终端/监控/SSH）；按"实例""资源""系统"对 nav 分组并加分隔线。

### 1.2 任务列表页交互

- **搜索框无防抖**：[TasksPage.tsx:1053-1058](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1053) `onChange` 直接 `updateTaskQuery({ keyword })` 会 `setSearchParams` 并改变 queryKey，每输入一个字符就发一次 `instanceApi.tasks` 请求。对比 [CommandPalette.tsx:19](file:///d:/Projects/EasyConsole/src/components/CommandPalette.tsx#L19) 同类搜索有 300ms 防抖，TasksPage 反而没有。**最影响体验的问题之一**。
- **表格列不可排序**：表头全是纯文本（[TasksPage.tsx:1265-1282](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1265)），用户无法按创建时间/时长/状态排序。
- **分页只有上/下页**：[TasksPage.tsx:1328-1343](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1328) 无页码跳转、无总页数，`hasKnownTotal` 为 false 时用户不知道还有多少页。
- **列设置/自动刷新设置直接写 `window.localStorage`**：[TasksPage.tsx:197、224、232、1005、1009、1013](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L197) 绕过 `browserRuntime.storage`，桌面端不会落到 `runtime-storage.json`，跨窗口/重装会丢失。违反 AGENTS.md "local runtime data 走 runtime adapter" 约定。
- **行选择翻页后静默清空**：[TasksPage.tsx:1025-1027](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1025) 无 toast 或保留提示。
- **无"快速状态切换"**：状态筛选是 Select（[TasksPage.tsx:1060-1067](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1060)），无法像 Tab 一样一键切换"运行中/已释放/失败"，且不显示各状态计数。
- **置顶排序仅本地**：[TasksPage.tsx:706](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L706) 自动刷新拉到新数据时置顶行会跳动，缺少视觉稳定性锚定。

**改进建议**：搜索加 250-300ms 防抖并显示搜索 loading；表头加可点击排序（至少 created/duration/status）；分页增加页码与跳转；列设置改用 `browserRuntime.storage`；状态筛选改为带计数的 Tab 段控件。

### 1.3 表单交互

- **CreateTaskDialog 校验写两遍**：[CreateTaskDialog.tsx:135-151](file:///d:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx#L135)（useMemo）和 [CreateTaskDialog.tsx:235-302](file:///d:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx#L235)（submit）各自重算一遍校验并 `setFormError`，两套规则容易漂移，且字段级 `FieldError` 与顶部 `formError` 同时出现信息重复。
- **新建任务对话框不能从模板创建**：[CreateTaskDialog.tsx:160-171](file:///d:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx#L160) 只支持空白新建或从 `initialTask` 克隆，模板入口在另一页面（[TaskTemplatesPage.tsx:605-614](file:///d:/Projects/EasyConsole/src/pages/TaskTemplatesPage.tsx#L605)），核心流程割裂。AGENTS.md 强调模板复用是核心流程。
- **所有表单无 dirty 检测**：SettingsPage（[SettingsPage.tsx:98-99](file:///d:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L98)）、ScheduledTasksPage、TaskTemplatesPage 改一半切走就丢，无"未保存将丢失"拦截。
- **LoginPage 无密码可见性切换**：[LoginPage.tsx:172-179](file:///d:/Projects/EasyConsole/src/pages/LoginPage.tsx#L172) 固定 `type="password"`，输错时排查成本高。
- **ScheduledTasksPage 表单成功后不清空 image/资源**：[ScheduledTasksPage.tsx:257-260](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L257) 只重置 name/description/scheduleTime，CPU/GPU/内存/路径保留，缺"全部重置"按钮。
- **表单字段组件未抽象复用**：每个表单重复 `<label><span>...</span><Input/><FieldError/></label>`（[CreateTaskDialog.tsx:320-372](file:///d:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx#L320)、[TaskTemplatesPage.tsx:216-309](file:///d:/Projects/EasyConsole/src/pages/TaskTemplatesPage.tsx#L216)、[ScheduledTasksPage.tsx:374-416](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L374)），label/错误/required 提示不一致风险高。`form-fields.tsx` 只提供三个原子，缺 `<Field label required error>` 封装。
- **SettingsPage 校验只在提交时触发**：[SettingsPage.tsx:48-52、117-118、217-219](file:///d:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L48) URL 输入过程中无即时反馈。

**改进建议**：抽出 `<Field>` 复用组件统一 label/error/required；CreateTaskDialog 顶部加"从模板创建"；SettingsPage 加 URL 即时校验与 dirty 离开拦截；LoginPage 加密码显示切换。

### 1.4 错误/空/加载状态反馈

- **错误 Toast 与成功 Toast 用同样 3500ms 自动消失**：[Toast.tsx:32-39](file:///d:/Projects/EasyConsole/src/components/Toast.tsx#L32) error 调用未覆盖时长，最多保留 4 条 `.slice(-4)`，批量失败场景会丢失信息。
- **Toast 无操作按钮**：[Toast.tsx:69-77](file:///d:/Projects/EasyConsole/src/components/Toast.tsx#L69) 所有 toast 只能关闭或超时，无"重试/查看日志/撤销"内联动作。
- **LoadingState 只是裸 spinner**：[DataState.tsx:9-19](file:///d:/Projects/EasyConsole/src/components/DataState.tsx#L9) DashboardPage/ImagesPage/StoragePage/TaskTemplatesPage 首屏加载内容区剧烈跳动，无骨架屏。
- **EmptyState 无引导性副文案**：[DataState.tsx:44-52](file:///d:/Projects/EasyConsole/src/components/DataState.tsx#L44) 只有 icon+title+action，无"为什么为空 + 下一步建议"描述行。
- **ErrorState 信息单薄**：[DataState.tsx:56-65](file:///d:/Projects/EasyConsole/src/components/DataState.tsx#L56) 只显示 `error.message`，无错误码/请求 URL/重试判断，401/网络/500 无差异化文案。
- **ConfirmDialog 无"不再提示"**：每次释放/删除/批量操作都弹确认（[TasksPage.tsx:770-831](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L770)），高频用户无法跳过。
- **离线横幅无操作**：[AppShell.tsx:500-505](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L500) 只显示"当前处于离线状态"，无"重试连接"按钮。

**改进建议**：error toast 时长延长到 8000ms+ 并提供"重试"动作；通用化骨架屏（卡片/列表/详情）；EmptyState 增加 description 字段；ErrorState 区分 401/网络/500 文案；ConfirmDialog 对高频非破坏操作加"不再确认"。

### 1.5 键盘可访问性

- **全局快捷键只有 Ctrl+K**：[AppShell.tsx:113-122](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L113) 仅命令面板，缺 `/` 聚焦搜索、`n` 新建任务、`g` 系列跳转、`?` 查看快捷键等。
- **无 skip-to-content 跳转链**：grep 全仓库无 `skip-to/skip-link`，违反 WCAG 2.4.1。
- **AppSshTerminalDialog 不响应 Esc 关闭**：[AppSshTerminalDialog.tsx:184-206](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L184) 只处理 Tab 焦点循环，无 `Escape` 分支，与其他 Dialog 行为不一致。注意：终端里 Esc 本身是控制字符，需 Esc+Esc 或修饰键区分。
- **Dialog 打开未锁定 body 滚动**：[ui.tsx:101-164](file:///d:/Projects/EasyConsole/src/components/ui.tsx#L101) 长表单（CreateTaskDialog）背景仍可滚动。
- **CommandPalette Esc 处理依赖外层 Dialog**：[CommandPalette.tsx:106-127](file:///d:/Projects/EasyConsole/src/components/CommandPalette.tsx#L106) 嵌套场景下事件冒泡顺序可能出问题。
- **nav-resize-handle 是 `tabindex=0` 但无键盘调整**：[AppShell.tsx:448-450](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L448) 设了 `tabIndex={0}` 与 `role="separator"`，但只绑定 `onPointerDown`/`onDoubleClick`，无 ArrowLeft/ArrowRight 键盘调整。
- **表格行无键盘可达性**：`<tr>` 不可聚焦，无法用键盘选中行触发操作。

**改进建议**：加 skip-link；给 SSH 对话框加 Esc 关闭（双击 Esc 或 Ctrl+Esc 区分控制字符）；Dialog 加 body 滚动锁；扩展快捷键（`/` `n` `?`）；nav-resize-handle 加方向键调整。

### 1.6 国际化

- **TaskNotificationWatcher 硬编码中文，完全没走 i18n**：[TaskNotificationWatcher.tsx:51-53、87-89](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L51)
  ```ts
  toast.info(
    permission === "denied" ? "系统通知未开启" : "当前环境不支持系统通知",
    permission === "denied" ? "实例成功或失败时将只显示应用内提示。" : undefined,
  );
  ```
  英文用户会看到中文 toast，**明确的 i18n bug**。
- **大量文案用内联 `text("中","En")` 而非 translation key**：i18n 字典只有约 80 个 key（[i18n.tsx:11-90](file:///d:/Projects/EasyConsole/src/lib/i18n.tsx#L11)），其余所有操作型文案散落在各组件（[TasksPage.tsx:540、639、669](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L540)、[AppShell.tsx:251-258](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L251)、[CommandPalette.tsx:72、135](file:///d:/Projects/EasyConsole/src/components/CommandPalette.tsx#L72)），无法统一审计漏译、无法做第三语言、改文案要逐文件找。
- **无复数/数量格式化支持**：`translate` 只做 `{{name}}` 替换（[i18n.tsx:190-194](file:///d:/Projects/EasyConsole/src/lib/i18n.tsx#L190)），无 ICU 复数。`text(\`${tasks.length} 个实例...\`, \`${tasks.length} instances...\`)`（[TasksPage.tsx:639、669、1132](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L639)）英文单复数会出错（"1 instances"）。
- **日期/数字未与 locale 联动**：[SettingsPage.tsx:485](file:///d:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L485) `new Date(...).toLocaleString()` 不传 locale；很多地方用 `slice(0,19).replace("T"," ")` 手动格式化（[TaskTemplatesPage.tsx:588、692](file:///d:/Projects/EasyConsole/src/pages/TaskTemplatesPage.tsx#L588)、[ScheduledTasksPage.tsx:519、582](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L519)）。
- **LanguageSwitch 无语言名称本地化**：[LanguageSwitch.tsx:22-25](file:///d:/Projects/EasyConsole/src/components/LanguageSwitch.tsx#L22) title 用 `language.zh`/`language.en`，但值是"中文"/"English"（[i18n.tsx:27-28](file:///d:/Projects/EasyConsole/src/lib/i18n.tsx#L27)），切换器本身没有"中文 / English"并列显示原文名。
- **切换语言无即时反馈**：用 `i18nText` 命令式获取文案的地方（[i18n-text.ts](file:///d:/Projects/EasyConsole/src/lib/i18n-text.ts)、[TasksPage.tsx:145](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L145)）在非组件上下文缓存了 locale，可能不随切换更新。

**改进建议**：修复 TaskNotificationWatcher 硬编码；把高频内联 `text()` 收敛进字典；引入 ICU MessageFormat 处理复数；日期统一用 `Intl.DateTimeFormat(locale)`。

### 1.7 桌面端集成

- **托盘菜单功能极少**：[TrayMenu.tsx:86-99](file:///d:/Projects/EasyConsole/src/components/TrayMenu.tsx#L86) 只有"显示主窗口/执行到期计划/退出"三项，无任务数概览、到期计数 badge、快速新建任务、通知历史。对"最小化到托盘跑后台"的核心场景，用户要恢复窗口才能看状态。
- **AppSshTerminalDialog 无重连按钮**：[AppSshTerminalDialog.tsx:144-148](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L144) 连接失败后只显示状态文字，用户无法点"重试连接"，只能关掉重开。
- **SSH 会话状态无持久指示**：最小化后只有一个小悬浮按钮（[AppSshTerminalDialog.tsx:325-340](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L325)），多会话时无法切换、看不到连接时长/最后输出。
- **更新下载无后台感知通知**：[app-update-context.tsx:243-249](file:///d:/Projects/EasyConsole/src/lib/app-update-context.tsx#L243) 下载完成才弹 toast，最小化到托盘时用户不知道下载进度。无"下载完成"系统通知（只用 in-app toast）。
- **系统通知权限被拒后只提示一次**：[TaskNotificationWatcher.tsx:46-54](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L46) 用 `permissionWarningRef` 去重，用户之后在系统设置里开了权限不会重新探测。

**改进建议**：托盘增加到期计数 badge 与任务概览；SSH 对话框加重连按钮与 Esc 关闭；更新下载完成发系统通知；通知权限变化时重新探测（visibilitychange）。

### 1.8 移动端/响应式

- **缺少中等屏（tablet）断点**：几乎所有响应式都用 `sm:`/`md:`/`lg:` 二分，无针对 768-1024 平板的专门优化。TasksPage 工具栏在中等屏会拥挤换行（[TasksPage.tsx:1049-1127](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1049)）。
- **表格在移动端依赖横向滚动**：ImagesPage/StoragePage/RunLogsPage 若未做卡片视图，移动端只能横向滚表格。
- **AppShell 顶栏在中等屏按钮拥挤**：[AppShell.tsx:458-498](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L458) 7 个元素，窄屏靠 `hidden sm:inline` 隐藏文字但按钮本身都在。
- **Dialog 在小屏几乎全屏但无明确全屏切换**：[ui.tsx:183](file:///d:/Projects/EasyConsole/src/components/ui.tsx#L183) 长表单（CreateTaskDialog）在小屏滚动体验差。
- **移动端 SSH 键盘栏在长会话下遮挡**：[AppSshTerminalDialog.tsx:256-315](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L256) 固定底部占用 44px 高度且无收起按钮。

**改进建议**：增加 tablet 断点优化工具栏折叠；为所有列表页补齐卡片视图；顶栏在窄屏折叠成单个"更多操作"菜单；Dialog 加全屏切换。

### 1.9 任务通知与监控

- **通知只监控前 100 个任务**：[TaskNotificationWatcher.tsx:13](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L13) `TASK_NOTIFICATION_PAGE_SIZE = 100`，且只取 `page: 1`（[TaskNotificationWatcher.tsx:24](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L24)）。用户超过 100 个实例时第 101 个之后的状态变化不会通知，且无任何提示"你已超出监控范围"。
- **TaskNotificationWatcher 硬编码中文**（见 1.6），英文用户收到的通知是中文。
- **监控面板只能外链打开**：[monitor-dashboard.ts:15-17](file:///d:/Projects/EasyConsole/src/lib/monitor-dashboard.ts#L15) `openMonitorDashboard` 直接 `browserRuntime.openExternal`，无内嵌 iframe/webview 预览，无 `var-pod` 之外的上下文。用户点了就跳出应用。
- **无通知中心/历史**：通知一旦 toast 消失或系统通知划掉就找不到了，RunLogs 里有操作日志但与"状态变化通知"不是同一套。
- **BackgroundScheduledTaskRunner 无"下次执行"倒计时**：[ScheduledTasksPage.tsx:510、572](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L510) 显示 `scheduleTime` 但无相对时间（"3 分钟后"），且 runner 本身无任何 UI 暴露运行状态。
- **批量定时任务执行无进度**：[BackgroundScheduledTaskRunner.tsx:60-104](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L60) 与 [ScheduledTasksPage.tsx:276-323](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L276) 顺序执行 + 逐条 toast，多个到期任务时会刷屏，且无总进度条。
- **监控 URL 仅传 var-pod**：无法按时间范围、节点等过滤，用户点进去还要在 Grafana 里手动调。

**改进建议**：通知分页或按重要性过滤；加通知中心历史；监控支持内嵌预览；定时任务显示相对时间与总进度；批量执行合并为单条汇总 toast。

### 1.10 设置与本地数据

- **导入对话框的 section 名是原始 key 未本地化**：[SettingsPage.tsx:577](file:///d:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L577) `<span>{section}</span>` 直接渲染 `settings`/`taskTemplates`/`scheduledTasks`/`runLogs`/`savedAccounts` 字符串。
- **导出文件名包含日期但无版本号**：[SettingsPage.tsx:237](file:///d:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L237) `easy-console-backup-YYYY-MM-DD.json`，同一天多次导出会覆盖，且无 schema 版本字段。
- **导入后提示"部分设置需要刷新"但不自动刷新**：[SettingsPage.tsx:280](file:///d:/Projects/EasyConsole/src/pages/SettingsPage.tsx#L280) 只 toast，用户要手动 F5。
- **SettingsPage 表单无 dirty 检测**（见 1.3）。
- **无"导出当前任务列表为 CSV/Excel"**：TasksPage 有下载任务 zip（[TasksPage.tsx:740-753](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L740)），但无导出当前筛选结果为表格的能力。
- **SavedAccounts 无法在 UI 内重命名或排序**：[LoginPage.tsx:110-139](file:///d:/Projects/EasyConsole/src/pages/LoginPage.tsx#L110) 只能直接登录或删除。
- **TaskTemplatesPage 模板无分类/标签**：[TaskTemplatesPage.tsx:559-770](file:///d:/Projects/EasyConsole/src/pages/TaskTemplatesPage.tsx#L559) 平铺所有模板，无分组、无搜索、无标签过滤。模板有 `usageCount`/`lastUsedAt`（[TaskTemplatesPage.tsx:585-590、690-693](file:///d:/Projects/EasyConsole/src/pages/TaskTemplatesPage.tsx#L585)）但无"按使用次数排序"。
- **ScheduledTasksPage 无启用/停用开关**：状态有 `paused`（[ScheduledTasksPage.tsx:41](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx#L41)），但 UI 里只有执行/删除，无法把计划暂停后再启用。
- **本地数据无自动备份**：导出全靠手动，无"每周自动导出到指定目录"选项。

**改进建议**：导入 section 名本地化；导出文件名加时间戳与 schema 版本；导入后提供"立即刷新"按钮；SettingsPage 加 dirty 离开拦截；TasksPage 加 CSV 导出；SavedAccounts 加排序/重命名；ScheduledTasksPage 加暂停/启用；模板加搜索与分组。

---

## 二、程序功能丰富性和完整性

### 2.1 任务管理

- **缺少编辑已存在任务的能力**：[api-factory.ts:139-141](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L139) `operateTask` 仅做 PUT 释放操作，不存在 `updateTask`/`editTask`；[CreateTaskDialog.tsx](file:///d:/Projects/EasyConsole/src/components/tasks/CreateTaskDialog.tsx) 始终走 `createTask`，克隆只能新建副本不能改原任务。
- **缺少独立的启动/停止/续费操作**：没有 `startTask`/`stopTask`/`renewTask` API，`operateTask` 语义不清晰（只释放）。
- **批量操作串行执行**：[TasksPage.tsx:636、666](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L636) `runSequentiallyWithDelay` 一旦中间失败即终止，无部分成功回执、无并发控制。
- **批量克隆受限**：`batchCount` 上限 50，但批量创建同样串行，失败不汇总。
- **任务状态变更通知依赖前端轮询**：无 WebSocket 推送，大规模列表下刷新延迟与请求量都偏高。

**改进建议**：与后端确认是否存在更新接口（如 PATCH `/instance/task/{id}`），若有则补 `updateTask` 并在 `CreateTaskDialog` 增加 `mode: "create" | "edit"` 分支；若后端无编辑接口，在"更多操作"菜单中明确标注"任务创建后不可编辑"。批量操作改为 `Promise.allSettled`，返回成功/失败计数与逐条结果清单。引入任务状态变更的 SSE/WebSocket 订阅以替代纯轮询。

### 2.2 任务模板

- **无变量替换系统**：[task-templates.ts](file:///d:/Projects/EasyConsole/src/lib/task-templates.ts) 模板字段都是字面值，不支持 `${variable}` 占位符或参数化输入（如镜像、CPU、脚本路径）。批量生成仅靠名称后缀区分。
- **无独立导入/导出模板文件**：只能通过 `local-data-backup.ts` 整体备份携带，无法单条 `.json` 分享或团队复用。
- **无模板分类/标签/收藏**：模板多了之后缺乏检索手段。
- **批量执行无 dry-run 预览**：点击执行直接调用创建接口，用户看不到生成的 50 条 payload 全貌。
- **运行中实例计数轮询开销大**：20 页 × 200 条 = 4000 条拉取（[TaskTemplatesPage.tsx](file:///d:/Projects/EasyConsole/src/pages/TaskTemplatesPage.tsx)），模板多时压力大。

**改进建议**：增加模板变量层 `variables: { key, label, defaultValue }[]`，执行时弹窗收集参数；提供单文件导入导出；批量执行前增加"预览 50 条名称与配置"的 dry-run 步骤；运行中计数改为按 `template_id` 字段过滤（若后端支持）。

### 2.3 定时任务

- **无循环/周期调度**：[scheduled-tasks.ts:72-76](file:///d:/Projects/EasyConsole/src/lib/scheduled-tasks.ts#L72) 仅 `scheduleTime`（单一 ISO 时刻），不支持 cron、不支持"每天 02:00"、不支持间隔重复。**最大缺口**。
- **`paused` 状态从未在 UI 中设置**：[scheduled-tasks.ts:26](file:///d:/Projects/EasyConsole/src/lib/scheduled-tasks.ts#L26) 允许该状态，但 [ScheduledTasksPage](file:///d:/Projects/EasyConsole/src/pages/ScheduledTasksPage.tsx) 无暂停/恢复按钮。
- **无编辑已有计划**：只能删除重建。
- **无重试策略**：失败后仅记录 `lastError`，无自动重试次数/退避。
- **无并发控制**：[BackgroundScheduledTaskRunner.tsx](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx) 用 `runningRef` 串行执行，多个到期任务排队，无并行上限配置；一旦一个任务卡住，后续全部阻塞。
- **执行回执薄弱**：`lastRunAt`/`lastError` 之外没有完整的执行历史（每次运行的开始/结束/结果）。
- **桌面端依赖窗口存活**：`BackgroundScheduledTaskRunner` 是 React 组件，窗口被完全关闭后只有托盘保活路径，移动端无后台保证。
- **30s 检查粒度**（[BackgroundScheduledTaskRunner.tsx:13](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L13) `CHECK_INTERVAL_MS = 30_000`）可能漏掉精确到秒的调度。

**改进建议**：引入 `recurrence` 字段（`{ type: "once" | "daily" | "weekly" | "cron", cron?: string }`），`isScheduleDue` 计算下一次触发；增加暂停/恢复按钮；增加 `maxRetries`/`retryDelaySec` 字段；维护 `executionHistory: ScheduledTaskExecution[]`；并发执行用 `p-limit` 或自实现信号量；桌面端考虑用 Tauri 后台线程或系统计划任务作为最终保底。

### 2.4 存储管理

- **无断点续传**：[api-factory.ts:283-295](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L283) 分片上传一旦中断，下次必须从头开始；无 `uploadId`/已传分片清单持久化。
- **无并行上传**：[StoragePage.tsx:169-227](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx#L169) `runUploadQueue` 顺序处理，大文件夹吞吐受限。
- **无可分享的外部链接**：下载只能落到本地，无生成临时签名 URL/分享链接的能力。
- **无上传/下载速度与剩余时间显示**：`UploadProgress` 仅 `loaded/total/percent`，无速率与 ETA。
- **无进度持久化**：刷新页面后队列丢失。
- **目录大小计算同步递归**：[remote-storage.ts](file:///d:/Projects/EasyConsole/src/lib/remote-storage.ts) `calculateDirectorySize` 大目录会阻塞 UI 且可能超时。
- **`readTextFile` 1MB 上限**对大日志不友好，且无分页读取。

**改进建议**：断点续传——本地存储 `{ fileId, uploadedChunks[], md5 }`，中断后调用后端"查询已传分片"接口或自记录，跳过已完成分片；引入并发上传（默认 3 路并发，可配置）；速度/ETA 差分计算；队列持久化到 `runtime-storage.json`；目录大小计算改为流式 + 取消信号 + 增量显示；文本预览支持"加载更多"分页。

### 2.5 镜像管理

- **无用户级收藏/星标**：[ImagesPage.tsx](file:///d:/Projects/EasyConsole/src/pages/ImagesPage.tsx) 不能标记常用镜像，长列表下检索成本高。
- **无详情对话框**：`imageApi.detail` 存在（[api-factory.ts:167-192](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L167)）但页面未调用，用户看不到镜像的完整字段（创建时间、大小、依赖、命令等）。
- **无"从零构建镜像"**：只能从运行中任务 `commitImage` 提交，无 Dockerfile 式构建入口。
- **下载无进度/取消**：`imageApi.download` 支持 `signal`/`onProgress`，但 ImagesPage 的下载按钮未传递这些选项。
- **无镜像分类/标签筛选**：仅"自定义/系统"二分。
- **commit 入口分散**：在 TasksPage 而非 ImagesPage（[TasksPage.tsx:790-811](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L790)），违反就近原则。

**改进建议**：增加本地收藏列表（存 `runtime-storage.json`）；ImagesPage 点击行打开详情 Dialog 展示全字段；下载按钮接入 `signal` + `onProgress`；将 `commitImage` 入口也在 ImagesPage 提供"从实例提交"向导。

### 2.6 SSH 与终端

- **无 SSH 密钥管理 UI**：[lib.rs:374-417](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L374) 自动生成 ed25519 并写入 `authorized_keys`，但用户看不到已部署的密钥列表，无法手动添加/删除/轮换。
- **无 known_hosts 审阅界面**：[lib.rs:134-144](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L134) `trust_on_first_use` 静默接受，缺乏"指纹变更警告"的可视化。
- **WebSSH 与桌面 SSH 不统一**：WebSSH 走后端 WebSocket（共享后端凭据），桌面 SSH 走 russh（本地直连），两者会话不互通，体验割裂。
- **应用内 SSH 无多标签/分屏**：一次只能开一个会话。
- **无会话录制/回放**：运维审计场景缺失。
- **无 SFTP 文件传输**：`russh` 支持 SFTP 但未暴露命令，无法在终端内上传/下载文件。
- **VS Code 配置依赖桌面端**：Web 用户只能复制 SSH 命令，无法一键生成 `~/.ssh/config` 片段。
- **移动端键盘栏缺 Ctrl+Shift 组合、Alt 键、自定义键**。

**改进建议**：新增"SSH 密钥管理"页；known_hosts 审阅 Dialog；桌面端提供"SFTP 文件浏览器"；应用内 SSH 支持多标签 + 左右分屏；Web 端提供"复制 SSH config 片段"按钮；移动端键盘栏支持自定义按键与 Ctrl+Shift/Alt 组合。

### 2.7 监控

- **无 iframe 嵌入**：必须跳转到外部浏览器，应用内无监控视图，割裂感强。
- **无原生指标展示**：`monitorIndex` API 存在（[api-factory.ts:154-156](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L154)）却未被调用，可能是后端返回的 CPU/内存/网络等指标未在 UI 落地。
- **无时间范围选择**：Grafana 链接固定时间范围，不能从 EasyConsole 传 `from`/`to` 参数。
- **无告警集成**：看不到 Grafana 告警状态。
- **多 Pod 聚合缺失**：一次只能看单任务，无"选中多任务批量查看仪表盘"。

**改进建议**：在 `TerminalDialog` 或任务详情中嵌入 Grafana iframe（桌面端用 `<webview>` 绕过 CSP）；调用 `monitorIndex` 并在任务行内联展示迷你 sparkline；Grafana URL 支持 `?from=now-1h&to=now` 参数；多选任务时生成 `var-pod=pod1|pod2` 多值链接。

### 2.8 运行日志

- **无日志聚合/去重**：同类操作（如轮询刷新）可能产生大量相似日志，无"按 action 聚合"或"去重计数"。
- **无级别筛选**：`level` 字段存在但页面筛选器无 level 选项（info/warn/error）。
- **导出仅 JSON**：无 CSV、无可读文本报告。
- **无审计签名**：日志可被本地清空，无防篡改（对合规场景不足，但本地工具可接受）。
- **无按用户/目标筛选**：`userName`/`targetId` 字段存在但未做筛选项。
- **无日志搜索的高级语法**：不支持 `action:task.create AND result:success` 这类结构化查询。
- **保留策略不可配置**：30 天/1000 条硬编码（[run-logs.ts:4-5](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L4)）。

**改进建议**：增加 `level` 筛选下拉；导出支持 CSV 与 Markdown 报告格式；高级搜索框支持 `key:value` 语法；保留策略在 SettingsPage 可配置；增加"按 action 分组统计"视图。

### 2.9 账户与认证

- **无 token 刷新**：[auth-context.tsx](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx) 无 `refreshToken` 逻辑，token 过期只能 `UNAUTHORIZED_EVENT` → 登出，用户需重新输入密码。**显著体验缺口**。
- **无 MFA/2FA**。
- **无"记住我"时长配置**：token 永久存到 `runtime-storage.json` 直到手动登出，无过期时间。
- **无登录失败锁定/限流**：本地无失败计数，后端限流不可见。
- **无会话多设备管理**：看不到"当前账号在哪些设备登录"。
- **savedAccounts 上限 5**（[saved-accounts.ts:4](file:///d:/Projects/EasyConsole/src/lib/saved-accounts.ts#L4)）：多账号用户受限，且无搜索/排序。
- **无密码强度提示**。
- **token 存储未加密**：桌面端 `runtime-storage.json` 明文存 token（见 3.7）。

**改进建议**：与后端确认是否有 refresh token 接口，若有则在 `auth-context` 中实现静默刷新；若无，在 token 临过期前弹窗提示续期；`MAX_SAVED_ACCOUNTS` 提升至 10 或可配置；桌面端用操作系统密钥库（Tauri `keyring` 插件）存 token；改密流程增加密码强度指示器。

### 2.10 CLI 与 MCP

**CLI/MCP 缺失能力**（与 Web 端对比）：
- 任务模板（`task-templates`）：无 CLI/MCP 命令。
- 定时任务（`scheduled-tasks`）：无 CLI/MCP 命令。
- 镜像提交（`commitImage`）：Web 端有，CLI/MCP 无。
- 镜像下载（`imageApi.download`）：API 有，CLI/MCP 无。
- 镜像详情（`imageApi.detail`）：API 有，CLI/MCP 无。
- 批量任务操作（`deleteTasks`）：CLI/MCP 仅单条。
- 存储上传（`uploadLocalFile`）：CLI/MCP 无上传命令，只能下载。
- 监控嵌入：CLI/MCP 仅 `monitor_url`，无指标查询（可调用 `monitorIndex`）。
- 仪表盘统计（`statics`/`staticsCost`）：CLI/MCP 无 dashboard 命令。
- 账号管理：`login` 有，但 `changePassword`、`savedAccounts` 管理、`logout` 无。
- 本地数据备份：CLI/MCP 无。

**其他不足**：
- 输出格式单一：CLI 主要是 JSON/表格，无 YAML/CSV。
- MCP 工具无分页/筛选参数透传需确认。
- MCP 无批量工具：无 `easyconsole_task_batch_release` 等。
- CLI 无交互式 TUI：无 `task create` 的交互式向导（只能 `--flags`）。
- CLI 无配置文件：`EASY_CONSOLE_CONFIG` 存在但无 `ec config init` 向导。
- MCP 无资源（Resources）暴露：只暴露 Tools，无 `easyconsole://task/{id}` 资源 URI，IDE 集成度有限。

**改进建议**：补齐 CLI/MCP 与 Web 端的能力对齐表（模板、定时任务、镜像提交/下载/详情、存储上传、批量操作、dashboard 统计、改密、备份）；CLI 增加 `task template list/apply/delete`、`schedule list/create/run/delete`、`image commit/download/detail`、`storage upload`、`dashboard`、`account change-password`、`backup export/import`；MCP 增加对应工具并暴露 Resources；CLI 增加交互式向导；支持 YAML/CSV 输出。

### 2.11 桌面能力

- **无自动更新实际触发**：`updater` 插件注册了，但 [app-update.ts](file:///d:/Projects/EasyConsole/src/lib/app-update.ts) 是手动检查 GitHub Release，未走 Tauri 原生 updater。两套机制并存且不统一。
- **无全局快捷键**：未注册快捷键唤起窗口或快速操作。
- **无深链接（deep link）**：`tauri-plugin-deep-link` 未启用，无法 `easyconsole://task/123` 直接跳转。
- **无文件关联**：不能双击 `.ec-template.json` 直接导入模板。
- **托盘菜单功能有限**：[TrayMenu.tsx](file:///d:/Projects/EasyConsole/src/components/TrayMenu.tsx) 仅显示/退出。
- **移动端能力薄弱**：仅 `install_apk`，无 iOS 对应、无移动端后台保活、无移动端文件分享。
- **无多窗口**：SSH 终端、监控仪表盘都挤在主窗口。
- **无原生菜单栏**：无 File/Edit/View 顶层菜单。
- **托盘与定时任务保活耦合不清**：[lib.rs:1131-1140](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1131) `start_desktop_run_due_timer` 在 Tauri 后台跑 30s 定时器，与前端 `BackgroundScheduledTaskRunner` 的 `navigator.locks` 协作关系文档化不足。

**改进建议**：统一更新机制——迁移到 Tauri 原生 updater；启用 `tauri-plugin-deep-link`；注册全局快捷键；SSH 终端支持"在新窗口打开"；增加原生菜单栏；移动端增加文件分享；文档化托盘 + 前端 + Tauri 定时器三者协作的状态机。

### 2.12 仪表盘

- **无刷新按钮、无自动刷新**：数据进入页面后不会更新，需用户手动导航触发。
- **无图表**：纯数字 + 表格，无趋势图、无成本曲线、无 CPU/内存历史。
- **无成本按用户/分组分解**：`cost_map` 是聚合值，看不到"哪个用户/项目花了多少"。
- **无告警/异常任务高亮**：最近任务表不区分状态颜色（虽有 badges，但无聚合"异常任务"卡片）。
- **无时间范围切换**：固定 week/month/day，不能自定义。
- **无导出仪表盘数据**：不能导出 CSV 给汇报用。

**改进建议**：增加刷新按钮 + 自动刷新（可配置 30/60s）；引入轻量图表库（如 `recharts`）；`cost_map` 按 user/group 维度展开；增加"异常任务"红色卡片；时间范围选择器；导出仪表盘快照为 CSV。

### 2.13 数据备份

- **无加密**：[local-data-backup.ts](file:///d:/Projects/EasyConsole/src/lib/local-data-backup.ts) 备份文件明文 JSON，含 token 时任何拿到文件的人可直接登录。
- **无版本迁移**：`VERSION = 1`，未来字段变更无 `migrateBackup` 路径。
- **无选择性导出**：导出是全量 sections（除密钥开关），不能只导出"模板"。
- **无云同步/异地备份**：仅本地文件，设备丢失即丢数据。
- **无自动备份**：用户需手动触发。
- **无备份合并策略**：导入是覆盖，无"合并模板（去重）"模式。
- **无备份完整性校验**：无 hash/checksum。

**改进建议**：备份文件支持密码加密（AES-GCM）；增加 `migrateBackup(oldVersion)` 路径；导出支持 section 多选；桌面端支持"自动备份到指定目录（每周）"；导入支持"合并模式"；备份文件含 SHA-256 校验字段。

### 2.14 与原始控制台对比

`reference/original-console/` 仅包含压缩后的 webpack 产物（`app.f36c1631.js` 等），无可读源码，只能进行结构性对比。

**结构对比结论**：
- 原始控制台基于 **Element UI（Vue 2 生态）**；EasyConsole 是 React 18 + 自研 UI + Tauri。
- 原始控制台是纯 Web SPA；EasyConsole 提供 Web + 桌面（Tauri）+ CLI + MCP 四端，是显著增强。
- 原始控制台无模板/定时任务/运行日志的本地化概念；EasyConsole 引入本地运行时存储，是新增能力。
- 原始控制台仅有 WebSSH（WebSocket）；EasyConsole 增加 russh 应用内 SSH、VS Code Remote-SSH、系统终端，是显著增强。
- 原始控制台语言不明；EasyConsole 明确支持 zh-CN/en-US 切换。

**潜在缺失**：由于无法阅读原始控制台业务代码，无法确认其是否具备 EasyConsole 缺失的能力（如任务编辑、循环调度、token 刷新）。

**改进建议**：用 `webcrack` 反编译原始控制台 JS，提取路由表与 API 路径，生成功能清单矩阵；在 `docs/` 维护一张"原始控制台 vs EasyConsole"功能对照表。

---

## 三、项目架构鲁棒性和稳定性

### 3.1 类型系统

**优点**：
- 全面使用 `UnknownRecord` 交叉类型对后端不确定字段容错（[types.ts:24-31](file:///d:/Projects/EasyConsole/src/lib/types.ts#L24)）。
- 全量搜索 `src` 目录，**未发现 `: any`、`as any`、`<any>`、`Record<string, any>` 等滥用**。
- 业务字段拼写问题已按 AGENTS.md 要求保留：`releace_conditions`（后端拼写错误）与 `release_condition` 双字段并存（[types.ts:82-83](file:///d:/Projects/EasyConsole/src/lib/types.ts#L82)）。
- `tsconfig.app.json` 启用 `"strict": true`（[tsconfig.app.json:11](file:///d:/Projects/EasyConsole/tsconfig.app.json#L11)）。

**不足**：
- `TaskStatus` 类型定义为 `0 | 1 | ... | 8 | number`（[types.ts:33](file:///d:/Projects/EasyConsole/src/lib/types.ts#L33)），`| number` 让整个联合类型退化为 `number`，失去字面量校验价值。建议去掉 `| number`，改用 `(0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) & number` 或保留一个 `TaskStatusUnknown` 别名。
- `local-data-backup.ts` 中存在 `as never` 强转以绕过类型检查（[local-data-backup.ts:105、108](file:///d:/Projects/EasyConsole/src/lib/local-data-backup.ts#L105)）。导入备份时未对 `taskTemplates`/`scheduledTasks` 做逐字段归一化，直接信任外部 JSON，存在类型安全空洞。

### 3.2 API 客户端

**优点**：
- 错误分类清晰：`ApiError` 区分 `http`/`business`/`network`/`parse` 四类（[types.ts:8-22](file:///d:/Projects/EasyConsole/src/lib/types.ts#L8)、[api-client.ts:108-119](file:///d:/Projects/EasyConsole/src/lib/api-client.ts#L108)）。
- 401 与业务码 10000 统一触发 `UNAUTHORIZED_EVENT` 事件，由 `AuthProvider` 监听并登出（[api-client.ts:41、48-52](file:///d:/Projects/EasyConsole/src/lib/api-client.ts#L41)、[auth-context.tsx:173-179](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L173)）。
- Blob 端点正确避免 envelope 解包（[api-client.ts:121-123](file:///d:/Projects/EasyConsole/src/lib/api-client.ts#L121)）。
- 请求超时默认 20s，上传分片 300s（[runtime.ts:155-156](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L155)、[api-factory.ts:239](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L239)）。

**不足**：
- **无自动重试机制**。网络抖动或临时 5xx 会直接失败。React Query 层仅有 `retry: 1`（[main.tsx:19](file:///d:/Projects/EasyConsole/src/main.tsx#L19)），但 mutation 默认不重试。建议在 `ApiClient.request` 或关键查询上增加可配置的指数退避重试（至少对 `network` 类错误和 502/503/504）。
- **无请求并发限制**。批量删除/释放使用 `runSequentiallyWithDelay` 串行（[TasksPage.tsx:636](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L636)），但其他场景无节流。
- `unwrapEnvelope` 对 `code === 10000` 触发登出，但**未对其他业务错误码做精细化处理**（如权限不足、资源冲突）。
- `extractToken` 直接读取 `record.Authorization` 字段（[api-client.ts:58](file:///d:/Projects/EasyConsole/src/lib/api-client.ts#L58)），但后端登录响应字段是 `token`/`access`/`access_token`，`Authorization` 分支可能永远命中不到，属于死代码或过度防御。
- `checkTaskName` 把查询参数手动拼到 URL（`?name=...`）（[api-factory.ts:137](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L137)），绕过了 `buildUrl` 的统一 query 序列化。

### 3.3 运行时边界

**优点**：
- `RuntimeTransport` 抽象层设计良好，通过 `isDesktop`/`isMobile`/`runtimeKind` 能力位区分三端（[types.ts:307-343](file:///d:/Projects/EasyConsole/src/lib/types.ts#L307)、[runtime.ts:346-469](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L346)）。
- 桌面-only 能力（托盘、系统终端、文件定位）均通过 `runtimeKind === "desktop"` 守卫（[runtime.ts:361-375](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L361)）。
- `initRuntimeKind` 对 Tauri 平台检测有 3s 超时保护（[runtime.ts:49-58](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L49)）。

**不足**：
- `runtime.ts` 中**直接 import 了 `@tauri-apps/api/core` 的 `isTauri`**（[runtime.ts:1](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L1)），且包含 `window.localStorage`/`window.fetch`/`window.navigator` 等浏览器全局（[runtime.ts:66-74、164、382](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L66)），在 Node 环境会失败。CLI/MCP 实际有独立的 `node-runtime.ts` 绕开。
- `fetchRequest` 中 `credentials: "include"` 硬编码（[runtime.ts:170](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L170)），对于跨域请求会发送 cookie，增加 CSRF 面。建议按需可配。
- `buildUrl` 使用 `new URL(url, window.location.origin)`（[runtime.ts:105](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L105)），在 Tauri 环境 `window.location.origin` 可能是 `tauri://localhost`，相对地址场景下行为需验证。

### 3.4 状态管理

**优点**：
- Context 拆分合理：`Auth`、`AppUpdate`、`CommitQueue`、`DownloadQueue`、`RunLogger`、`Toast`、`I18n` 各自独立（[main.tsx:30-44](file:///d:/Projects/EasyConsole/src/main.tsx#L30)）。
- `AuthProvider` 使用 `useMemo` 包裹 value（[auth-context.tsx:181-184](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L181)）。
- `CommitQueueProvider` 与 `DownloadQueueProvider` 使用 `runningRef` 保证单任务串行执行（[commit-queue-context.tsx:46](file:///d:/Projects/EasyConsole/src/lib/commit-queue-context.tsx#L46)、[download-queue-context.tsx:54](file:///d:/Projects/EasyConsole/src/lib/download-queue-context.tsx#L54)）。
- `savedAccountsRef` 避免 `login` 回调依赖 `savedAccounts` 状态导致闭包陈旧（[auth-context.tsx:34、117](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L34)）。

**不足**：
- `AuthProvider` 初始化 `useEffect` 的 Promise 链**无 catch 处理**（[auth-context.tsx:36-54](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L36)），若 `storage.get` 抛错，`ready` 永远不会变为 `true`，应用卡在加载态。建议补 `.catch` 并设置 `ready` 以降级。
- `auth-context.tsx:56-66` 的 `userInfo` 恢复逻辑，失败时静默清除 token，但未记录 run log，排障困难。
- `CommitQueueProvider` 与 `DownloadQueueProvider` 的 `runNext` 依赖 `useEffect(() => { runNext(); }, [items, runNext])`（[commit-queue-context.tsx:114-116](file:///d:/Projects/EasyConsole/src/lib/commit-queue-context.tsx#L114)、[download-queue-context.tsx:153-155](file:///d:/Projects/EasyConsole/src/lib/download-queue-context.tsx#L153)），每次 `items` 变化都触发 `runNext`，在高速进度更新下产生不必要函数调用噪声。
- `DownloadQueueProvider` 进度回调每次 `setItems` 都 `map` 全量数组（[download-queue-context.tsx:84-97](file:///d:/Projects/EasyConsole/src/lib/download-queue-context.tsx#L84)），大文件高频进度会引发全表重渲染。建议用 ref + 节流，或按 id 局部更新。
- `RunLoggerProvider` 的 value 未 memoize（[RunLoggerProvider.tsx:19](file:///d:/Projects/EasyConsole/src/components/RunLoggerProvider.tsx#L19)），每次 Provider 重渲染都生成新对象。
- `jobsRef`/`controllersRef` 在 `clearCompleted` 时才清理（[commit-queue-context.tsx:138-147](file:///d:/Projects/EasyConsole/src/lib/commit-queue-context.tsx#L138)），若用户从不清理且队列无限增长，Map 会累积无用引用。建议设置上限或定期 GC。

### 3.5 测试覆盖

**优点**：
- `src/lib` 下测试覆盖非常充分，几乎所有 `.ts` 模块都有对应 `.test.ts`：25+ 个测试文件。
- Rust 侧有 `trust_on_first_use` 单元测试（[lib.rs:1497-1505](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1497)）。
- 测试覆盖关键边界：envelope 解析、token 归一化、密码哈希、文件名清洗（含 Windows 保留名）、空文件上传 fallback、TOFU 主机指纹。

**不足**：
- **页面测试严重缺失**。11 个页面中仅 `DashboardPage`、`RunLogsPage`、`TasksPage.menu`（仅菜单交互）有测试，其余 `LoginPage`、`SettingsPage`、`StoragePage`、`ImagesPage`、`ScheduledTasksPage`、`TaskTemplatesPage` 无测试。
- **组件测试稀疏**。`src/components` 下仅 `CommandPalette`、`ConfirmDialog`、`DataState`、`TaskInstanceName`、`TerminalDialog` 有测试。关键组件如 `AppShell`、`TaskNotificationWatcher`、`BackgroundScheduledTaskRunner`、`AppSshTerminalDialog`、`CreateTaskDialog`、`StoragePage` 的上传流程均无测试。
- **无集成测试**。无端到端流程测试（如 登录 -> 列表 -> 创建任务 -> 上传 -> 下载），无 MSW（mock service worker）拦截真实请求的组件树测试。
- **无 Tauri 命令的集成验证**。Rust 侧仅 1 个单元测试，SSH 会话生命周期、storage 读写并发、tray 交互均无测试。

### 3.6 Tauri 命令

**优点**：
- Rust 错误处理规范：命令统一返回 `Result<T, String>`，错误消息为中文人类可读字符串（[lib.rs:105-112、114-128](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L105)）。
- **全文件仅 1 处 `panic!`**（[lib.rs:1434](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1434)，`builder.build` 失败时，启动致命错误可接受）。**无 `unwrap()`/`expect()` 滥用**。
- `Mutex::lock()` 均通过 `map_err` 转 `String`（[lib.rs:874-876、981-984](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L874)）。
- 输入校验充分：`validate_host`（[lib.rs:187-199](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L187)）、`validate_username`（[lib.rs:209-221](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L209)）、`validate_external_url`（[lib.rs:273-285](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L273)）、`validate_local_path`（[lib.rs:288-301](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L288)）。
- SSH host key 校验采用 TOFU（[lib.rs:134-144、146-161](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L134)），指纹变化时拒绝连接。

**不足**：
- **`verify_known_host` 用 `unwrap_or(false)` 吞掉读取/写入 known_hosts 的错误**（[lib.rs:101](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L101)）。若 `app_data_file` 失败（磁盘满、权限问题），SSH 连接会静默失败，用户看到的是"SSH 连接失败"而非根因。建议把错误传播出去并提示。
- **capabilities 配置过宽**。`fs:scope` 允许 `$DOWNLOAD/**`、`$DOCUMENT/**`、`$DESKTOP/**`（[default.json:30-35](file:///d:/Projects/EasyConsole/src-tauri/capabilities/default.json#L30)），但实际下载只需 `$DOWNLOAD`。`http:default` 允许 `http://*:*/*` 与 `https://*:*/*`（[default.json:16-21](file:///d:/Projects/EasyConsole/src-tauri/capabilities/default.json#L16)），无域名白名单。建议收紧到已知后端 host 与监控面板 host。
- `open_ssh_session` 命令在 `validate_host`/`parse_port`/`validate_username` 通过后即返回 `session_id`（[lib.rs:860-897](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L860)），实际连接是 `tauri::async_runtime::spawn` 异步进行。**无连接超时**：`run_russh_session` 中 `client::connect` 无超时（[lib.rs:765-767](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L765)），网络不通时会一直挂起。建议为 `connect` 加 `tokio::time::timeout`。
- `runtime_storage_get/set/remove` 每次都全量读写 `runtime-storage.json`（[lib.rs:922-943](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L922)），高频写入会有 IO 放大与并发写竞态（无文件锁）。两个并发 `set` 可能互相覆盖。建议引入写锁或内存缓存 + 去抖落盘。
- `install_vscode_public_key` 通过 SSH 执行远端 shell 命令拼接 `authorized_keys`（[lib.rs:644-647](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L644)），`shell_single_quote` 转义了公钥（[lib.rs:474-476](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L474)），但整体命令注入面需审视。
- `spawn_ssh_terminal` 在 Windows 上拼接 `wt`/`powershell` 参数（[lib.rs:532-561](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L532)），`task_name` 作为 `--title` 参数传入，未转义。虽然 `Command::new` 不走 shell，但恶意 task_name 含特殊字符可能导致参数注入。建议对 title 做清洗。

### 3.7 安全

**优点**：
- **无 `dangerouslySetInnerHTML`、无 `eval`、无 `new Function`、无 `innerHTML`**（全量搜索确认），XSS 注入面小。
- 文件下载名清洗到位：`sanitizeDownloadFilename` 移除 `<>:"/\|?*`、控制字符、Windows 保留名，限长 180（[download.ts:6-17](file:///d:/Projects/EasyConsole/src/lib/download.ts#L6)）。
- run logs 元数据脱敏：`SENSITIVE_KEY_PATTERN` 匹配 `authorization|bearer|cookie|password|secret|token|passwd|pwd`（[run-logs.ts:57](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L57)），限深度 5、字符串 1000 字符、JSON 12KB。
- SSH host key TOFU 校验。
- VS Code 专用 SSH key 存放在 app data 目录而非用户 `.ssh`，权限 `0600` 由 `ssh-keygen` 保证（[lib.rs:374-417](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L374)）。

**不足（高优先级）**：
- **Token 明文存储**。`TOKEN_STORAGE_KEY` 直接存 `Bearer ...` 到 localStorage 或 `runtime-storage.json`（[auth-context.tsx:84、121](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L84)）。`saved-accounts.ts` 也明文存 token（[saved-accounts.ts:46](file:///d:/Projects/EasyConsole/src/lib/saved-accounts.ts#L46)）。localStorage 可被 XSS 读取，`runtime-storage.json` 可被同机其他进程读取。建议使用 Tauri 的 keychain/secure storage 或至少加密。
- **密码哈希无加盐**。`sha256Hex(password)` 直接对明文做 SHA-256（[crypto.ts:1-7](file:///d:/Projects/EasyConsole/src/lib/crypto.ts#L1)），无 per-user salt、无慢哈希（PBKDF2/bcrypt/argon2）。彩虹表攻击风险高。建议至少客户端做 HMAC-SHA256（server 提供的 challenge/salt）或改用慢哈希。
- **CSRF 风险**。`fetchRequest` 硬编码 `credentials: "include"`（[runtime.ts:170](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L170)），但请求仅靠 `Authorization` header 鉴权，无 CSRF token。若后端同时接受 cookie 鉴权，则存在 CSRF。当前看鉴权基于 Bearer token，CSRF 面较小，但 `credentials: include` 仍是不必要的暴露。
- **CLI 配置文件明文存 token**。`saveEasyConsoleConfig` 将 `token` 明文写入 `~/.easy-console/config.json`（[config.ts:74-81](file:///d:/Projects/EasyConsole/tools/easy-console/config.ts#L74)），文件权限未设置。建议 `chmod 600`。
- **SSH 密码明文传输到前端**。任务列表返回的 `ssh_password`/`password` 字段（[types.ts:53-54](file:///d:/Projects/EasyConsole/src/lib/types.ts#L53)）被 `buildTaskSshInfo` 提取并显示在终端对话框（虽用 `••••••••` 遮罩，[TerminalDialog.tsx:31](file:///d:/Projects/EasyConsole/src/components/tasks/TerminalDialog.tsx#L31)，但可复制）。这是后端设计问题，但前端也明文持有。

### 3.8 持久化

**优点**：
- run logs 裁剪策略完善：默认 1000 条、30 天（[run-logs.ts:4-5、153-166](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L4)）。
- saved accounts 上限 5 个（[saved-accounts.ts:4](file:///d:/Projects/EasyConsole/src/lib/saved-accounts.ts#L4)）。
- `parseRunLogs`/`parseSavedAccounts`/`parseAppSettings` 对损坏 JSON 容错，返回默认值。
- 数据备份/恢复有版本号 `LOCAL_DATA_BACKUP_VERSION = 1`（[local-data-backup.ts:9](file:///d:/Projects/EasyConsole/src/lib/local-data-backup.ts#L9)）。

**不足**：
- **无数据迁移机制**。`LOCAL_DATA_BACKUP_VERSION` 仅用于备份文件格式版本，运行时存储无 schema 版本字段。若未来调整 `AppSettings` 结构，旧数据只能回退默认。
- **`runtime-storage.json` 无并发保护**（见 3.6），多窗口或快速连续写入会丢数据。
- `TasksPage` 的列可见性、自动刷新设置直接写 localStorage（[TasksPage.tsx:1004-1014](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1004)），未走 `browserRuntime.storage` 适配层。
- `loadColumnVisibility` 有手工迁移逻辑（`cost` -> `duration`，[TasksPage.tsx:202-205](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L202)），但无版本号。

### 3.9 错误边界

**严重不足**：
- **全项目无 React ErrorBoundary**。搜索 `ErrorBoundary`、`componentDidCatch`、`getDerivedStateFromError` 均无结果。`App.tsx`（[App.tsx:24-62](file:///d:/Projects/EasyConsole/src/App.tsx#L24)）与 `main.tsx`（[main.tsx:29-44](file:///d:/Projects/EasyConsole/src/main.tsx#L29)）均未包裹 ErrorBoundary。
- **无全局 `window.onerror`/`unhandledrejection` 处理**。
- 任何组件渲染期抛错（如后端返回畸形数据导致 `task.status` 访问异常）会使整个应用白屏，用户只能刷新。

**建议**：
- 在 `App` 外层包裹至少一个顶层 ErrorBoundary，展示友好错误页 + 重试按钮 + 上报 run log。
- 对关键路由（TasksPage、StoragePage）单独包裹 ErrorBoundary，避免局部崩溃影响全局。
- 注册 `window.addEventListener("unhandledrejection", ...)` 捕获未处理的 Promise 拒绝。

### 3.10 副作用清理

**优点**：
- `AppSshTerminalDialog` 的 `useEffect` 清理完整（[AppSshTerminalDialog.tsx:151-161](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L151)）。
- `BackgroundScheduledTaskRunner` 清理定时器、事件监听、background lock、Tauri 事件监听（[BackgroundScheduledTaskRunner.tsx:128-137](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L128)）。
- `fetchRequest` 在 `finally` 中移除 abort 监听并清超时（[runtime.ts:189-192](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L189)）。
- `AppUpdateProvider` 用 `cancelled` 标志防止卸载后 setState（[app-update-context.tsx:80-87](file:///d:/Projects/EasyConsole/src/lib/app-update-context.tsx#L80)）。

**不足**：
- `TaskNotificationWatcher` 的 `useEffect`（[TaskNotificationWatcher.tsx:35-55](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L35)）调用 `browserRuntime.requestSystemNotificationPermission().then(...)`，**无 `cancelled` 标志**，组件卸载后 `toast.info` 仍可能触发。
- `TaskNotificationWatcher` 的第二个 effect（[TaskNotificationWatcher.tsx:57-99](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L57)）在轮询场景下高频触发；`browserRuntime.notifySystem` 是 fire-and-forget，无清理。
- `AuthProvider` 初始化 effect（[auth-context.tsx:36-54](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L36)）无 `cancelled` 标志，StrictMode 双调用下可能重复执行。

### 3.11 并发与竞态

**优点**：
- `CommitQueueProvider`/`DownloadQueueProvider` 用 `runningRef` 保证串行。
- `BackgroundScheduledTaskRunner` 用 `runningRef` + Web Locks API（`navigator.locks`）保证多窗口单实例执行（[BackgroundScheduledTaskRunner.tsx:24-43、49](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L24)）。
- 任务列表轮询通过 React Query 的 `refetchInterval`，且有 `autoRefreshPaused` 在对话框打开时暂停（[TasksPage.tsx:695-701](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L695)）。
- `TaskNotificationWatcher` 用 `initializedRef` 避免首次加载误发通知（[TaskNotificationWatcher.tsx:18、63](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L18)）。

**不足**：
- **`BackgroundScheduledTaskRunner` 与 Tauri 侧 `start_desktop_run_due_timer`（30s 间隔，[lib.rs:1131-1140](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1131)）同时触发**。前端有 30s `setInterval`（[BackgroundScheduledTaskRunner.tsx:115](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L115)），Tauri 也每 30s emit `desktop-run-due-scheduled-tasks`（[lib.rs:1137](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1137)），前端还监听该事件（[BackgroundScheduledTaskRunner.tsx:120](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L120)）。虽有 `runningRef` 兜底，但双源触发冗余。
- **上传队列无断点续传**（见 2.4）。
- **SSH 会话事件竞态**。`AppSshTerminalDialog` 中 `openSshSession` 返回 `sessionId` 后才注册 `onSshSessionEvent`（[AppSshTerminalDialog.tsx:118-124](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L118)）。若连接极快建立并在注册监听前就 emit 了 `status`/`output` 事件，会丢失。建议先注册监听再开连接，或用 `sessionId` 做事件缓冲。
- **`TaskNotificationWatcher` 与 `TasksPage` 各自独立轮询**（前者 10s，后者可配 5/10/30s），两个 `instanceApi.tasks` 查询 key 不同（`task-notification-watch` vs `taskQueryKey`），无缓存共享，产生双倍后端请求。建议共用一个查询 key 或用 `staleTime` 复用。

### 3.12 配置与环境变量

**优点**：
- `api-client.ts` 对 `import.meta.env` 做了类型断言保护（[api-client.ts:5-6](file:///d:/Projects/EasyConsole/src/lib/api-client.ts#L5)）。
- `app-settings.ts` 对 `VITE_MONITOR_DASHBOARD_URL` 同样保护（[app-settings.ts:35-36](file:///d:/Projects/EasyConsole/src/lib/app-settings.ts#L35)）。
- CLI/MCP 配置有 env > config file > default 的优先级（[config.ts:56-72](file:///d:/Projects/EasyConsole/tools/easy-console/config.ts#L56)）。

**不足**：
- **`.env` 无校验**。`.env.example`（[.env.example:1-2](file:///d:/Projects/EasyConsole/.env.example#L1)）仅两行，无 schema 校验。若 `VITE_API_BASE_URL` 写错（如漏掉 `/api` 后缀），应用启动后所有请求 404，但无早期告警。建议在 `initRuntimeKind` 后增加一次 `apiBaseUrl` 合法性校验。
- **默认 API base 硬编码公网 IP** `http://116.172.93.164:28080/api`（[api-client.ts:4](file:///d:/Projects/EasyConsole/src/lib/api-client.ts#L4) 与 [.env.example:1](file:///d:/Projects/EasyConsole/.env.example#L1)）。这是测试环境地址，不应作为代码默认值。建议默认值为空字符串并在启动时强校验。
- `vite.config.ts` 无 `envPrefix` 限制（默认只暴露 `VITE_` 前缀，安全），但无 `define` 做构建期校验。

### 3.13 CI/CD

**优点**：
- `ci.yml` 矩阵覆盖 Windows/macOS/Linux 三平台，步骤完整：`version:check`、`typecheck`、`typecheck:tools`、`lint`、`test`、`build:desktop`、`cargo check`（[ci.yml:62-81](file:///d:/Projects/EasyConsole/.github/workflows/ci.yml#L62)）。
- `release.yml` 在发布前重跑验证（version/typecheck/lint/test）（[release.yml:78-85](file:///d:/Projects/EasyConsole/.github/workflows/release.yml#L78)）。

**不足**：
- **`android-ci.yml` 跳过所有验证步骤**。仅 `Checkout` -> 安装 -> 直接 `tauri android build --debug`（[android-ci.yml:83-90](file:///d:/Projects/EasyConsole/.github/workflows/android-ci.yml#L83)），**不跑 typecheck/lint/test/cargo check**。Android 构建若引入平台特定代码错误，只能在 release 时发现。
- **`release.yml` 不跑 `build:desktop` 与 `cargo check` 的独立步骤**，而是直接用 `tauri-action` 构建（[release.yml:86-99](file:///d:/Projects/EasyConsole/.github/workflows/release.yml#L86)）。
- **无覆盖率上报**。`vitest run` 无 `--coverage`，测试覆盖率不可见。建议加 `@vitest/coverage-v8` 并在 CI 上报。
- **无安全扫描**。无 `npm audit`、无 `cargo audit`、无依赖漏洞扫描。
- **无 Lighthouse/a11y 自动检查**（虽 eslint 有 a11y 规则）。

---

## 四、程序运行效率

### 4.1 列表渲染

- **未使用虚拟化**。`package.json` 中无 `react-window` / `@tanstack/react-virtual` 依赖。TasksPage 桌面端 `table.getRowModel().rows.map(...)` 渲染整页（[TasksPage.tsx:1285](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1285)），`TASK_PAGE_SIZE_OPTIONS` 最大 200（[task-list-query.ts:5](file:///d:/Projects/EasyConsole/src/lib/task-list-query.ts#L5)）。200 行 × 15 列 ≈ 3000 单元格 + 200 个 MoreActionsMenu 组件实例。StoragePage（[StoragePage.tsx:538](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx#L538)）、ImagesPage（[ImagesPage.tsx:267](file:///d:/Projects/EasyConsole/src/pages/ImagesPage.tsx#L267)）同样全量 `map`。
- **移动端卡片与桌面表格双份渲染**。三个页面均在同一 JSX 中同时渲染 `sm:hidden` 的卡片列表和 `hidden sm:block` 的表格（用 CSS 隐藏一份），DOM 节点和工作量翻倍：[TasksPage.tsx:1176 与 1262](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1176)、[StoragePage.tsx:434 与 526](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx#L434)、[ImagesPage.tsx:194 与 254](file:///d:/Projects/EasyConsole/src/pages/ImagesPage.tsx#L194)。
- **`columns` useMemo 依赖项过宽**（[TasksPage.tsx:987](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L987)）。依赖 `pinnedTaskIds`、`releaseMutation.isPending`、`deleteMutation.isPending`、`saveTemplateMutation` 等，任一变化都会重建整列定义，继而触发 `useReactTable` 重新初始化。
- **key 设置正确**：表格行用 `row.id`（[TasksPage.tsx:1286](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1286)），StoragePage 用 `entryPath`（[StoragePage.tsx:553](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx#L553)），ImagesPage 用 `${source}-${id}`（[ImagesPage.tsx:268](file:///d:/Projects/EasyConsole/src/pages/ImagesPage.tsx#L268)），均稳定。**亮点**。

**改进建议**：引入 `@tanstack/react-virtual` 对表格体做行虚拟化；移动端卡片与桌面表格二选一渲染（用 `useMediaQuery` 或 runtime `isMobile` 判断）；`columns` 中将 `pinnedTaskIds`、`isPending` 等通过 ref 读取，把 cell 闭包从依赖中移除，使 columns 稳定。

### 4.2 网络请求

**亮点**：
- 已用 `@tanstack/react-query`，QueryClient 在 [main.tsx:15](file:///d:/Projects/EasyConsole/src/main.tsx#L15) 配置了 `refetchOnWindowFocus: false, retry: 1`。
- `fetchRequest` 实现了 AbortController 超时与外部 signal 取消（[runtime.ts:153](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L153)）。
- blob 下载用流式 reader 带进度（[runtime.ts:124](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L124)）。

**不足**：
- **未设置 `staleTime`，默认 0**。[main.tsx:15-22](file:///d:/Projects/EasyConsole/src/main.tsx#L15) 没有配置 `staleTime`，所有 query 一旦挂载就视为过期。由于页面 `lazy` 加载，路由切换回来必触发 refetch。建议给只读列表设置 `staleTime: 30_000`。
- **任务列表存在重复轮询**。TasksPage 自动刷新查询 `["tasks", page, pageSize, keyword, status]`（[TasksPage.tsx:696](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L696)），同时 `TaskNotificationWatcher` 又以独立 queryKey `["task-notification-watch"]` 每 10s 拉取 `page_size: 100` 的同一接口（[TaskNotificationWatcher.tsx:22-28](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L22)，`refetchIntervalInBackground: true`）。在 TasksPage 打开时，两个请求并发打到 `/instance/task`，react-query 不会去重（key 不同）。
- **`gcTime`/`cacheTime` 未配置**，缓存默认保留 5 分钟；可接受但可显式调优。

**改进建议**：让 `TaskNotificationWatcher` 复用 TasksPage 的 `["tasks",...]` 缓存（用 `useQueryClient().getQueryData` 读取），或把轮询合并到一个观察者，避免双份网络；在 `defaultOptions.queries` 设 `staleTime` 与 `gcTime`。

### 4.3 状态更新与重渲染

**不足**：
- `RunLoggerProvider` 的 value 未 memoize（[RunLoggerProvider.tsx:19](file:///d:/Projects/EasyConsole/src/components/RunLoggerProvider.tsx#L19)），每次 Provider 重渲染都生成新对象。由于它位于 `AuthProvider` 内（[main.tsx:35](file:///d:/Projects/EasyConsole/src/main.tsx#L35)），auth 状态变化会触发 RunLoggerProvider 重渲染，进而使所有 `useRunLogger()` 消费者重渲染。`log` 本身是 `useCallback` 稳定的，完全可以用 `useMemo` 包一下 value。
- `CommitQueueProvider` 与 `DownloadQueueProvider` 的 `runNext` 通过 `useEffect(() => { runNext(); }, [items, runNext])` 触发（[commit-queue-context.tsx:114](file:///d:/Projects/EasyConsole/src/lib/commit-queue-context.tsx#L114)、[download-queue-context.tsx:153](file:///d:/Projects/EasyConsole/src/lib/download-queue-context.tsx#L153)）。每次 `items` 变化（包括进度回调里每个 progress tick 的 `setItems`）都会重跑 effect。下载进度高频更新时这是额外开销，不过 `runningRef` 守卫了实际执行。
- TasksPage 的 `filteredTasks` 与 `columns` 在 pinnedTaskIds 变化时连锁重建（[TasksPage.tsx:703 与 833](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L703)）。

**亮点**：
- `CommitQueueProvider`（[commit-queue-context.tsx:150](file:///d:/Projects/EasyConsole/src/lib/commit-queue-context.tsx#L150)）、`DownloadQueueProvider`（[download-queue-context.tsx:216](file:///d:/Projects/EasyConsole/src/lib/download-queue-context.tsx#L216)）、`AuthProvider`（[auth-context.tsx:181](file:///d:/Projects/EasyConsole/src/lib/auth-context.tsx#L181)）、`ToastProvider`（[Toast.tsx:41](file:///d:/Projects/EasyConsole/src/components/Toast.tsx#L41)）均用 `useMemo` 包了 value，依赖项正确。
- Context 拆分粒度合理。
- 全部用 `useState`，未滥用 `useReducer`，复杂度匹配。

**改进建议**：RunLoggerProvider `const value = useMemo(() => ({ log }), [log])`；TasksPage 把 `pinnedTaskIds` 改为 ref 读取，columns 与 filteredTasks 解耦。

### 4.4 Bundle 体积

**亮点**：
- `manualChunks` 已拆分 vendor-xterm / vendor-tanstack / vendor-tauri / vendor-icons / vendor-react / vendor（[vite.config.ts:9](file:///d:/Projects/EasyConsole/vite.config.ts#L9)）。
- 所有路由页 `lazy`（[App.tsx:14-22](file:///d:/Projects/EasyConsole/src/App.tsx#L14)）。
- `TerminalDialog` lazy（[TasksPage.tsx:74](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L74)），`AppSshTerminalDialog` 内动态 `import("@xterm/xterm")` 与 `import("@xterm/addon-fit")`（[AppSshTerminalDialog.tsx:72](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L72)），xterm 不进主包。
- 无 recharts / monaco 等重型库。

**不足**：
- **`manualChunks` 的 `react` 匹配过宽**。[vite.config.ts:15](file:///d:/Projects/EasyConsole/vite.config.ts#L15) 用 `id.includes("react")`，会捕获路径中任何含 "react" 的模块。建议改为 `/node_modules/(react|react-dom|react-router-dom)/`。
- **`CreateTaskDialog` 与 `TaskLogDialog` 静态导入**。[TasksPage.tsx:36-38](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L36) 直接 import，未 lazy。这两个对话框体积可能不小（表单字段多），会进入 TasksPage chunk。
- **`zod` 在 dependencies 但渲染层未见使用**。[package.json:53](file:///d:/Projects/EasyConsole/package.json#L53)。zod v4 体积可观（~50KB+）。若仅 CLI/MCP sidecar 使用，应移到 devDependencies。
- **无 `build.target`、`build.minify`、`chunkSizeWarningLimit`、`esbuild` 选项配置**，全用默认。

**改进建议**：精确化 manualChunks 的 react 匹配；`CreateTaskDialog`、`TaskLogDialog` 改 `lazy()`；显式 `build.target` 与 `build.chunkSizeWarningLimit`。

### 4.5 Tauri 应用启动

**不足**：
- **setup 阶段同步读取两次同一个文件**。[lib.rs:1356-1363](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1356)，`read_close_to_tray_setting` 与 `read_close_prompt_setting` 各自调用 `runtime_storage_path` + `load_string_map`（同步 `fs::read_to_string` + `serde_json::from_str`），对 `runtime-storage.json` 做了两次完整读解析。可合并为一次读取。
- **托盘菜单窗口在启动时即创建**。[lib.rs:1099](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1099)（`setup_tray` → `ensure_tray_menu_window`）在 setup 中 `WebviewWindowBuilder::new(...).build()`，即启动就创建第二个隐藏 webview。webview 创建开销不小，应改为首次右键时懒创建。
- **`runtime_storage_get/set/remove` 每次全量读写整个 map**（[lib.rs:922-943](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L922)），`runtime_storage_get` 读整个 JSON map 再取一个 key，`set` 读整个 map → 改一个 key → 写回。配合前端 `appendRunLog`（见 4.10）会产生放大效应。
- **`verify_known_host` 每次连接同步读写 `known-ssh-hosts.json`**（[lib.rs:146-161](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L146)），在 SSH 连接热路径上做文件 IO + 序列化。

**亮点**：
- 无 sidecar 进程在 Tauri 内启动。CLI/MCP 是独立 Node 二进制（[tools/easy-console/build-sidecars.mjs](file:///d:/Projects/EasyConsole/tools/easy-console/build-sidecars.mjs)），桌面 app 用 `russh` 直连，不付 sidecar 启动开销。
- `initRuntimeKind`（[runtime.ts:39](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L39)）对 `runtime_platform` IPC 做了 3s 超时 race，防止挂死渲染启动。
- 插件链注册顺序合理。

**改进建议**：setup 中合并 `read_close_to_tray_setting` 与 `read_close_prompt_setting` 为一次读；托盘菜单窗口懒创建；runtime-storage 改为按 key 分文件，或前端缓存减少 IPC。

### 4.6 上传/下载效率

**不足**：
- **MD5 用纯 JS 同步实现，阻塞主线程**。[md5.ts:50](file:///d:/Projects/EasyConsole/src/lib/md5.ts#L50) `md5ArrayBuffer` 是手写纯 JS MD5，`md5Blob`（[md5.ts:140](file:///d:/Projects/EasyConsole/src/lib/md5.ts#L140)）`await blob.arrayBuffer()` 后同步计算。上传完成时对整文件计算 MD5（[api-factory.ts:265 与 292](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L265)），大文件（数百 MB ~ GB）会明显卡顿主线程。浏览器 Web Crypto 不支持 MD5，但可用 WASM 版（如 `hash-wasm`）或 Web Worker 卸载。
- **上传分片固定 5MB，串行**。[api-factory.ts:23](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L23) `UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024`，`uploadFile`（[api-factory.ts:279](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L279)）用 `for` 循环逐片上传，无并发。对多小文件场景也无并行（StoragePage `runUploadQueue` 串行，[StoragePage.tsx:183](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx#L183)）。
- **MD5 重复读文件**。`uploadFile` 已经逐片 `file.slice` 读了一遍，最后 `md5Blob(file)` 又 `await blob.arrayBuffer()` 把整个文件再读一遍进内存。
- **上传进度回调每 tick 做整数组 map**。[StoragePage.tsx:198-200](file:///d:/Projects/EasyConsole/src/pages/StoragePage.tsx#L198)。

**亮点**：
- 下载用流式 reader 带进度（[runtime.ts:124](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L124)）。
- 0B 空文件有专门 fallback 与 post-upload listing 校验（[api-factory.ts:250-278](file:///d:/Projects/EasyConsole/src/lib/api-factory.ts#L250)），符合 AGENTS.md。
- `AbortController` 贯穿上传/下载，支持取消。

**改进建议**：MD5 移到 Web Worker 或换 WASM 实现；或边上传边增量哈希（分片已读，可流式累加）；多文件上传加有限并发（如 3 路）；大文件分片可考虑动态调整。

### 4.7 SSH 终端

**不足**：
- **SSH 输出每段 Data 触发一次 Tauri 事件**。[lib.rs:827-834](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L827)，`ChannelMsg::Data` 每次都 `emit_session_event` → JS 全局 `listen`（[runtime.ts:416](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L416)）→ `terminal.write`。高吞吐输出（如 `cat` 大文件、`yes`）下，每个数据块一次 IPC round-trip，无批量合并，容易成为瓶颈。
- **全局单 listener 按 sessionId 过滤**。[runtime.ts:416-419](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L416)，所有 SSH 会话的事件都进同一个 listener，再 `if (event.payload.sessionId !== sessionId) return`。多会话时 O(会话数) 过滤。
- **xterm 未启用 WebGL 渲染**。AppSshTerminalDialog 只加载 `FitAddon`（[AppSshTerminalDialog.tsx:87](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L87)），未加载 `@xterm/addon-webgl` / `addon-web-links`。大 scrollback（10_000 行）下默认 canvas 渲染在快速输出时会掉帧。
- **每个按键一次 IPC**。`terminal.onData` → `writeSshSession` → `invoke("ssh_write")`（[AppSshTerminalDialog.tsx:110-114](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L110)）。正常打字可接受，但粘贴大量文本会产生大量小 IPC。

**亮点**：
- xterm 与 addon 动态 import，不进主包（[AppSshTerminalDialog.tsx:72](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L72)）。
- `scrollback: 10_000`（[AppSshTerminalDialog.tsx:80](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L80)）合理。
- 会话清理完善：dispose 时 `closeSshSession` + `terminal.dispose()`（[AppSshTerminalDialog.tsx:156-161](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L156)）。

**改进建议**：Rust 侧对 SSH 输出做 16ms / 8KB 合并后批量 emit；或用 `mpsc` 直接推流，前端用单个订阅；加载 `@xterm/addon-webgl`（动态 import）提升大输出渲染；粘贴场景前端做合并。

### 4.8 搜索/筛选

**不足（重点）**：
- **TasksPage 搜索输入无防抖，每次按键触发 API 请求**。[TasksPage.tsx:1057](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L1057) `onChange={(event) => updateTaskQuery({ keyword: event.target.value })}`，`updateTaskQuery` 调 `setSearchParams`（[TasksPage.tsx:534](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L534)），`queryState` 变化 → `taskQueryKey` 变化（[TasksPage.tsx:239](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L239)）→ `useQuery` 以新 key 发起 `instanceApi.tasks(toTaskApiQuery(queryState))`（[TasksPage.tsx:698](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L698)）。快速输入 "abc" 会发 3 个请求，前两个被 react-query 取消（key 变了），但仍浪费网络与渲染。应加 200-300ms 防抖。
- **`filterAndSortTasks` 客户端又对结果做一次 keyword 排序**。[TasksPage.tsx:705](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L705)，`taskMatchesQuery` + `filterAndSortTasks` 都基于 `queryState.keyword`。既然后端已按 keyword 过滤，客户端再 rank 排序是额外 O(n) 工作。

**亮点**：
- `taskSearchRank`（[task-search.ts:45](file:///d:/Projects/EasyConsole/src/lib/task-search.ts#L45)）算法清晰：精确匹配 0、前缀 100+、包含 200+，数字与文本分别处理。复杂度 O(n × 字段数)，对 200 任务 × 6 字段约 1200 次比较，无性能问题。
- StoragePage / ImagesPage 搜索是纯客户端 filter，无需防抖。

**改进建议**：TasksPage 搜索加防抖（`useDeferredValue` 或 setTimeout/`useDebounce`），并对 keyword 去抖后再进 URLSearchParams，避免历史栈污染与重复请求。

### 4.9 通知监听

**不足**：
- **任务通知轮询与 TasksPage 轮询重复**（见 4.2）。`TaskNotificationWatcher` 每 10s 拉 100 条任务，`refetchIntervalInBackground: true`（[TaskNotificationWatcher.tsx:27](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L27)），即使 TasksPage 已在轮询，后台 watcher 仍独立工作。
- **`BackgroundScheduledTaskRunner` 多重触发源叠加**。[BackgroundScheduledTaskRunner.tsx:115-119](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L115)，30s `setInterval` + `focus` + `online` + `pageshow` + `visibilitychange` + 桌面端 `desktop-run-due-scheduled-tasks` 事件（Rust 侧 [lib.rs:1131](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L1131) 也每 30s emit 一次）。焦点切换可能连续触发 `executeDueTasks`，虽有 `runningRef` 守卫，但仍会重复 `loadScheduledTasks`（读存储 + JSON.parse）。
- **状态比较每次新建 Map**。[TaskNotificationWatcher.tsx:62](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L62) `new Map(previousSnapshot)` 然后逐任务 set，O(n)。

**亮点**：
- `TaskNotificationWatcher` 用 `initializedRef` 避免首屏误发通知（[TaskNotificationWatcher.tsx:63](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L63)）。
- `permissionWarningRef` 防止重复权限警告（[TaskNotificationWatcher.tsx:46](file:///d:/Projects/EasyConsole/src/components/TaskNotificationWatcher.tsx#L46)）。
- 桌面端用 Web Locks（`BACKGROUND_LOCK_NAME`）确保单实例后台运行（[BackgroundScheduledTaskRunner.tsx:14-43](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L14)）。

**改进建议**：TaskNotificationWatcher 复用 TasksPage 的 tasks query 数据，消除独立轮询；BackgroundScheduledTaskRunner 对 `focus`/`visibilitychange` 做最小间隔节流（如 30s 内不重复 load）。

### 4.10 本地存储

**不足（重点）**：
- **`appendRunLog` 每次追加都全量读 + 全量写，且 Tauri storage adapter 放大 2 倍**。
  - [run-logs.ts:188](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L188) `appendRunLog`：`loadRunLogs`（读 + JSON.parse + prune O(n log n)）→ 构造新条目 → `storage.set`（JSON.stringify 全部）。
  - Tauri storage adapter（[runtime.ts:86-92](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L86)）的 `set` 又调用 `runtime_storage_set` Tauri 命令，该命令（[lib.rs:930-935](file:///d:/Projects/EasyConsole/src-tauri/src/lib.rs#L930)）再次 `load_string_map`（读整个 runtime-storage.json + 解析）→ 改一个 key → `write_string_map`（序列化整个 map + 写文件）。
  - 结果：一次 run log 追加 = 前端读 1 次 + 前端写 1 次（含 Tauri 后端再读 1 次 + 再写 1 次）。1000 条日志上限下，每次追加序列化/反序列化 1000 条 + 整个 storage map。频繁操作时累计开销明显。
- **`pruneRunLogs` 每次都 `[...items].filter().sort().slice()`**（[run-logs.ts:159](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L159)），O(n log n) 复制 + 排序。append 时调用，即使无过期项也全排序。
- **`BackgroundScheduledTaskRunner` 每个状态变更都 `persist`（全量写）**（[BackgroundScheduledTaskRunner.tsx:68、71、85](file:///d:/Projects/EasyConsole/src/components/BackgroundScheduledTaskRunner.tsx#L68)），一个 due 任务从 pending→running→done 至少 2 次 `saveScheduledTasks`（全量 JSON.stringify + storage.set → Tauri 全量读写）。
- **浏览器端 localStorage 同步阻塞**。[runtime.ts:66-75](file:///d:/Projects/EasyConsole/src/lib/runtime.ts#L66) `localStorageAdapter.get/set` 是同步 `localStorage.getItem/setItem`，主线程阻塞。

**亮点**：
- `run-logs` 有上限（`DEFAULT_RUN_LOG_LIMIT = 1000`）与保留期（30 天）（[run-logs.ts:4-5](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L4)）。
- `saved-accounts` 限 5 条（[saved-accounts.ts:4](file:///d:/Projects/EasyConsole/src/lib/saved-accounts.ts#L4)）。
- `sanitizeRunLogValue` 限制 metadata 深度（5）与长度（[run-logs.ts:57-59](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L57)），防止单条过大。
- 敏感 key 正则脱敏（[run-logs.ts:57](file:///d:/Projects/EasyConsole/src/lib/run-logs.ts#L57)）。

**改进建议**：run-logs 改为独立 key 文件（如 `runtime-storage.json` 中只存指针，日志单独文件），或前端内存缓存 + 防抖批量写；Tauri 侧 `runtime_storage_set` 支持增量更新单 key（不重读整个 map），或前端缓存 map 镜像；`pruneRunLogs` 在 append 热路径上做轻量检查（仅当超限时才排序裁剪）。

### 4.11 构建产物

**不足**：
- **无 `build.target` / `build.minify` 显式配置**，依赖默认。Vite 8 默认 `target: 'baseline-widely-available'`（较保守），可能包含不必要 polyfill；可设 `target: 'es2020'` 减小体积。
- **无 `cssMinify` 配置**（默认 esbuild）。
- **`manualChunks` 未拆分 `zod`、`@modelcontextprotocol/sdk`、`commander`**——虽然这些在渲染层未 import 不会进包，但若未来误 import 会全部塞进 `vendor` 兜底 chunk。
- **无 `build.reportCompressedSize: false`**，构建会 gzip 所有 chunk 报告，大项目拖慢构建。

**亮点**：
- manualChunks 已存在且按生态拆分（[vite.config.ts:7](file:///d:/Projects/EasyConsole/vite.config.ts#L7)）。
- esbuild minify（默认）比 terser 快。
- 无 `sourcemap`（生产默认 false），不泄露源码。
- `@vitejs/plugin-react` 已启用。

**改进建议**：加 `build: { target: 'es2020', chunkSizeWarningLimit: 1500, reportCompressedSize: false }`；manualChunks 增加 `zod`、`commander`、`@modelcontextprotocol/sdk` 分组以防误打入。

### 4.12 图片/资源

- 未见 `loading="lazy"` 用法。但渲染层图片极少（仅 favicon.svg、Tauri 图标），不构成问题。
- xterm CSS 在 AppSshTerminalDialog 顶部 `import "@xterm/xterm/css/xterm.css"`（[AppSshTerminalDialog.tsx:1](file:///d:/Projects/EasyConsole/src/components/tasks/AppSshTerminalDialog.tsx#L1)），随组件进入其 chunk，合理。

**亮点**：`lucide-react` 按需命名导入（如 [TasksPage.tsx:11-28](file:///d:/Projects/EasyConsole/src/pages/TasksPage.tsx#L11)），tree-shaking 生效；manualChunks 单独拆 `vendor-icons`；无大图片资源；Tailwind v4 自动检测用到的 class。

---

## 五、优先级排序（按收益/成本）

### P0（影响核心可用性或安全，应优先修复）

1. **无 React ErrorBoundary，渲染错误白屏**（三-3.9）
2. **Token 明文存储 + 密码无盐 SHA-256**（三-3.7）
3. **TasksPage 搜索加防抖**（一-1.2、四-4.8）
4. **TaskNotificationWatcher 硬编码中文修复**（一-1.6）
5. **AuthProvider 初始化无 catch 可能永久卡 loading**（三-3.4）
6. **合并 TaskNotificationWatcher 与 TasksPage 双重轮询**（四-4.2）

### P1（影响核心工作流完整性）

7. **任务编辑能力**（确认后端是否支持，补 `updateTask`）（二-2.1）
8. **token 刷新机制**（二-2.9）
9. **定时任务循环调度（cron/interval）**（二-2.3）
10. **存储断点续传**（二-2.4）
11. **CLI/MCP 能力对齐（模板/定时任务/存储上传/镜像提交/dashboard 统计）**（二-2.10）
12. **MD5 移至 Web Worker/WASM**（四-4.6）
13. **Tauri runtime-storage 增量写/前端缓存**（四-4.5、4.10）
14. **SSH connect 加超时 + capabilities http/fs scope 收紧**（三-3.6）
15. **runtime-storage.json 并发写加锁**（三-3.6）

### P2（体验与性能提升）

16. **列表虚拟化 + 移除移动端双份渲染**（四-4.1）
17. **TasksPage 列设置改用 `browserRuntime.storage`**（一-1.2）
18. **AppSshTerminalDialog 加 Esc 关闭与重连**（一-1.5、1.7）
19. **error toast 延长时长 + 操作按钮 + 通用骨架屏**（一-1.4）
20. **skip-to-content + Dialog body 滚动锁 + 扩展快捷键**（一-1.5）
21. **任务详情深链接 `/tasks/:id`**（一-1.1）
22. **仪表盘刷新 + 图表 + 时间范围**（二-2.12）
23. **监控 iframe 嵌入 + 调用 monitorIndex**（二-2.7）
24. **SSH 输出批量 emit + xterm WebGL**（四-4.7）
25. **RunLoggerProvider value memoize + CreateTaskDialog/TaskLogDialog lazy**（四-4.3、4.4）
26. **android-ci.yml 补 typecheck/lint/test**（三-3.13）
27. **页面/组件测试覆盖补齐 + 集成测试**（三-3.5）

### P3（锦上添花）

28. **运行日志 level 筛选与高级搜索**（二-2.8）
29. **备份加密与自动备份**（二-2.13）
30. **镜像收藏与详情 Dialog**（二-2.5）
31. **桌面端深链接与全局快捷键**（二-2.11）
32. **模板变量替换系统**（二-2.2）
33. **vite build.target / reportCompressedSize**（四-4.11）
34. **Tauri setup 合并读 + 托盘窗口懒创建**（四-4.5）

---

## 附：审查范围与方法

- **审查时间**：2026-06-26
- **审查范围**：全项目源码（`src/`、`src-tauri/src/`、`tools/easy-console/`、`.github/workflows/`、配置文件）
- **审查方法**：源码静态审查 + 代码引用定位，未运行时验证
- **对比基准**：`reference/original-console/`（仅压缩 webpack 产物，结构性对比）、AGENTS.md 约定、DESIGN.md 视觉系统
- **未覆盖**：实际运行性能 profiling、真实 API 行为验证、原始控制台反编译对比
