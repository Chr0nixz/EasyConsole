# P2 修复计划 — 体验与性能提升（12 项）

## Summary

实施 AUDIT.md 中全部 12 项 P2 修复（#16-#27），覆盖列表虚拟化、TasksPage 存储适配、SSH 终端体验、Toast/骨架屏增强、可访问性、任务详情路由、仪表盘图表、监控嵌入、SSH 性能、Provider 优化、Android CI、测试覆盖。

## Assumptions & Decisions

| 决策点 | 选择 | 理由 |
|---|---|---|
| P2-16 虚拟化 | 引入 `@tanstack/react-virtual` + 条件渲染 | 桌面表格行虚拟化；移动端卡片改为 `runtime.isMobile` 条件渲染（非双份 DOM） |
| P2-22 图表库 | recharts | 功能完整、React 生态主流、~50KB gzipped |
| P2-27 测试范围 | 补齐关键页面+组件测试 | 引入 msw + user-event，优先 LoginPage/SettingsPage/StoragePage/CreateTaskDialog/AppShell |
| P2-20 Esc 关闭 SSH | Ctrl+Esc 关闭（非终端聚焦时 Esc 关闭） | xterm 终端需要 Esc 发送 `\x1b`，不能直接拦截；非终端焦点时 Esc 关闭，终端聚焦时需 Ctrl+Esc |
| P2-21 TaskDetailPage | 聚合现有组件（日志/终端/监控/SSH） | 不新建独立 API，复用 TasksPage 已有对话框内容组织为标签页 |
| P2-23 监控嵌入 | Web 用 iframe，桌面端用 iframe（Tauri webview 仅在 CSP 阻止时） | Grafana 允许 iframe 嵌入（需确认）；monitorIndex 在任务行渲染 sparkline |

## Proposed Changes

### P2-16 列表虚拟化 + 移除移动端双份渲染

**新增依赖**：`@tanstack/react-virtual`

**文件变更**：
- `package.json`：新增 `@tanstack/react-virtual` 依赖
- `src/pages/TasksPage.tsx`：
  - 桌面表格体（L1322-1345）：用 `useVirtualizer` 包裹 `table.getRowModel().rows`，渲染绝对定位行
  - 移动端卡片（L1234）：改为 `runtime.isMobile` 条件渲染，仅移动端渲染卡片块
- `src/pages/StoragePage.tsx`：同上模式（L462 卡片条件渲染，L554 表格虚拟化）
- `src/pages/ImagesPage.tsx`：同上模式（L194 卡片条件渲染，L254 表格虚拟化）

**虚拟化策略**：表格用 `paddingTop/paddingBottom` 撑起总高度，仅渲染可见行 + overscan 5 行

### P2-17 TasksPage 列设置改用 browserRuntime.storage

**文件变更**：`src/pages/TasksPage.tsx`
- L199 `loadColumnVisibility`、L226 `loadBooleanSetting`、L234 `loadNumberSetting`：改为异步函数，调用 `browserRuntime.storage.get(key)`
- L547/549/550-552 `useState` 初始化：改为默认值初始化 + `useEffect` hydration 加载已存值
- L1063/1067/1071 持久化 `useEffect`：改为 `void browserRuntime.storage.set(...)`
- Key 常量保持不变（L77-79）

### P2-18 AppSshTerminalDialog 加 Esc 关闭与重连

**文件变更**：`src/components/tasks/AppSshTerminalDialog.tsx`
- `handleDialogKeyDown`（L184-206）：增加 Escape 分支 — 仅当 `document.activeElement` 不在 xterm 终端内时调用 `onClose`；终端聚焦时需 `Ctrl+Esc` 关闭
- 连接失败 catch 块（L144-148）：增加"重连"按钮渲染，触发 `connect()` 函数
- 提取 `connect()` 可重入函数：重置 `sessionIdRef`、清理旧 unlisten、重新订阅事件、重新调用 `browserRuntime.openSshSession`

