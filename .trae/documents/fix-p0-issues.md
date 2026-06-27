# 修复 EasyConsole P0 问题实施计划

## Summary

本计划针对 EasyConsole 项目审计（AUDIT.md）中标记为 P0 的 6 个关键问题进行修复，覆盖错误恢复、敏感数据存储、用户交互响应、i18n 一致性、初始化健壮性和运行效率。所有修改遵循 AGENTS.md 的桌面优先 + 适配器边界原则，并保持 web/Tauri 双运行时兼容。

## Current State Analysis

### P0-1：缺少全局 ErrorBoundary
- **位置**：`src/main.tsx`（Provider 嵌套，无 ErrorBoundary）、`src/App.tsx`（路由层，无 ErrorBoundary）
- **现状**：渲染层任何 throw 都会白屏。lazy 加载的页面 chunk 加载失败（网络中断、部署后旧 hash）会直接崩溃，无恢复路径。
- **依赖**：`src/components/DataState.tsx` 的 ErrorState 已存在（role="alert"），可复用。

### P0-2：Token 明文存储
- **位置**：
  - `src/lib/auth-context.tsx` 第 84、121 行：`browserRuntime.storage.set(TOKEN_STORAGE_KEY, result.token)` 明文写入
  - `src/lib/saved-accounts.ts` 第 9 行：`SavedLoginAccount.token: string` 明文字段
  - `src/lib/runtime.ts` 第 77-102 行：`tauriStorageAdapter` 调用 `runtime_storage_set`（明文 JSON 文件 `runtime-storage.json`）
  - `src-tauri/src/lib.rs` 第 918-943 行：`runtime_storage_get/set/remove` 明文 JSON 文件
  - `src-tauri/Cargo.toml`：无 keychain/keyring 依赖
- **现状**：任何能读取 app data 目录或 localStorage 的进程都能拿到 Bearer token。

### P0-3：搜索输入无防抖
- **位置**：`src/pages/TasksPage.tsx` 第 1053-1058 行
  ```tsx
  <Input
    value={queryState.keyword}
    onChange={(event) => updateTaskQuery({ keyword: event.target.value })}
  />
  ```
- **现状**：每次按键直接 `setSearchParams`，触发 `taskQueryKey` 变化 → useQuery 重新请求。输入"nginx"会发 6 次请求。
- **参考**：`src/components/CommandPalette.tsx` 第 19、46-54 行已有 300ms 防抖实现（setTimeout/clearTimeout）。

### P0-4：TaskNotificationWatcher 硬编码中文
- **位置**：`src/components/TaskNotificationWatcher.tsx`
  - 第 50-53 行：`toast.info("系统通知未开启" / "当前环境不支持系统通知", "实例成功或失败时将只显示应用内提示。")`
  - 第 86-89 行：`toast.info("系统通知未开启" / "系统通知不可用", "可在设置中改为应用内通知或关闭该事件通知。")`
- **现状**：英文 locale 下仍显示中文，违反 zh-CN/en-US 双语体系。
- **依赖**：`src/lib/i18n-text.ts` 的 `i18nText(zh, en)` 已存在，task-status-notifications.ts 已用此模式。

### P0-5：AuthProvider 初始化无 catch
- **位置**：`src/lib/auth-context.tsx` 第 36-54 行
  ```tsx
  useEffect(() => {
    Promise.all([...]).then(([settingsData, savedToken, savedAccountData]) => {
      // ... setReady(true);
    });  // ← 无 .catch()
  }, []);
  ```
- **现状**：storage.get 抛错时（Tauri 命令失败且 localStorage 也失败），Promise reject 未捕获，`ready` 永远 false，应用卡在 loading 屏。控制台显示 unhandled rejection。

### P0-6：双重轮询浪费请求
- **位置**：
  - `src/components/TaskNotificationWatcher.tsx` 第 22-28 行：queryKey `["task-notification-watch"]`，10s 轮询，`refetchIntervalInBackground: true`
  - `src/pages/TasksPage.tsx` 第 696-701 行：queryKey `["tasks",page,pageSize,keyword,status]`，可配 5/10/30s
- **现状**：用户在 Tasks 页时，两个独立 query 同时轮询同一后端 `/tasks` 端点（Watcher 用 page_size=100，TasksPage 用用户配置）。10s 内可能发 2-3 次相同请求。

