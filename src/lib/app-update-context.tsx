import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import {
  APP_UPDATE_RELEASE_URL,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  downloadMobileApk,
  getCurrentAppVersion,
  installMobileApk,
  loadAppUpdateState,
  relaunchAppAfterUpdate,
  saveAppUpdateState,
  shouldAutoCheckForUpdates,
  shouldShowDismissedUpdate,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from "./app-update";
import { getRuntimeSettings } from "./app-settings";
import { useI18n } from "./i18n";
import { browserRuntime } from "./runtime";
import { errorMessage, useRunLogger } from "./use-run-logger";
import { useToast } from "./use-toast";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "readyToRestart"
  | "upToDate"
  | "error"
  | "unsupported";

export type AppUpdateState = {
  status: AppUpdateStatus;
  info?: AppUpdateInfo;
  progress?: AppUpdateProgress;
  error?: string;
  currentVersion?: string;
  lastCheckedAt?: string;
  dialogOpen: boolean;
  apkPath?: string;
};

type AppUpdateContextValue = {
  state: AppUpdateState;
  checkForUpdates: (manual?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  relaunchAfterUpdate: () => Promise<void>;
  dismissUpdate: () => Promise<void>;
  openUpdateDialog: () => void;
  closeUpdateDialog: () => void;
  openReleasePage: () => void;
};

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

function isTrayMenuWindow() {
  if (typeof window === "undefined") return false;
  return window.location.hash.includes("/tray-menu") || window.location.pathname.includes("/tray-menu");
}

function initialState(): AppUpdateState {
  return {
    status: browserRuntime.supportsUpdater && !isTrayMenuWindow() ? "idle" : "unsupported",
    dialogOpen: false,
  };
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { text } = useI18n();
  const toast = useToast();
  const runLogger = useRunLogger();
  const [state, setState] = useState<AppUpdateState>(initialState);
  const [updateHandle, setUpdateHandle] = useState<Update | null>(null);

  useEffect(() => {
    if (!browserRuntime.supportsUpdater || isTrayMenuWindow()) return;
    let cancelled = false;
    void getCurrentAppVersion().then((currentVersion) => {
      if (!cancelled) setState((value) => ({ ...value, currentVersion }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (!browserRuntime.supportsUpdater || isTrayMenuWindow()) {
      setState((value) => ({ ...value, status: "unsupported", dialogOpen: manual ? true : value.dialogOpen }));
      return;
    }

    setState((value) => ({ ...value, status: "checking", error: undefined, dialogOpen: manual ? true : value.dialogOpen }));
    try {
      const result = await checkForAppUpdate();
      const checkedAt = new Date().toISOString();

      if (!manual) {
        const stored = await loadAppUpdateState();
        await saveAppUpdateState({ ...stored, lastAutoCheckAt: checkedAt });
      }

      if (result.kind === "unsupported") {
        setState((value) => ({
          ...value,
          status: "unsupported",
          currentVersion: result.currentVersion,
          lastCheckedAt: checkedAt,
        }));
        return;
      }

      if (result.kind === "upToDate") {
        setUpdateHandle(null);
        setState((value) => ({
          ...value,
          status: "upToDate",
          currentVersion: result.currentVersion,
          info: undefined,
          progress: undefined,
          lastCheckedAt: checkedAt,
          dialogOpen: manual ? true : value.dialogOpen,
        }));
        if (manual) toast.success(text("已是最新版本", "Already up to date"), result.currentVersion);
        void runLogger.log({
          source: "system",
          channel: "tauri",
          level: "info",
          action: "app.update.check",
          result: "success",
          title: text("更新检查完成", "Update check completed"),
          metadata: { currentVersion: result.currentVersion, available: false },
        });
        return;
      }

      setUpdateHandle(result.update ?? null);
      const stored = await loadAppUpdateState();
      const showDialog = manual || shouldShowDismissedUpdate(result.info, stored);
      setState((value) => ({
        ...value,
        status: "available",
        info: result.info,
        currentVersion: result.info.currentVersion,
        progress: undefined,
        lastCheckedAt: checkedAt,
        dialogOpen: showDialog || value.dialogOpen,
      }));
      toast.info(text("发现新版本", "Update available"), `${result.info.currentVersion} -> ${result.info.version}`);
      void runLogger.log({
        source: "system",
        channel: "tauri",
        level: "info",
        action: "app.update.check",
        result: "success",
        title: text("发现新版本", "Update available"),
        metadata: result.info,
      });
    } catch (error) {
      const message = errorMessage(error, text("更新检查失败", "Update check failed"));
      setState((value) => ({ ...value, status: "error", error: message, dialogOpen: manual ? true : value.dialogOpen }));
      if (manual) toast.error(text("更新检查失败", "Update check failed"), message);
      void runLogger.log({
        source: "system",
        channel: "tauri",
        level: "error",
        action: "app.update.check",
        result: "failure",
        title: text("更新检查失败", "Update check failed"),
        error: message,
      });
    }
  }, [runLogger, text, toast]);

  useEffect(() => {
    if (!browserRuntime.supportsUpdater || isTrayMenuWindow()) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (!getRuntimeSettings().autoCheckUpdates) return;
        const stored = await loadAppUpdateState();
        if (!shouldAutoCheckForUpdates(stored)) return;
        await checkForUpdates(false);
      })();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  const installUpdate = useCallback(async () => {
    // Mobile: download APK from GitHub, then trigger install intent
    if (browserRuntime.isMobile) {
      const apkUrl = state.info?.apkUrl;
      if (!apkUrl) {
        setState((value) => ({ ...value, status: "error", error: text("没有可安装的更新", "No installable update is available") }));
        return;
      }

      setState((value) => ({ ...value, status: "downloading", error: undefined, progress: { loaded: 0, percent: 0 } }));
      try {
        const apkPath = await downloadMobileApk(apkUrl, (progress) => {
          setState((value) => ({ ...value, progress }));
        });
        setState((value) => ({
          ...value,
          status: "readyToRestart",
          apkPath,
          progress: { ...value.progress, percent: 100, loaded: value.progress?.loaded ?? 0 },
        }));
        toast.success(text("APK 已下载", "APK downloaded"), text("点击下方按钮安装", "Tap the button below to install"));
        void runLogger.log({
          source: "system",
          channel: "mobile",
          level: "info",
          action: "app.update.download",
          result: "success",
          title: text("APK 下载完成", "APK download completed"),
          metadata: { ...state.info, apkPath },
        });
      } catch (error) {
        const message = errorMessage(error, text("APK 下载失败", "APK download failed"));
        setState((value) => ({ ...value, status: "error", error: message }));
        toast.error(text("APK 下载失败", "APK download failed"), message);
        void runLogger.log({
          source: "system",
          channel: "mobile",
          level: "error",
          action: "app.update.download",
          result: "failure",
          title: text("APK 下载失败", "APK download failed"),
          error: message,
        });
      }
      return;
    }

    // Desktop: use Tauri updater
    if (!updateHandle) {
      setState((value) => ({ ...value, status: "error", error: text("没有可安装的更新", "No installable update is available") }));
      return;
    }

    setState((value) => ({ ...value, status: "downloading", error: undefined, progress: { loaded: 0, percent: 0 } }));
    try {
      await downloadAndInstallAppUpdate(updateHandle, (progress) => {
        setState((value) => ({ ...value, progress }));
      });
      setState((value) => ({ ...value, status: "readyToRestart", progress: { ...value.progress, percent: 100, loaded: value.progress?.loaded ?? 0 } }));
      toast.success(text("更新已安装", "Update installed"), text("重启 EasyConsole 后生效", "Restart EasyConsole to apply it"));
      void runLogger.log({
        source: "system",
        channel: "tauri",
        level: "info",
        action: "app.update.install",
        result: "success",
        title: text("更新已安装", "Update installed"),
        metadata: state.info,
      });
    } catch (error) {
      const message = errorMessage(error, text("更新安装失败", "Update installation failed"));
      setState((value) => ({ ...value, status: "error", error: message }));
      toast.error(text("更新安装失败", "Update installation failed"), message);
      void runLogger.log({
        source: "system",
        channel: "tauri",
        level: "error",
        action: "app.update.install",
        result: "failure",
        title: text("更新安装失败", "Update installation failed"),
        error: message,
      });
    }
  }, [runLogger, state.info, text, toast, updateHandle]);

  const relaunchAfterUpdate = useCallback(async () => {
    if (browserRuntime.isMobile) {
      if (!state.apkPath) {
        toast.error(text("APK 路径丢失", "APK path is missing"), text("请重新下载", "Please download again"));
        return;
      }
      try {
        await installMobileApk(state.apkPath);
      } catch (error) {
        const message = errorMessage(error, text("无法启动安装器", "Failed to launch installer"));
        toast.error(text("安装失败", "Installation failed"), message);
      }
      return;
    }
    await relaunchAppAfterUpdate();
  }, [state.apkPath, text, toast]);

  const dismissUpdate = useCallback(async () => {
    const info = state.info;
    setState((value) => ({ ...value, dialogOpen: false }));
    if (!info) return;
    const stored = await loadAppUpdateState();
    await saveAppUpdateState({
      ...stored,
      dismissedVersion: info.version,
      dismissedAt: new Date().toISOString(),
    });
  }, [state.info]);

  const value = useMemo<AppUpdateContextValue>(() => ({
    state,
    checkForUpdates,
    installUpdate,
    relaunchAfterUpdate,
    dismissUpdate,
    openUpdateDialog: () => setState((current) => ({ ...current, dialogOpen: true })),
    closeUpdateDialog: () => setState((current) => ({ ...current, dialogOpen: false })),
    openReleasePage: () => browserRuntime.openExternal(APP_UPDATE_RELEASE_URL),
  }), [checkForUpdates, dismissUpdate, installUpdate, relaunchAfterUpdate, state]);

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppUpdate() {
  const context = useContext(AppUpdateContext);
  if (!context) throw new Error("useAppUpdate must be used within AppUpdateProvider");
  return context;
}
