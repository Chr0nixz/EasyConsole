# P3 修复计划 — 锦上添花（7 项）

## Summary

实施 AUDIT.md 中全部 7 项 P3 修复（#28-#34），覆盖运行日志高级筛选/导出、备份加密与自动备份、镜像收藏与详情、桌面深链接与全局快捷键、模板变量替换、Vite 构建优化、Tauri setup 合并读与托盘懒创建。

P3 定位为"锦上添花"，优先采用最小侵入、低风险方案；涉及新依赖的项（P3-31 深链接）若引入复杂度过高则降级为可后续实施。

## Assumptions & Decisions

| 决策点 | 选择 | 理由 |
|---|---|---|
| P3-28 日志导出格式 | 新增 CSV + Markdown（保留现有 JSON） | 不破坏已有导出；CSV 便于表格软件，Markdown 便于可读报告 |
| P3-28 高级搜索 | 支持 `key:value` 语法解析（action:/level:/source:/result:/user:） | 结构化查询低成本，无需引入专门查询引擎 |
| P3-28 保留策略 | SettingsPage 增加可配置项（条数/天数） | 硬编码改为读取 app-settings，零迁移成本 |
| P3-29 备份加密 | Web Crypto API（AES-GCM 256），密码派生用 PBKDF2 | 浏览器/Tauri 均原生支持，无需引入 Node crypto；不加密则保留明文 JSON |
| P3-29 自动备份 | 桌面端启动时检查上次备份时间，超过 7 天提示（非强制） | 避免后台定时器复杂度；用户确认后触发 |
| P3-29 版本迁移 | 新增 `migrateBackup(backup)` 函数，当前 v1 直通，预留 v2+ 路径 | 最小实现，不引入完整迁移框架 |
| P3-30 镜像收藏 | 本地 runtime-storage 存储 `easy-console.favoriteImages`（id 列表） | 与现有本地数据模式一致，无需后端支持 |
| P3-31 深链接 | 启用 `tauri-plugin-deep-link`，支持 `easyconsole://task/{id}` | 官方插件，CSP 友好；全局快捷键用 `tauri-plugin-global-shortcut` |
| P3-31 全局快捷键 | 仅注册 `Super+Alt+E`（可选）唤起主窗口 | 单一快捷键降低冲突风险；用户可在设置开关 |
| P3-32 模板变量 | 模板新增 `variables: { key, label, defaultValue }[]`；执行时弹窗收集；支持 `${key}` 占位符替换 name/storagePath/scriptPath/workDirectory | 字符串替换最小实现，不引入表达式引擎 |
| P3-33 Vite 构建 | `target: 'es2020'`, `reportCompressedSize: false`, `chunkSizeWarningLimit: 1500`；manualChunks 增加 zod/commander/@modelcontextprotocol/sdk 分组 | 减小体积 + 加快构建；防误打入渲染层 |
| P3-34 setup 合并读 | 新增 `read_close_settings(app) -> (tray: bool, prompt: bool)` 一次读取 | 消除二次文件 IO |
| P3-34 托盘懒创建 | `setup_tray` 不再立即 `ensure_tray_menu_window`，改为首次 `show_tray_menu` 时创建（已实现） | 实际代码已懒创建，仅需从 setup 中移除早期调用 |

## Proposed Changes

### P3-28 运行日志 level 筛选与高级搜索

**文件变更**：
- `src/lib/run-logs.ts`：
  - 新增 `parseAdvancedQuery(query: string): RunLogFilter` — 解析 `key:value` 语法，未识别 token 作为 keyword
  - 新增 `formatRunLogCsv(items): string` — CSV 导出（含表头）
  - 新增 `formatRunLogMarkdown(items): string` — Markdown 表格导出
  - `RunLogFilter` 新增 `userName?: string` 字段
  - `filterRunLogs` 增加 `userName` 过滤分支
- `src/pages/RunLogsPage.tsx`：
  - 筛选栏增加 level Select（info/warning/error）
  - 搜索框 placeholder 提示 `key:value` 语法（如 `action:task.create level:error`）
  - 导出下拉增加 CSV / Markdown 选项
- `src/lib/app-settings.ts`：
  - 新增 `runLogLimit?: number`（默认 1000）和 `runLogRetentionDays?: number`（默认 30）字段
  - 解析与序列化保留这两个字段
- `src/pages/SettingsPage.tsx`：
  - 增加"运行日志保留策略"section（条数 + 天数输入）

### P3-29 备份加密与自动备份

**新增文件**：`src/lib/backup-crypto.ts`
- `encryptBackup(plaintext: string, password: string): Promise<string>` — PBKDF2 派生密钥 + AES-GCM 加密，输出 `ecenc:v1:` 前缀 base64
- `decryptBackup(encrypted: string, password: string): Promise<string>` — 解密，校验前缀
- salt 随机生成并内嵌于输出，IV 随机生成内嵌于输出

**文件变更**：
- `src/lib/local-data-backup.ts`：
  - 新增 `migrateBackup(backup): LocalDataBackup` — 当前 v1 直通
  - `exportLocalDataBackup` 增加 `sections?: LocalDataBackupSection[]` 参数支持选择性导出
  - 新增 `encryptExport(backup, password)` / `importEncrypted(text, password)` 包装函数
  - `parseLocalDataBackup` 识别 `ecenc:v1:` 前缀时抛出"需要密码"错误
- `src/pages/SettingsPage.tsx`（备份 section）：
  - 导出对话框增加"加密（需要密码）"开关 + 密码输入
  - 导入对话框增加"加密文件"检测 + 密码输入
  - 增加选择性导出 checkbox 组（settings/language/templates/scheduled/runLogs/token/accounts）
  - 桌面端启动时检查 `lastBackupAt`，超过 7 天显示提示 banner