## Assumptions & Decisions

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 密码哈希修复 | **跳过** | AGENTS.md 明确后端期望无盐 SHA-256 hex，改会破坏服务端认证 |
| Token 存储方案 | **Tauri keychain + 浏览器降级** | 桌面用 OS keychain（macOS Keychain / Windows Credential Manager / Linux Secret Service），web 保留 localStorage（无 OS 级安全存储） |
| 双重轮询合并 | **方案4：按路由启停 Watcher** | 用 useMatch("/tasks") 检测，TasksPage 挂载时暂停 Watcher 自轮询，TasksPage onSuccess 用 setQueryData 同步数据给 Watcher 做通知比对 |

## Proposed Changes

### P0-1：新增 ErrorBoundary 组件 + 两层包裹

**新建文件**：

1. `src/components/ErrorBoundary.tsx`
   - 类组件 `ErrorBoundary`：实现 `getDerivedStateFromError` + `componentDidCatch`
   - props：`children`、可选 `fallback`（ReactNode 或 `(error, reset) => ReactNode`）
   - state：`{ error: Error | null }`
   - `resetErrorBoundary` 方法清空 error，允许用户重试
   - `componentDidCatch` 中 `console.error` 记录错误（不上报到远端，无遥测）

2. `src/components/ErrorFallback.tsx`（导出为 ErrorBoundary 同文件的命名导出）
   - 函数组件：全屏错误页，显示通用错误文案（i18n）+ 错误 message（可折叠）+ "重试" + "返回首页" 按钮
   - 复用 `DataState.tsx` 的 ErrorState 视觉风格
   - i18n 文案用 `i18nText`（不依赖 Provider，因为可能 Provider 内部崩溃）

**修改文件**：

3. `src/main.tsx`
   - 在 `I18nProvider` 内、`AuthProvider` 外包裹一层 `<ErrorBoundary>`（顶层兜底，Provider 崩溃时仍可显示）
   - 在 `initRuntimeKind().finally()` 回调外层包裹，确保 init 失败也能渲染

4. `src/App.tsx`
   - 在 `<Suspense fallback>` 外、`<AppUpdateProvider>` 内包裹一层 `<ErrorBoundary>`（路由级，捕获 lazy 加载失败和页面渲染错误）
   - 路由级 fallback 用简化版（无"返回首页"，只有"重试"）

5. `src/main.tsx` 末尾新增全局错误监听（在 createRoot 之前注册）
   - `window.addEventListener("unhandledrejection", ...)` 捕获未处理 Promise reject
   - `window.addEventListener("error", ...)` 捕获同步错误和资源加载失败
   - 这些只 console.error，不阻断渲染（ErrorBoundary 已处理 React 树内错误）

**测试文件**：

6. `src/components/ErrorBoundary.test.tsx`
   - 测试：子组件 throw 时渲染 fallback
   - 测试：reset 方法清空错误
   - 测试：无 fallback 时用默认 ErrorFallback

### P0-2：Tauri keychain 安全存储 + 浏览器降级

**修改文件**：

1. `src-tauri/Cargo.toml`
   - 在 `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` 下新增：
     ```toml
     keyring = "3"
     ```
   - 仅桌面端（Android/iOS 无 keyring 支持，且项目桌面优先）

2. `src-tauri/src/lib.rs`
   - 新增三个 Tauri 命令：
     - `keychain_get(key: String) -> Result<Option<String>, String>`：用 `keyring::Entry::new(service, key)`，service 固定为 `"easy-console"`，读 password 字段
     - `keychain_set(key: String, value: String) -> Result<(), String>`：写入 password 字段
     - `keychain_remove(key: String) -> Result<(), String>`：删除 entry
   - keyring crate 的错误需映射为 String（`?` + map_err 或 From impl）
   - 在 `invoke_handler!` 注册三个命令（约第 1388-1392 行）
   - 命令实现放在 `runtime_storage_*` 命令附近（约第 918-943 行后）

3. `src-tauri/capabilities/default.json`
   - **收紧 fs:scope**：移除 `$DOCUMENT/**` 和 `$DESKTOP/**`（仅保留 `$DOWNLOAD/**`，下载场景必需）
   - 这不是 keychain 的直接依赖，但 P0-2 范围内的安全加固（减少明文 token 被文件系统权限暴露的攻击面）