### P2-19 error toast 延长时长 + 操作按钮 + 通用骨架屏

**文件变更**：
- `src/lib/use-toast.ts`：
  - `ToastInput` 增加 `action?: { label: string; onClick: () => void }`
  - `ToastContextValue.error` 签名扩展接受 `action`
  - error kind 默认 `durationMs = 8000`
- `src/components/Toast.tsx`：
  - `notify`（L33）：error kind 默认 8000ms
  - 渲染区（L55-79）：增加 action 按钮槽位
- `src/components/DataState.tsx`：
  - `LoadingState`（L9-19）：增加 `variant?: "spinner" | "skeleton"` prop，skeleton 模式渲染 `animate-pulse` 占位块
  - `EmptyState`（L44-52）：增加 `description?: ReactNode` prop
  - `ErrorState`（L56-66）：增加错误类型识别（401 登录过期/网络错误/500），从 `api-client.ts` 暴露 `isAuthError`/`isNetworkError` 辅助函数

### P2-20 skip-to-content + Dialog body 滚动锁 + 扩展快捷键

**文件变更**：
- `src/components/AppShell.tsx`：
  - 顶部增加 skip-link：`<a href="#main-content" className="sr-only focus:not-sr-only ...">跳到主内容</a>`
  - `<main>`（L506）增加 `id="main-content"`
  - 扩展 keydown 监听（L113-122）：增加 `/` 聚焦搜索、`?` 显示快捷键帮助、`g d` 跳转 dashboard、`g t` 跳转 tasks 等
- `src/components/ui.tsx`：
  - Dialog `useEffect`（L121-164）：增加 `document.body.style.overflow = "hidden"` + 引用计数（多 Dialog 同时打开）；cleanup 还原
- `src/components/tasks/AppSshTerminalDialog.tsx`：Esc 处理见 P2-18

### P2-21 任务详情深链接 /tasks/:id

**新增文件**：`src/pages/TaskDetailPage.tsx`
- 聚合任务信息 + 标签页（日志/终端/监控/SSH）
- 复用 TasksPage 已有的 TaskLogDialog/TerminalDialog/监控链接逻辑

**文件变更**：
- `src/App.tsx`：增加 `<Route path="tasks/:id" element={<TaskDetailPage />} />`（lazy 导入）
- `src/components/CommandPalette.tsx`（L74）：改为 `navigate(/tasks/${task.id})`
- `src/pages/TasksPage.tsx`：任务行点击跳转 `/tasks/:id`（可选，保留现有对话框模式）

### P2-22 仪表盘刷新 + 图表 + 时间范围

**新增依赖**：`recharts`

**文件变更**：
- `package.json`：新增 `recharts` 依赖
- `src/pages/DashboardPage.tsx`：
  - 顶部增加刷新按钮 + 自动刷新下拉（30s/1m/5m/关闭），通过 `refetchInterval` 实现
  - 时间范围切换控件（day/week/month segmented control）
  - 成本/时长 Panel 升级为 recharts 折线图/柱状图
  - `useQuery`（L38-46）：增加 `refetchInterval` 配置

### P2-23 监控 iframe 嵌入 + 调用 monitorIndex

**文件变更**：
- `src/lib/monitor-dashboard.ts`：新增 `buildMonitorDashboardEmbedUrl(task, { from, to })` 支持 `?from=now-1h&to=now` 参数
- `src/lib/monitor-dashboard-core.ts`：确认 `buildMonitorDashboardUrl` 是否支持时间参数，若不支持则扩展
- `src/pages/TaskDetailPage.tsx`（P2-21 新建）：增加 Grafana `<iframe>` 嵌入区
- `src/pages/TasksPage.tsx`：任务行内联调用 `instanceApi.monitorIndex(...)` 渲染迷你 sparkline（轻量 SVG）
- `src/lib/api-factory.ts`（L193-195）：`monitorIndex` 返回值类型化（从 `unknown` 改为具体接口）