### P3-30 镜像收藏与详情 Dialog

**新增文件**：`src/components/images/ImageDetailDialog.tsx`
- 调用 `imageApi.detail(id)` 展示完整字段（创建时间、大小、依赖、命令等）
- 以键值对表格 + JSON 原始视图（可折叠）呈现

**文件变更**：
- `src/lib/types.ts`：新增 `FavoriteImages` 类型 = `string[]`
- `src/pages/ImagesPage.tsx`：
  - 表格行增加星标按钮（收藏/取消），调用本地存储
  - 筛选栏增加"仅看收藏"开关
  - 行点击打开 ImageDetailDialog
  - 下载按钮接入 `signal` + `onProgress`（显示进度条）
- `src/lib/image-favorites.ts`（新增）：`loadFavoriteImages`/`saveFavoriteImages`/`toggleFavoriteImage` 本地存储辅助

### P3-31 桌面端深链接与全局快捷键

**新增依赖**：
- `src-tauri/Cargo.toml`：`tauri-plugin-deep-link`、`tauri-plugin-global-shortcut`
- `package.json`：`@tauri-apps/plugin-deep-link`、`@tauri-apps/plugin-global-shortcut`

**文件变更**：
- `src-tauri/src/lib.rs`：
  - setup 中注册 `tauri_plugin_deep_link::init()` 和 `tauri_plugin_global_shortcut::Builder::new()`
  - deep-link 事件监听：解析 `easyconsole://task/{id}` → emit 事件给前端
  - global-shortcut 注册 `Super+Alt+E` → `show_main_window`
- `src-tauri/tauri.conf.json`：`tauri-plugin-deep-link` schema 配置
- `src/lib/runtime.ts`：新增 `onDeepLink(handler)` 适配器
- `src/App.tsx`：监听 deep-link 事件，`easyconsole://task/{id}` → `navigate(/tasks/${id})`
- `src/pages/SettingsPage.tsx`：增加"启用全局快捷键"开关

**降级策略**：若 `tauri-plugin-deep-link` 在当前 Tauri 版本编译失败，则跳过深链接部分，仅保留全局快捷键；若两者均失败则整体跳过 P3-31 并在文档记录。

### P3-32 模板变量替换系统

**文件变更**：
- `src/lib/types.ts`：
  - `TaskTemplate` 新增 `variables?: TaskTemplateVariable[]`
  - 新增 `TaskTemplateVariable = { key: string; label: string; defaultValue: string }`
- `src/lib/task-templates.ts`：
  - `normalizeTemplate` 解析 `variables` 字段
  - 新增 `applyTemplateVariables(template, values): { name, storagePath, workDirectory, scriptPath }` — 执行 `${key}` 替换
  - `taskTemplateToPayloads` 增加 `variables?: Record<string, string>` 参数，替换后生成 payload
- `src/pages/TaskTemplatesPage.tsx`：
  - 模板编辑对话框增加"变量"配置区（key/label/defaultValue 列表）
  - 执行模板时：若 `variables.length > 0`，弹窗收集参数 → 应用替换 → dry-run 预览 50 条名称 → 确认提交
  - 新增"导出模板"按钮（单条 `.json`）和"导入模板"按钮

### P3-33 Vite 构建优化

**文件变更**：
- `vite.config.ts`：
  ```typescript
  build: {
    target: "es2020",
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("@tanstack")) return "vendor-tanstack";
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("zod") || id.includes("commander") || id.includes("@modelcontextprotocol/sdk")) return "vendor-tools";
          if (id.includes("react") || id.includes("react-dom") || id.includes("react-router-dom")) return "vendor-react";
          return "vendor";
        },
      },
    },
  },
  ```

### P3-34 Tauri setup 合并读 + 托盘窗口懒创建

**文件变更**：
- `src-tauri/src/lib.rs`：
  - 新增 `read_close_settings(app) -> Result<(bool, bool), String>` — 一次读取 `runtime-storage.json`，同时解析 `desktopCloseToTray` 和 `desktopClosePrompt`
  - setup 中替换两次 `read_close_*_setting` 调用为单次 `read_close_settings`
  - `setup_tray` 中移除 `ensure_tray_menu_window(app.handle())?`（已由 `show_tray_menu` 懒创建）— 仅保留 `TrayIconBuilder` 构建
  - 保留 `ensure_tray_menu_window` 函数供 `show_tray_menu` 调用

## Implementation Order

按风险和依赖分组：

1. **零风险快速项**：#33 Vite 构建、#34 Tauri setup 合并读
2. **日志增强**：#28 运行日志筛选/导出
3. **镜像增强**：#30 镜像收藏与详情
4. **模板变量**：#32 模板变量替换
5. **备份增强**：#29 备份加密与自动备份
6. **桌面能力**：#31 深链接与全局快捷键（风险最高，最后实施）

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

- **P3-29 备份加密**：Web Crypto API 在旧浏览器可能不支持，但项目 target 已设 es2020+，且 Tauri webview 支持；回退为不加密明文 JSON
- **P3-31 深链接/全局快捷键**：依赖新 Tauri 插件，若编译失败则降级跳过；不影响其他功能
- **P3-32 模板变量**：变量替换可能破坏现有模板兼容性；`variables` 字段可选，无变量的模板行为不变
- **P3-34 setup 合并读**：Rust 侧逻辑变更需确保 `(tray, prompt)` 默认值与原函数一致（tray=false, prompt=true）
