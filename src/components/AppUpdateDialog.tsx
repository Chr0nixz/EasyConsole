import { Download, ExternalLink, Minimize2, RefreshCw, RotateCw, Smartphone } from "lucide-react";

import { useAppUpdate } from "../lib/app-update-context";
import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { Button, Dialog } from "./ui";

function formatBytes(value?: number) {
  if (!value) return "";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function AppUpdateDialog() {
  const {
    state,
    checkForUpdates,
    installUpdate,
    relaunchAfterUpdate,
    dismissUpdate,
    ignoreUpdateVersion,
    closeUpdateDialog,
    openReleasePage,
  } = useAppUpdate();
  const { text } = useI18n();
  const title = state.info
    ? text(`发现新版本 ${state.info.version}`, `Update ${state.info.version} available`)
    : text("应用更新", "App Update");
  const busy = state.status === "checking" || state.status === "downloading";
  const isMobile = browserRuntime.isMobile;
  const downloading = state.status === "downloading";

  return (
    <Dialog
      open={state.dialogOpen}
      title={title}
      onClose={closeUpdateDialog}
      closeOnOverlayClick
      width="max-w-2xl"
    >
      <div className="space-y-4 p-4 text-sm">
        <div className="rounded-md border border-app-border bg-app-panel p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs text-app-muted">{text("当前版本", "Current version")}</div>
              <div className="mt-1 font-mono text-app-text">{state.info?.currentVersion ?? state.currentVersion ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs text-app-muted">{text("最新版本", "Latest version")}</div>
              <div className="mt-1 font-mono text-app-text">{state.info?.version ?? (state.status === "upToDate" ? state.currentVersion : "-")}</div>
            </div>
          </div>
          {state.lastCheckedAt ? (
            <div className="mt-3 text-xs text-app-muted">
              {text("上次检查", "Last checked")} {new Date(state.lastCheckedAt).toLocaleString()}
            </div>
          ) : null}
        </div>

        {state.status === "checking" ? (
          <div className="rounded-md bg-app-infoSoft px-3 py-2 text-app-accent">
            {text("正在检查更新…", "Checking for updates…")}
          </div>
        ) : null}

        {state.status === "unsupported" ? (
          <div className="rounded-md bg-app-warningSoft px-3 py-2 text-app-warning">
            {text("当前运行环境不支持自动更新。", "This runtime does not support automatic updates.")}
          </div>
        ) : null}

        {state.status === "upToDate" ? (
          <div className="rounded-md bg-app-successSoft px-3 py-2 text-app-success">
            {text("当前已经是最新稳定版本。", "You are already on the latest stable version.")}
          </div>
        ) : null}

        {state.status === "readyToRestart" ? (
          <div className="rounded-md bg-app-successSoft px-3 py-2 text-app-success">
            {isMobile
              ? text("APK 已下载，将打开系统安装器完成安装。", "APK downloaded. The system installer will finish the install.")
              : text("更新已就绪，重启后生效。", "Update is ready. Restart to apply it.")}
          </div>
        ) : null}

        {state.error ? (
          <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-app-danger">{state.error}</div>
        ) : null}

        {state.info?.body && !downloading ? (
          <div>
            <div className="mb-2 text-xs font-medium text-app-muted">{text("版本说明", "Release notes")}</div>
            <pre className="max-h-60 whitespace-pre-wrap rounded-md border border-app-border bg-app-panel p-3 text-xs leading-5 text-app-text">
              {state.info.body}
            </pre>
          </div>
        ) : null}

        {downloading ? (
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-app-muted">
              <span>{isMobile ? text("正在下载 APK", "Downloading APK") : text("正在下载并安装更新", "Downloading and installing update")}</span>
              <span>{state.progress?.percent ?? 0}% {formatBytes(state.progress?.loaded)}{state.progress?.total ? ` / ${formatBytes(state.progress.total)}` : ""}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-app-border">
              <div className="h-full bg-app-accent transition-all" style={{ width: `${state.progress?.percent ?? 0}%` }} />
            </div>
            <p className="mt-2 text-xs text-app-muted">
              {text("可关闭此窗口，下载会在后台继续；进度可在顶部状态栏查看。", "You can close this window — the download continues in the background. Check progress in the status bar.")}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {downloading ? (
              <Button type="button" variant="secondary" onClick={closeUpdateDialog}>
                <Minimize2 className="h-4 w-4" />
                {text("后台继续", "Continue in background")}
              </Button>
            ) : state.status === "readyToRestart" ? (
              <>
                <Button type="button" variant="secondary" onClick={closeUpdateDialog}>
                  {text("稍后重启", "Restart later")}
                </Button>
                {isMobile ? (
                  <Button type="button" onClick={() => void relaunchAfterUpdate()}>
                    <Smartphone className="h-4 w-4" />
                    {text("安装 APK", "Install APK")}
                  </Button>
                ) : (
                  <Button type="button" onClick={() => void relaunchAfterUpdate()}>
                    <RotateCw className="h-4 w-4" />
                    {text("重启并完成更新", "Restart to finish")}
                  </Button>
                )}
              </>
            ) : (
              <>
                {state.status === "available" || state.status === "error" || state.status === "idle" || state.status === "upToDate" || state.status === "checking" ? (
                  <Button disabled={busy} type="button" variant="secondary" onClick={() => void dismissUpdate()}>
                    {text("稍后", "Later")}
                  </Button>
                ) : null}
                <Button disabled={busy} type="button" variant="secondary" onClick={openReleasePage}>
                  <ExternalLink className="h-4 w-4" />
                  GitHub Release
                </Button>
                {state.status === "available" ? (
                  <Button disabled={busy} type="button" onClick={() => void installUpdate()}>
                    <Download className="h-4 w-4" />
                    {isMobile ? text("下载 APK", "Download APK") : text("下载并安装", "Download and install")}
                  </Button>
                ) : state.status === "error" ? (
                  <Button disabled={busy} type="button" onClick={() => void checkForUpdates(true)}>
                    <RefreshCw className="h-4 w-4" />
                    {text("重试", "Retry")}
                  </Button>
                ) : (
                  <Button disabled={busy || state.status === "unsupported"} type="button" onClick={() => void checkForUpdates(true)}>
                    <RefreshCw className="h-4 w-4" />
                    {state.status === "checking" ? text("检查中", "Checking") : text("检查更新", "Check for updates")}
                  </Button>
                )}
              </>
            )}
          </div>

          {state.status === "available" && state.info ? (
            <div className="flex justify-end">
              <button
                type="button"
                className="app-interactive text-xs text-app-muted underline-offset-2 hover:text-app-text hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => void ignoreUpdateVersion()}
              >
                {text("忽略此版本", "Skip this version")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