4. `src/lib/runtime.ts`
   - 新增 `SecureStorageAdapter` 类型 + `tauriSecureStorageAdapter` 实现：
     ```ts
     const tauriSecureStorageAdapter: RuntimeStorage = {
       async get(key) {
         try {
           return await invokeTauriCommand<string | null>("keychain_get", { key });
         } catch (error) {
           console.warn("Keychain get failed, falling back to tauriStorage.", error);
           return tauriStorageAdapter.get(key);  // 降级到明文存储
         }
       },
       // set/remove 同理
     };
     ```
   - 新增导出 `browserRuntime.secureStorage: RuntimeStorage`：
     - Tauri 运行时：`tauriSecureStorageAdapter`
     - 浏览器运行时：`localStorageAdapter`（web 无 OS keychain，localStorage 是唯一选项）
   - `RuntimeStorage` 接口已存在，无需新增类型

5. `src/lib/auth-context.tsx`
   - 第 39、84、121 行：将 `browserRuntime.storage` 改为 `browserRuntime.secureStorage`（仅针对 TOKEN_STORAGE_KEY 的读写）
   - `SAVED_ACCOUNTS_STORAGE_KEY` 的读写保持 `browserRuntime.storage`（明文，因为不含密码，只有 token；但为一致性也可迁移到 secureStorage——**决策：迁移**，因为 token 是敏感数据）
   - 初始化 useEffect（第 36-54 行）也改用 `secureStorage` 读 token 和 savedAccounts

6. `src/lib/saved-accounts.ts`
   - 无需修改类型（token 字段保持 string，由调用方决定存储后端）
   - 新增迁移工具函数 `migrateSavedAccountsFromStorage()`：从 `browserRuntime.storage` 读取旧明文 savedAccounts，写入 `browserRuntime.secureStorage`，成功后从 `storage` 删除
   - 迁移在 AuthProvider 初始化时调用一次（幂等：已迁移则无操作）

7. `tools/easy-console/config.ts`
   - 检查 CLI config 文件写入权限：如果用 fs.writeFileSync 写 token，在 POSIX 系统上 `fs.chmodSync(path, 0o600)` 限制为仅 owner 可读写
   - Windows 上 chmod 无效但无副作用（不影响）

### P0-3：TasksPage 搜索输入防抖

**修改文件**：

1. `src/pages/TasksPage.tsx`
   - 新增本地状态：`const [keywordInput, setKeywordInput] = useState(queryState.keyword)`
   - 新增防抖 effect：
     ```tsx
     useEffect(() => {
       const timer = window.setTimeout(() => {
         if (keywordInput !== queryState.keyword) {
           updateTaskQuery({ keyword: keywordInput });
         }
       }, 300);
       return () => window.clearTimeout(timer);
     }, [keywordInput]);
     ```
   - 搜索 Input 的 `value` 改为 `keywordInput`，`onChange` 改为 `setKeywordInput(event.target.value)`
   - 新增同步 effect：当外部 `queryState.keyword` 变化（如 URL 直接访问、清除按钮）时同步本地态：
     ```tsx
     useEffect(() => {
       setKeywordInput(queryState.keyword);
     }, [queryState.keyword]);
     ```
   - 参考 `CommandPalette.tsx` 第 19 行的 `REMOTE_SEARCH_DEBOUNCE_MS = 300` 常量，复用相同值

### P0-4：TaskNotificationWatcher i18n

**修改文件**：

1. `src/lib/i18n.tsx`
   - 在 zhCN 和 enUS 字典各新增 5 个 key：
     ```
     "notify.permissionDenied": "系统通知未开启" / "System notifications are disabled"
     "notify.unsupported": "当前环境不支持系统通知" / "System notifications are not supported in this environment"
     "notify.permissionDeniedBody": "实例成功或失败时将只显示应用内提示。" / "In-app toasts will be shown for instance success or failure."
     "notify.unavailable": "系统通知不可用" / "System notifications are unavailable"
     "notify.unavailableBody": "可在设置中改为应用内通知或关闭该事件通知。" / "Switch to in-app notifications or disable this event in Settings."
     ```

2. `src/components/TaskNotificationWatcher.tsx`
   - 导入 `i18nText` from `../lib/i18n-text`
   - 第 50-53 行改为：
     ```tsx
     toast.info(
       permission === "denied"
         ? i18nText("系统通知未开启", "System notifications are disabled")
         : i18nText("当前环境不支持系统通知", "System notifications are not supported in this environment"),
       permission === "denied"
         ? i18nText("实例成功或失败时将只显示应用内提示。", "In-app toasts will be shown for instance success or failure.")
         : undefined,
     );
     ```
   - 第 86-89 行同理用 `i18nText` 替换
   - **不用 useI18n().t**：因为这些调用在 useEffect 内，用 t 会引入依赖问题；i18nText 是模块级函数，自动跟随当前 locale，无依赖问题

