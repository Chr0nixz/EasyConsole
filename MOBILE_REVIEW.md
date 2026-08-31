---
timestamp: 2026-08-31
version: v0.4.22
scope: EasyConsole Web renderer 移动端体验与 Android 应用内更新链路，重点为 320–414px 竖屏
method: 运行态窄屏复现 + 源码静态核对 + 自动化验证 + Impeccable audit
viewports: 320x844, 375x844, 390x844, 414x896
overall_score: 18/20
finding_count: P0 0 / P1 5（代码已修复） / P2 10（代码已修复） / P3 0
status: P1/P2 与 Android 更新链路已修复，待真实移动设备安装、软键盘、safe-area 与 SSH 回归
---

# EasyConsole 移动端竖屏体验审阅报告

## 1. 执行摘要

当前移动端具备可用的基础壳层：登录、仪表盘、任务列表、详情、定时任务、模板、镜像、存储和运行日志在常见竖屏宽度下基本可浏览，底部导航、移动菜单和浏览器端 SSH 降级路径也能工作。

上一轮审阅的风险集中在窄屏核心操作，而不是页面级基础布局；本轮已完成 5 个 P1 和 10 个 P2 的代码修复，仍需真实设备回归确认：

- 320px 下新建任务环境变量 Value 输入框曾实际可见宽约 22px，现已改为窄屏单列。
- 普通手机浏览器系统返回曾可能离开当前路由，现已由 compact layout 返回栈按层消费。
- SSH 多会话曾可能被旧 request 切回初始会话，现已使用稳定 target key 同步。
- SSH SFTP/端口转发曾固定占用 320px，现已在窄屏改为全宽覆盖层。
- Android 更新曾可能下载错误 ABI，且安装 Intent 无法可靠授予系统安装器读取 APK 的权限，现已改为原生 ABI 精确匹配与受限 FileProvider 安装。

没有发现 P0。代码层面的 P1/P2 已完成；竖屏发布前应完成真实设备、系统返回、软键盘和 SSH/SFTP 回归。

## 2. 审阅口径

### 2.1 优先级

| 等级 | 定义 | 处理要求 |
|---|---|---|
| **P0** | 阻止任务完成，或造成不可接受的数据/安全后果 | 立即修复 |
| **P1** | 核心流程在竖屏下阻断、产生错误结果，或严重偏离移动平台预期 | 当前发布周期处理 |
| **P2** | 有绕过方式，但显著影响效率、可访问性、可发现性或稳定性 | 下一迭代处理并加回归测试 |
| **P3** | 不影响核心正确性，主要是细节优化 | 后续优化 |

### 2.2 范围与限制

- 动态检查使用本地 renderer `http://127.0.0.1:4173/`，视口为 320、375、390、414px 竖屏。
- 覆盖登录、仪表盘、任务、任务详情、定时任务、实例模板、镜像、存储和运行日志等页面，以及新建任务、移动菜单、远程存储选择器和 SSH 相关界面。
- 未输入真实账号、密码、token，未操作真实后端任务、存储或 SSH 主机。
- 已完成 Android aarch64/x86_64 Rust 交叉检查、Kotlin 编译和 aarch64 Debug APK 打包；尚未在真实 Android/iOS 设备覆盖安装升级、刘海屏 safe-area、系统返回手势、真实软键盘、真实粗指针和真实 SSH/SFTP 行为。
- 工作区已有用户未提交改动；本轮在保留 P1 相关实现的基础上完成 P2、回归测试和本报告，没有回滚无关改动。

## 3. 健康评分

| 维度 | 分数 | 依据 |
|---|---:|---|
| 可访问性 | 3/4 | 焦点、表单标签和 Dialog ARIA 基础较好；SFTP 行、SSH 标签与移动菜单已补齐语义和触控目标，仍待真实辅助技术回归 |
| 性能 | 3/4 | 未发现明显移动端重渲染或重资源问题；存在既有 lint warning 与会话 effect 风险 |
| 响应式 | 3/4 | P1 固定宽度/返回栈与 P2 的表格、页签、操作栏、可视视口均已修复，仍待真实设备采样 |
| 主题 | 4/4 | 设计 token 使用一致，颜色和密度符合操作型产品；检测器仅报告 `Inter` 字体 advisory |
| 实现完整性 | 4/4 | 产品特定的控制台结构清晰，没有结构性装饰或设计系统漂移 |
| **合计** | **18/20** | **Good：P1/P2 已修复，进入真实设备回归阶段** |

## 4. P1：发布前处理