### P2-24 SSH 输出批量 emit + xterm WebGL

**新增依赖**：`@xterm/addon-webgl`、`@xterm/addon-web-links`

**文件变更**：
- `package.json`：新增两个 addon 依赖
- `src-tauri/src/lib.rs`（L835-843）：SSH 流式 shell 循环中引入缓冲 + 定时 flush（16ms / 8KB 阈值），合并多个 `ChannelMsg::Data` chunk 为单次 emit
- `src/lib/runtime.ts`（L458-465）：改为共享单 listener + `Map<sessionId, Set<handler>>` 派发（可选优化）
- `src/components/tasks/AppSshTerminalDialog.tsx`（L72,87-88）：`terminal.open(...)` 后尝试加载 `WebglAddon`（失败回退 canvas）+ `WebLinksAddon`

### P2-25 RunLoggerProvider value memoize + 对话框 lazy

**文件变更**：
- `src/components/RunLoggerProvider.tsx`：
  - L1 import 增加 `useMemo`
  - L19 `value={{ log }}` 改为 `const value = useMemo(() => ({ log }), [log]);`
- `src/pages/TasksPage.tsx`：
  - L37 `CreateTaskDialog` 改为 `lazy(() => import(...))`
  - L39 `TaskLogDialog` 改为 `lazy(() => import(...))`
  - L1407-1409 渲染处用 `<Suspense fallback={null}>` 包裹

### P2-26 android-ci.yml 补 typecheck/lint/test

**文件变更**：`.github/workflows/android-ci.yml`
- 在 "Install dependencies"（L73-74）后补入：
  - `npm run version:check`
  - `npm run typecheck`
  - `npm run typecheck:tools`
  - `npm run lint`
  - `npm run test`
  - `cargo check --manifest-path src-tauri/Cargo.toml`

### P2-27 页面/组件测试覆盖补齐

**新增依赖**：`msw`、`@testing-library/user-event`

**新增测试文件**（优先核心流程）：
- `src/pages/LoginPage.test.tsx`：登录表单提交、密码显示切换、savedAccounts 选择
- `src/pages/SettingsPage.test.tsx`：URL 设置、dirty 检测、导入/导出
- `src/pages/StoragePage.test.tsx`：上传流程、目录导航、删除确认
- `src/components/tasks/CreateTaskDialog.test.tsx`：表单校验、create/edit 模式切换
- `src/components/AppShell.test.tsx`：导航、快捷键、skip-link
- `src/test/msw-handlers.ts`：msw request handlers 层，mock 后端 API

**文件变更**：
- `package.json`：新增 `msw`、`@testing-library/user-event` 到 devDependencies
- `vitest.config.ts`（或 `vite.config.ts`）：配置 msw setup

## Implementation Order

按依赖关系和风险分组实施：

1. **低风险快速收益**（先做）：#25 memoize+lazy、#26 android-ci
2. **存储与状态**：#17 TasksPage storage、#19 Toast/骨架屏
3. **可访问性与导航**：#20 skip-link+滚动锁+快捷键、#21 TaskDetailPage
4. **终端体验**：#18 Esc+重连、#24 SSH 批量 emit+WebGL
5. **列表性能**：#16 虚拟化
6. **仪表盘与监控**：#22 图表、#23 监控嵌入
7. **测试覆盖**：#27 msw+测试

## Verification Steps

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
```

## Risk & Rollback

- **P2-16 虚拟化**：表格虚拟化与 `<table>` 语义结构兼容性需验证；若破坏表格布局可回退为非虚拟化条件渲染
- **P2-22 recharts**：增加 ~50KB bundle；若体积敏感可回退为自绘 SVG sparkline
- **P2-24 SSH 批量 emit**：Rust 侧缓冲逻辑变更需充分测试高吞吐场景（`yes`/`cat` 大文件）；若丢数据可回退为逐 chunk emit
- **P2-27 msw**：引入测试基础设施需确保不影响现有测试；msw 仅在测试环境启用