### P0-5：AuthProvider 初始化加 catch

**修改文件**：

1. `src/lib/auth-context.tsx` 第 36-54 行
   - 改为：
     ```tsx
     useEffect(() => {
       let cancelled = false;
       Promise.all([
         browserRuntime.secureStorage.get(APP_SETTINGS_STORAGE_KEY),
         browserRuntime.secureStorage.get(TOKEN_STORAGE_KEY),
         browserRuntime.secureStorage.get(SAVED_ACCOUNTS_STORAGE_KEY),
       ]).then(
         ([settingsData, savedToken, savedAccountData]) => {
           if (cancelled) return;
           const settings = parseAppSettings(settingsData);
           setRuntimeSettings(settings);
           apiClient.setBaseUrl(settings.apiBaseUrl);
           const parsedAccounts = parseSavedAccounts(savedAccountData);
           savedAccountsRef.current = parsedAccounts;
           setSavedAccounts(parsedAccounts);
           setToken(savedToken);
           apiClient.setToken(savedToken);
           setReady(true);
         },
         (error) => {
           if (cancelled) return;
           console.error("Auth initialization failed.", error);
           writeAuthLog({
             level: "error",
             action: "auth.init",
             result: "failure",
             title: i18nText("初始化失败", "Initialization failed"),
             error: error instanceof Error ? error.message : String(error),
           });
           setReady(true);  // 解除阻塞，让用户看到登录页而非无限 loading
         },
       );
       return () => { cancelled = true; };
     }, []);
     ```
   - 注：APP_SETTINGS_STORAGE_KEY 的读取保持 `secureStorage` 还是 `storage`？**决策：settings 用 storage**（非敏感数据，且 settings 需在 keychain 不可用时仍可读写）。所以 Promise.all 中 settings 用 `browserRuntime.storage.get`，token 和 savedAccounts 用 `browserRuntime.secureStorage.get`。

### P0-6：按路由启停 Watcher 轮询

**修改文件**：

1. `src/components/TaskNotificationWatcher.tsx`
   - 导入 `useMatch` from `react-router-dom`
   - 新增：`const onTasksPage = useMatch("/tasks");`
   - 修改 useQuery 配置（第 22-28 行）：
     ```tsx
     const query = useQuery({
       queryKey: ["task-notification-watch"],
       queryFn: () => instanceApi.tasks({ page: 1, page_size: TASK_NOTIFICATION_PAGE_SIZE }),
       enabled: Boolean(auth.token),
       refetchInterval: onTasksPage ? false : TASK_NOTIFICATION_WATCH_INTERVAL,
       refetchIntervalInBackground: true,
     });
     ```
   - 当用户在 /tasks 页时，Watcher 不自轮询，由 TasksPage 的 onSuccess 同步数据

2. `src/pages/TasksPage.tsx`
   - 导入 `useQueryClient` from `@tanstack/react-query`
   - 在 useQuery 配置新增 `onSuccess`（第 696-701 行）：
     ```tsx
     const queryClient = useQueryClient();
     const query = useQuery({
       queryKey: taskQueryKey(queryState),
       queryFn: () => instanceApi.tasks(toTaskApiQuery(queryState)),
       refetchInterval: autoRefresh && !autoRefreshPaused ? autoRefreshInterval : false,
       refetchIntervalInBackground: false,
       onSuccess: (data) => {
         // 同步数据给 TaskNotificationWatcher 做通知比对，避免双重轮询
         queryClient.setQueryData(["task-notification-watch"], data);
       },
     });
     ```
   - 注意：TasksPage 的 query 是带 keyword/status 过滤的，但 `instanceApi.tasks` 返回的是后端过滤后的结果。Watcher 需要全量第 1 页 100 条做状态比对。**风险**：如果用户在 /tasks 页设了 status 过滤，同步给 Watcher 的数据也是过滤后的，可能漏掉某些状态变化的任务的通知。
   - **修正方案**：TasksPage 的 onSuccess 不直接同步过滤后的数据。改为：TasksPage 挂载时，触发一次 Watcher 的 refetch（`queryClient.refetchQueries({ queryKey: ["task-notification-watch"] })`），然后 Watcher 自己用 refetchInterval: false 停止后续轮询。但这样 Watcher 在 TasksPage 期间不会更新快照。
   - **最终方案**：保持 Watcher 的 refetchInterval 在 /tasks 页时仍为 10s（不暂停），但把 TasksPage 的 refetchInterval 改为依赖 Watcher 的数据（如果 Watcher 刚 refetch 过，TasksPage 跳过本次）。这太复杂。
   - **回归方案4原意**：TasksPage 挂载时 Watcher refetchInterval: false，TasksPage onSuccess 同步**全量**数据给 Watcher。但 TasksPage 的 query 是过滤的——**修正**：TasksPage 的 `instanceApi.tasks(toTaskApiQuery(queryState))` 在无 keyword/status 过滤时（默认状态）返回的就是全量第 1 页。只有用户设了过滤时才不是全量。**决策**：onSuccess 同步时检查 `if (!queryState.keyword && !queryState.status)` 才同步，否则不同步（保留 Watcher 上次的全量快照）。这是可接受的折衷——用户在过滤状态下 Watcher 不更新，但退出过滤后会立即同步。
   - 实际上更简单：**Watcher 在 /tasks 页保持 refetchInterval: 10s 不变，但 TasksPage 用 `staleTime: 10_000` 让自己的 query 复用 Watcher 的缓存**。但 queryKey 不同（`["task-notification-watch"]` vs `["tasks",page,pageSize,keyword,status]`），React Query 不会跨 key 复用。
   - **最终决策**：保持方案4最简形式——TasksPage 挂载时 Watcher refetchInterval: false，TasksPage onSuccess 无条件同步数据给 Watcher。过滤状态下的快照不完整是可接受的（用户正在主动过滤，说明在聚焦特定任务，通知重要性降低）。退出过滤后 TasksPage 会 refetch，onSuccess 再次同步完整数据。

