import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { browserRuntime } from "./runtime";
import { normalizeLocale, setActiveLocale, type Locale } from "./i18n-text";
export type { Locale } from "./i18n-text";

export const I18N_STORAGE_KEY = "easy-console-language";

export type TranslationKey = keyof typeof zhCN;

const zhCN = {
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.closeToast": "关闭提示",
  "common.confirm": "确认",
  "common.console": "控制台",
  "common.loading": "正在加载",
  "common.loadingTable": "正在加载表格",
  "common.loginExpired": "登录已过期，请重新登录",
  "common.networkError": "网络连接异常，请检查网络",
  "common.processing": "处理中",
  "common.requestFailed": "请求失败",
  "common.retry": "重试",
  "common.save": "保存",
  "common.settings": "设置",
  "common.apiSettings": "API 设置",
  "common.switchLanguage": "切换语言",
  "common.selectLanguage": "选择界面语言",
  "confirm.title": "确认操作",
  "language.zh": "中文",
  "language.en": "English",
  "language.zhShort": "中",
  "language.enShort": "EN",
  "nav.dashboard": "总览",
  "nav.tasks": "任务实例",
  "nav.scheduledTasks": "定时任务",
  "nav.taskTemplates": "实例模板",
  "nav.storage": "文件存储",
  "nav.images": "镜像",
  "nav.runLogs": "运行日志",
  "nav.settings": "设置",
  "title.dashboard": "运行总览",
  "title.tasks": "任务实例",
  "title.scheduledTasks": "定时任务",
  "title.taskTemplates": "实例模板",
  "title.storage": "文件存储",
  "title.images": "镜像管理",
  "title.runLogs": "运行日志",
  "title.settings": "系统设置",
  "shell.productSubtitle": "任务控制台",
  "shell.headerDescription": "集中查看任务、存储、镜像与终端状态",
  "shell.loggedIn": "已登录",
  "shell.logout": "退出",
  "shell.sidebar": "侧边栏",
  "shell.status": "状态",
  "shell.statusLabel": "后台状态",
  "shell.commitTooltip": "提交任务环境为镜像",
  "shell.logoutConfirmTitle": "退出登录",
  "shell.logoutConfirmDescription": "退出将结束当前会话，进行中的下载、终端和对话框会被关闭。",
  "shell.logoutConfirmLabel": "退出登录",
  "shell.keepOpen": "继续使用",
  "shell.shortcutsTitle": "键盘快捷键",
  "shell.shortcutsOpenCmd": "命令面板",
  "shell.shortcutsSearch": "聚焦搜索框",
  "shell.shortcutsNav": "跳转页面",
  "shell.shortcutsShortcuts": "查看快捷键",
  "shell.shortcutsResize": "调整侧栏宽度",
  "shell.shortcutsReset": "重置侧栏宽度",
  "login.restoreSession": "正在恢复登录状态",
  "login.failed": "登录失败",
  "login.savedLoginFailed": "直接登录失败，请重新输入密码",
  "login.tagline": "任务、终端、文件和镜像的统一工作台",
  "login.heroCopy": "用一个工作台接管任务启动、日志终端、文件传输和镜像查看，登录后即可继续日常操作。",
  "login.chooseSavedTitle": "选择账号登录",
  "login.passwordTitle": "登录控制台",
  "login.chooseSavedDescription": "使用上次登录保存的账号，或切换到其他账号。",
  "login.passwordDescription": "使用原控制面板账号继续。",
  "login.signingIn": "登录中",
  "login.savedSignIn": "直接登录",
  "login.removeSavedAccount": "移除 {{account}} 的保存记录",
  "login.switchAccount": "切换账号",
  "login.savedAccountNote": "保存记录不包含密码。直接登录会复用本机保存的登录令牌。",
  "login.username": "用户名",
  "login.password": "密码",
  "login.signIn": "登录",
  "login.returnSavedAccounts": "返回保存账号",
  "login.forgetTitle": "移除保存记录",
  "login.forgetDescription": "移除后需要重新输入用户名和密码登录。",
  "login.forgetConfirmLabel": "移除",
  "settings.apiBaseInvalid": "API Base URL 需要是 http 或 https 开头的完整地址",
  "settings.monitorUrlInvalid": "监控面板 URL 需要是 http 或 https 开头的完整地址",
  "settings.websshPending": "API Base URL 有效后自动生成",
  "settings.saveDescription": "后续请求会使用新的运行时配置",
  "settings.saveFailed": "保存设置失败",
  "settings.saved": "设置已保存",
  "settings.resetDescription": "当前使用环境变量或内置默认地址",
  "settings.resetDone": "设置已恢复默认",
  "settings.resetFailed": "恢复默认失败",
  "settings.runtimeTitle": "运行时地址",
  "settings.runtimeDescription": "保存在本机，优先级高于 .env 默认值。",
  "settings.resetDefault": "恢复默认",
  "settings.saving": "保存中",
  "settings.saveSettings": "保存设置",
  "settings.apiExample": "示例：http://116.172.93.164:28080/api",
  "settings.monitorDashboardUrl": "监控面板 URL",
  "settings.monitorHelp": "打开任务监控时会追加 var-pod 参数。",
  "settings.derivedTitle": "当前派生地址",
  "settings.scope": "生效范围",
  "settings.scopeDescription": "保存后，任务、镜像、存储、登录校验、监控链接和 WebSSH 地址会使用这组配置。已保存账号只保存 token，不保存密码。",
  "settings.backToLogin": "返回登录",
  "notify.permissionDenied": "系统通知未开启",
  "notify.unsupported": "当前环境不支持系统通知",
  "notify.permissionDeniedBody": "实例成功或失败时将只显示应用内提示。",
  "notify.unavailable": "系统通知不可用",
  "notify.unavailableBody": "可在设置中改为应用内通知或关闭该事件通知。",
} as const;