### MOB-01 环境变量 Value 输入框几乎不可编辑

**状态：已修复（待真实设备回归）**

- **位置**：[src/components/tasks/ScriptEnvFields.tsx:83](src/components/tasks/ScriptEnvFields.tsx#L83)
- **类别**：响应式 / 表单可用性
- **原始证据**：行布局固定为 `grid-cols-[1fr_1fr_auto]`。320px 下 Value 输入框可见宽约 22px；320/390px 均可观察到内部横向溢出。
- **影响**：用户无法可靠输入或检查环境变量值；这是新建任务核心流程的实际阻断。存在 WCAG 1.4.10 Reflow 风险。
- **处理**：`<640px` 使用单列布局，`sm` 以上恢复三列；名称和值输入均使用 `min-w-0 w-full`，删除按钮保持独立触控目标。新增 `ScriptEnvFields.test.tsx` 覆盖输入写入和按行删除。

### MOB-02 窄屏 Web 返回键会离开当前路由

**状态：已修复（待真实设备回归）**

- **位置**：[src/lib/MobileBackStackProvider.tsx:18](src/lib/MobileBackStackProvider.tsx#L18)、[src/lib/use-compact-layout.ts:13](src/lib/use-compact-layout.ts#L13)
- **类别**：导航 / 移动平台行为
- **原始证据**：返回栈只判断 `browserRuntime.isMobile`，而普通浏览器的窄屏布局由 `matchMedia(max-width: 767px)` 激活。320px 下打开“更多”菜单后按浏览器返回，结果从 `/tasks` 返回 `/dashboard`，而不是关闭菜单。
- **影响**：用户容易误离开当前页面、丢失上下文；系统返回行为与移动用户预期不一致。
- **处理**：`MobileBackStackProvider` 统一使用 `useCompactLayout()`，窄屏 Web 与原生移动 runtime 都注册层；所有活动层共用一个 history sentinel，按 LIFO 关闭，非栈顶卸载和 StrictMode 清理不会留下陈旧 entry。新增 6 个返回栈测试，覆盖窄屏 Web、宽屏路由、多层、StrictMode 和清理。

### MOB-03 SSH 多会话可能切回初始会话

**状态：已修复（待真实 SSH 设备回归）**

- **位置**：[src/components/tasks/AppSshTerminalDialog.tsx:131](src/components/tasks/AppSshTerminalDialog.tsx#L131)
- **类别**：功能正确性 / 状态生命周期
- **原始证据**：初始化/同步 effect 依赖 `activeTabId`，effect 内又会根据传入 `request` 设置活动标签并创建标签。
- **影响**：创建 B 会话后可能被重新切回 A；关闭标签后也可能按旧 request 重建会话，造成多会话操作混乱。
- **处理**：使用 `host/port/username/taskId` 生成稳定 target key，并通过 `lastSyncedRequestKeyRef` 仅在目标改变时同步；`activeTabIdRef` 统一覆盖打开、切换、关闭和 request 同步路径，初始化 effect 不再依赖活动标签。新增 3 个测试覆盖新建 B、复用已有目标和关闭 fallback。

### MOB-04 SSH 辅助面板挤压终端

**状态：已修复（待真实 SSH/SFTP 设备回归）**

- **位置**：[src/components/tasks/SshTerminalTab.tsx:664](src/components/tasks/SshTerminalTab.tsx#L664)
- **类别**：响应式 / 核心功能
- **原始证据**：SFTP 与端口转发面板均使用固定 `w-80 shrink-0`。
- **影响**：320–375px 竖屏中终端区域被压缩到几乎不可用，尤其在同时查看输出和文件操作时。
- **处理**：`<768px` 在终端内容区内使用 `absolute inset-0 z-20 w-full` 全宽覆盖层，桌面 `md` 以上继续使用 `w-80 shrink-0` 侧栏；SFTP 和端口转发触发按钮增加 `aria-expanded/aria-controls`，移动面板提供关闭按钮，不销毁 SSH session。新增 i18n/布局回归测试。

### MOB-15 Android 自动更新可能下载错误 APK 或无法启动安装器

**状态：已修复（待真实设备升级回归）**

- **位置**：[app-update.ts](src/lib/app-update.ts)、[MainActivity.kt](src-tauri/gen/android/app/src/main/java/com/easyconsole/desktop/MainActivity.kt)、[release.yml](.github/workflows/release.yml)
- **类别**：功能正确性 / 发布完整性 / Android 平台集成
- **原始证据**：WebView User-Agent 无法可靠提供 ABI，失败时默认 ARM64 且会回退到任意 APK；`tauri-plugin-opener` 的 Android `ACTION_VIEW` 未提供 APK MIME、FileProvider content URI 或临时读取授权；发布 workflow 在缺少 signing secrets 时仍允许上传 unsigned APK。
- **影响**：x86_64 模拟器可能收到 ARM64 APK 并触发 ABI 不匹配；系统安装器可能无法读取应用下载的文件；未签名或签名变化的 APK 无法覆盖已安装版本。
- **处理**：由 Android Rust target 返回真实 ABI 并只接受精确命名资源；下载改到 `$APPCACHE/updates` 并在前端/原生两层校验 APK ZIP 头；JNI 调用 `MainActivity.installApk`，使用仅覆盖 `cache/updates/` 的 FileProvider、APK MIME 与临时读取授权，并处理 Android 8+ 未知来源权限；发布 workflow 强制四项签名 secret 齐全并通过 `apksigner` 后才上传。

## 5. P2：代码修复完成，待设备回归

### MOB-05 全屏 Dialog 与移动操作栏产生溢出

**状态：已修复（待真实软键盘回归）**

- **处理**：[ui.tsx](src/components/ui.tsx) 的 Dialog/Drawer 在 compact layout 使用共享 `visualViewport` 高度与顶部偏移；新建任务表单改为独立可滚动字段区和 `shrink-0` 操作栏，移除了负外边距/sticky 溢出来源。safe-area 仅由实际贴边操作栏消费。
- **回归重点**：320–414px 打开软键盘后，字段区可滚动，取消/创建按钮仍可见，`scrollWidth <= clientWidth`。

### MOB-06 远程存储选择器固定最小宽度

**状态：已修复（待 320px 回归）**

- **处理**：[RemoteStoragePicker.tsx](src/components/storage/RemoteStoragePicker.tsx) 在 compact layout 改为无最小宽度的列表：目录点击进入、文件点击选择，名称、类型和大小同时显示；桌面继续使用 `min-w-[560px]` 表格。

### MOB-07 任务详情页签在 320px 溢出

**状态：已修复（待 320px 回归）**

- **处理**：[TaskDetailPage.tsx](src/pages/TaskDetailPage.tsx) 在 `<768px` 使用原生 Select 切换日志、监控、终端和原始 JSON；桌面仍保留 ARIA tablist、方向键和原布局。

### MOB-08 SFTP 文件行触控和键盘语义不完整

**状态：已修复（待真实粗指针回归）**

- **处理**：[SftpPanel.tsx](src/components/tasks/SftpPanel.tsx) 文件项改为 `li > button`，保留单击选择、双击/Enter 进入目录，补齐 Space；在 coarse pointer 下保证至少 44px 高度。

### MOB-09 粗指针全局规则使 SSH 工具栏拥挤

**状态：已修复（待 320px 回归）**

- **处理**：[SshTerminalTab.tsx](src/components/tasks/SshTerminalTab.tsx) 保留 44px SFTP 直达入口，将搜索、录制和端口转发收进“更多终端工具” action sheet；菜单支持 Escape/返回关闭和焦点返回，桌面工具栏维持原有布局。

### MOB-10 SSH 会话标签关闭入口过小且不易发现

**状态：已修复（待键盘/触控回归）**

- **处理**：[AppSshTerminalDialog.tsx](src/components/tasks/AppSshTerminalDialog.tsx) 采用独立 tab button 与 close button，消除嵌套交互控件；移动端两者均为 44px，关闭后焦点转移至 fallback tab。`aria-controls` 现对应每个终端 `tabpanel`。

### MOB-11 Dialog/Drawer 未统一处理键盘视口和 safe-area

**状态：已修复（待真实 safe-area 回归）**

- **处理**：新增 [use-visual-viewport.ts](src/lib/use-visual-viewport.ts)，Dialog、Drawer 与 Toast 共享可视高度/底部遮挡数据。全屏/底部面板按可视视口布局，Toast 在键盘出现时避让键盘和底部导航。

### MOB-12 紧凑布局与运行时能力判断不一致

**状态：已修复（待 Web phone 回归）**

- **处理**：[StoragePage.tsx](src/pages/StoragePage.tsx) 使用 `useCompactLayout()` 隐藏“上传文件夹”，不再仅依赖原生移动 runtime；多文件上传仍可用。

### MOB-13 通知权限请求和 Toast 会遮挡短视口内容

**状态：已修复（待系统权限回归）**

- **处理**：[RuntimeTransport](src/lib/types.ts) 新增只读 `getSystemNotificationPermission()`；Settings 的系统通知选择和测试通知才会显式请求权限。`TaskNotificationWatcher` 不再在加载时弹授权框，现有 system 偏好未授权时直接降级为应用内状态提示，且不产生重复权限 toast。

### MOB-14 长文本依赖 truncate/title，触摸设备无法可靠查看

**状态：已修复（待真机文本回归）**

- **处理**：新增 [MobileLongText.tsx](src/components/MobileLongText.tsx)，以两行摘要、展开/收起和路径复制替代 hover-only 截断。已接入定时任务、实例模板、存储卡片和运行日志的描述、路径、对象、摘要与错误；桌面表格保持原密度。

## 6. 额外待确认项

运行时日志出现 React duplicate key `1`。可能是 custom/system image 合并后使用 `String(image.id)` 作为 key，相关位置为 [CreateTaskDialog.tsx:724](src/components/tasks/CreateTaskDialog.tsx#L724)、[ScheduledTasksPage.tsx:721](src/pages/ScheduledTasksPage.tsx#L721)、[TaskTemplatesPage.tsx:277](src/pages/TaskTemplatesPage.tsx#L277)。建议为不同来源增加命名空间并用真实 API 数据确认；该项暂不计入上面的 P2 数量。

## 7. 正面表现

- 320/375/390/414px 下主要页面没有页面根级横向溢出，任务卡片、存储、镜像、日志、定时任务和模板的基础浏览路径清晰。
- 底部导航、移动“更多”菜单、连接信息弹层和 `dvh` 全屏新建任务已经具备移动化基础结构。
- 浏览器端明确降级为可复制 SSH 连接信息，没有暗示浏览器可以直接打开本地 SSH 会话。
- 全局焦点可见、表单控件有标签、Dialog 使用 modal 语义，颜色和状态 token 基本一致。

## 8. 验证记录

| 检查 | 结果 |
|---|---|
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run typecheck:tools` | 通过 |
| `npm.cmd run test -- --run` | 75 个测试文件、409 个测试通过 |
| `npm.cmd run lint` | 退出码 0，46 个既有 warning，无 error |
| `npm.cmd run build:desktop` | 通过，Vite production build 完成 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| Android Rust `aarch64-linux-android` / `x86_64-linux-android` check | 通过 |
| Android Kotlin `compileUniversalDebugKotlin` | 通过 |
| Android aarch64 Debug APK | 打包通过；`versionName=0.4.22`、`versionCode=4022`、APK v2 签名结构与 `REQUEST_INSTALL_PACKAGES` 已验证 |
| Impeccable detector | 仅 `styles.css:28` 的 `Inter` 字体 advisory，无结构性 UI 反模式 |
| 定向 P1/P2 测试 | 返回栈、环境变量、SSH 多会话/覆盖层、长文本复制、通知授权回退全部通过 |

### 8.1 P1/P2 动态验收状态

| 场景 | 320 | 375 | 390 | 414 | 结论 |
|---|---:|---:|---:|---:|---|
| 环境变量 Value 输入可编辑、单列不挤压 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 待真实浏览器采样 `scrollWidth <= clientWidth` |
| 窄屏 Web 返回关闭移动层 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 待 Chrome/Android 系统返回手势 |
| SSH A/B 标签同步与 fallback | 自动化 mock | 自动化 mock | 自动化 mock | 自动化 mock | 待真实 SSH/SFTP session |
| SFTP/端口转发全宽覆盖层、桌面 `md` 侧栏 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 待真实粗指针与终端渲染 |
| 全屏表单、存储选择器、详情视图和长文本 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 待真实软键盘与页面溢出采样 |
| 系统通知显式授权、未授权降级与 Toast 避让 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 代码/自动化 | 待 Android/iOS 浏览器或 Tauri 权限回归 |

“代码/自动化”表示已有结构断言和单元/组件测试通过；当前环境没有真实账号、SSH 主机或移动设备，不能据此宣称设备验收完成。

## 9. 推荐修复顺序

1. **P1/P2 设备回归**：在 Chrome/Android、Safari/iOS 或真实 Tauri 移动环境验证系统返回手势、软键盘、safe-area、粗指针、通知权限和真实 SSH/SFTP session。
2. **实测溢出记录**：在 320/375/390/414px 逐页记录 `scrollWidth <= clientWidth`、操作栏可见性和 SSH 覆盖层恢复行为。
3. **发布前复核**：完成设备回归后重新运行全量检查，并用 `$impeccable audit` 做最终可访问性与响应式审阅。