## 文件变更清单

### 新建
- `src/components/ErrorBoundary.tsx`（含 ErrorBoundary 类组件 + ErrorFallback 函数组件）
- `src/components/ErrorBoundary.test.tsx`

### 修改
- `src/main.tsx`（顶层 ErrorBoundary 包裹 + 全局错误监听）
- `src/App.tsx`（路由级 ErrorBoundary 包裹）
- `src-tauri/Cargo.toml`（新增 keyring 依赖）
- `src-tauri/src/lib.rs`（新增 keychain_get/set/remove 命令 + invoke_handler 注册）
- `src-tauri/capabilities/default.json`（收紧 fs:scope）
- `src/lib/runtime.ts`（新增 secureStorage 适配器）
- `src/lib/auth-context.tsx`（改用 secureStorage + 初始化 catch + savedAccounts 迁移）
- `src/lib/saved-accounts.ts`（新增 migrateSavedAccountsFromStorage）
- `src/lib/i18n.tsx`（新增 5 个 notify.* 字典 key）
- `src/components/TaskNotificationWatcher.tsx`（i18nText 替换硬编码 + useMatch 路由检测 + refetchInterval 条件化）
- `src/pages/TasksPage.tsx`（搜索防抖 + onSuccess 同步数据给 Watcher）
- `tools/easy-console/config.ts`（CLI config 文件 chmod 600）
- `src/lib/i18n.test.tsx`（新增 notify.* key 测试）

## Verification Steps

按 AGENTS.md 要求执行：

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
```

**重点验证项**：
1. typecheck：keyring crate 类型、ErrorBoundary 类组件泛型、secureStorage 适配器类型
2. test：新增的 ErrorBoundary.test.tsx、i18n.test.tsx 的 notify.* key
3. build:desktop：Tauri 构建成功（keyring 编译通过）
4. cargo check：Rust 编译无误

**手动验证**（如条件允许）：
- 桌面端登录后检查 OS keychain 是否写入 easy-console 条目
- 桌面端搜索框连续输入，确认只发一次请求
- TasksPage 打开时 Watcher 不自轮询（DevTools Network 观察）
- 英文 locale 下触发通知权限警告，确认显示英文

## Risk & Rollback

**风险**：
1. keyring crate 在某些 Linux 桌面环境（无 D-Bus / Secret Service）会失败 → 已有降级到 tauriStorageAdapter 的 fallback
2. savedAccounts 从 storage 迁移到 secureStorage 可能丢失（如果迁移中途崩溃）→ 迁移是幂等的，下次启动会重试；且旧数据仍在 storage 中未删除直到迁移成功
3. ErrorBoundary 在 Provider 外层可能捕获到 Provider 自身初始化错误 → 这正是其价值，默认 fallback 不依赖任何 Provider
4. TasksPage onSuccess 同步过滤数据给 Watcher → 已在方案中说明可接受性

**回滚**：所有改动均在 git 版本控制下，`git revert` 即可回滚单次提交。建议按 P0 分 6 次提交，便于独立回滚。