const enUS: Record<TranslationKey, string> = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.closeToast": "Dismiss notification",
  "common.confirm": "Confirm",
  "common.console": "Console",
  "common.loading": "Loading",
  "common.loadingTable": "Loading table",
  "common.loginExpired": "Session expired, please log in again",
  "common.networkError": "Network error, please check your connection",
  "common.processing": "Processing",
  "common.requestFailed": "Request failed",
  "common.retry": "Retry",
  "common.save": "Save",
  "common.settings": "Settings",
  "common.apiSettings": "API settings",
  "common.switchLanguage": "Switch language",
  "common.selectLanguage": "Select interface language",
  "confirm.title": "Confirm Action",
  "language.zh": "中文",
  "language.en": "English",
  "language.zhShort": "中",
  "language.enShort": "EN",
  "nav.dashboard": "Overview",
  "nav.tasks": "Task Instances",
  "nav.scheduledTasks": "Scheduled Tasks",
  "nav.taskTemplates": "Instance Templates",
  "nav.storage": "File Storage",
  "nav.images": "Images",
  "nav.runLogs": "Run Logs",
  "nav.settings": "Settings",
  "title.dashboard": "Runtime Overview",
  "title.tasks": "Task Instances",
  "title.scheduledTasks": "Scheduled Tasks",
  "title.taskTemplates": "Instance Templates",
  "title.storage": "File Storage",
  "title.images": "Image Management",
  "title.runLogs": "Run Logs",
  "title.settings": "System Settings",
  "shell.productSubtitle": "Task Console",
  "shell.headerDescription": "Centralized view of tasks, storage, images, and terminal status",
  "shell.loggedIn": "Signed in",
  "shell.logout": "Sign out",
  "shell.sidebar": "Sidebar",
  "shell.status": "Status",
  "shell.statusLabel": "Background status",
  "shell.commitTooltip": "Commit task state as image",
  "shell.logoutConfirmTitle": "Sign out",
  "shell.logoutConfirmDescription": "Signing out ends the current session. In-progress downloads, terminals, and dialogs will be closed.",
  "shell.logoutConfirmLabel": "Sign out",
  "shell.keepOpen": "Keep open",
  "shell.shortcutsTitle": "Keyboard shortcuts",
  "shell.shortcutsOpenCmd": "Command palette",
  "shell.shortcutsSearch": "Focus search",
  "shell.shortcutsNav": "Navigate pages",
  "shell.shortcutsShortcuts": "Show shortcuts",
  "shell.shortcutsResize": "Resize sidebar",
  "shell.shortcutsReset": "Reset sidebar width",
  "login.restoreSession": "Restoring sign-in state",
  "login.failed": "Sign-in failed",
  "login.savedLoginFailed": "Saved sign-in failed. Enter the password again.",
  "login.tagline": "A unified workspace for tasks, terminals, files, and images",
  "login.heroCopy": "Use one workspace to manage task starts, log terminals, file transfer, and image review. Sign in to continue daily operations.",
  "login.chooseSavedTitle": "Choose an Account",
  "login.passwordTitle": "Sign In",
  "login.chooseSavedDescription": "Use a previously saved account or switch to another account.",
  "login.passwordDescription": "Continue with your original console account.",
  "login.signingIn": "Signing in",
  "login.savedSignIn": "Quick sign in",
  "login.removeSavedAccount": "Remove saved record for {{account}}",
  "login.switchAccount": "Switch account",
  "login.savedAccountNote": "Saved records do not include passwords. Quick sign-in reuses the local token.",
  "login.username": "Username",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.returnSavedAccounts": "Back to saved accounts",
  "login.forgetTitle": "Remove saved account",
  "login.forgetDescription": "You will need to re-enter the username and password to sign in.",
  "login.forgetConfirmLabel": "Remove",
  "settings.apiBaseInvalid": "API Base URL must be a full URL starting with http or https",
  "settings.monitorUrlInvalid": "Monitor dashboard URL must be a full URL starting with http or https",
  "settings.websshPending": "Generated after API Base URL is valid",
  "settings.saveDescription": "Subsequent requests will use the new runtime settings",
  "settings.saveFailed": "Failed to save settings",
  "settings.saved": "Settings saved",
  "settings.resetDescription": "Using environment variables or built-in defaults",
  "settings.resetDone": "Settings restored to defaults",
  "settings.resetFailed": "Failed to restore defaults",
  "settings.runtimeTitle": "Runtime URLs",
  "settings.runtimeDescription": "Saved locally and takes precedence over .env defaults.",
  "settings.resetDefault": "Restore defaults",
  "settings.saving": "Saving",
  "settings.saveSettings": "Save settings",
  "settings.apiExample": "Example: http://116.172.93.164:28080/api",
  "settings.monitorDashboardUrl": "Monitor Dashboard URL",
  "settings.monitorHelp": "Task monitor links append the var-pod parameter.",
  "settings.derivedTitle": "Derived URLs",
  "settings.scope": "Applies to",
  "settings.scopeDescription": "After saving, tasks, images, storage, sign-in checks, monitor links, and WebSSH URLs will use this configuration. Saved accounts store tokens only, not passwords.",
  "settings.backToLogin": "Back to sign in",
  "notify.permissionDenied": "System notifications are disabled",
  "notify.unsupported": "System notifications are not supported in this environment",
  "notify.permissionDeniedBody": "In-app toasts will be shown for instance success or failure.",
  "notify.unavailable": "System notifications are unavailable",
  "notify.unavailableBody": "Switch to in-app notifications or disable this event in Settings.",
};

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  text: (zh: string, en: string) => string;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
};

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "zh-CN";
  return normalizeLocale(window.navigator.language) ?? "zh-CN";
}

function translate(locale: Locale, key: TranslationKey, values?: Record<string, string | number>) {
  const template = dictionaries[locale][key] ?? dictionaries["zh-CN"][key] ?? key;
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(values[name] ?? match));
}

const fallbackValue: I18nContextValue = {
  locale: "zh-CN",
  setLocale: () => {},
  text: (zh) => zh,
  t: (key, values) => translate("zh-CN", key, values),
};

const I18nContext = createContext<I18nContextValue>(fallbackValue);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  useEffect(() => {
    let cancelled = false;
    void browserRuntime.storage.get(I18N_STORAGE_KEY).then((stored) => {
      const nextLocale = normalizeLocale(stored);
      if (!cancelled && nextLocale) setLocaleState(nextLocale);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setActiveLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    void browserRuntime.storage.set(I18N_STORAGE_KEY, nextLocale);
  }, []);

  const text = useCallback((zh: string, en: string) => (locale === "en-US" ? en : zh), [locale]);
  const t = useCallback((key: TranslationKey, values?: Record<string, string | number>) => translate(locale, key, values), [locale]);
  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, text, t }), [locale, setLocale, text, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  return useContext(I18nContext);
}
