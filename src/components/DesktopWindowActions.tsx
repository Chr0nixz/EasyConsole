import { Minimize2, Power } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

import { GLOBAL_SETTINGS_ACCOUNT_ID, getRuntimeSettings, saveAccountSettings, setRuntimeSettings } from "../lib/app-settings";
import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { resolveSavedAccountId } from "../lib/saved-accounts";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";
import { Button, Dialog } from "./ui";

/** Native window actions remain available on the sign-in screen. */
export function DesktopWindowActions() {
  const { token, user } = useAuth();
  const { text } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const isMac = browserRuntime.isMacDesktop;
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const openSettings = useEffectEvent(() => {
    void navigate(token ? "/settings" : "/login/settings");
  });

  useEffect(() => {
    let active = true;
    const listeners: Array<() => void> = [];
    function track(subscription: Promise<() => void>) {
      void subscription.then((unlisten) => {
        if (active) listeners.push(unlisten);
        else unlisten();
      }).catch((error: unknown) => console.warn("Could not listen for desktop window actions.", error));
    }

    track(browserRuntime.onDesktopCloseRequested(() => {
      if (active) setOpen(true);
    }));
    if (isMac && browserRuntime.onDesktopOpenSettings) {
      track(browserRuntime.onDesktopOpenSettings(() => {
        if (active) openSettings();
      }));
    }
    return () => {
      active = false;
      listeners.forEach((unlisten) => unlisten());
    };
  }, [isMac]);

  function resetDialog() {
    setOpen(false);
    setRemember(false);
  }

  function keepOpen() {
    if (busy) return;
    resetDialog();
    void browserRuntime.cancelDesktopClosePrompt();
  }

  async function chooseCloseAction(action: "tray" | "exit") {
    setBusy(true);
    try {
      if (remember) {
        const nextSettings = {
          ...getRuntimeSettings(),
          desktopClosePrompt: false,
          desktopCloseToTray: action === "tray",
        };
        const accountId = user
          ? resolveSavedAccountId(user.username ?? user.name ?? "", user)
          : GLOBAL_SETTINGS_ACCOUNT_ID;
        await saveAccountSettings(browserRuntime.storage, accountId, nextSettings);
        setRuntimeSettings(nextSettings);
        await browserRuntime.setDesktopCloseToTray(nextSettings.desktopCloseToTray);
        await browserRuntime.setDesktopClosePrompt(false);
      }
      await browserRuntime.completeDesktopClosePrompt(action);
      resetDialog();
    } catch (error) {
      toast.error(text("无法完成关闭操作", "Could not complete the close action"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title={text("关闭 EasyConsole", "Close EasyConsole")} onClose={keepOpen} width="max-w-md" closeOnOverlayClick={false}>
      <div className="space-y-4 p-4">
        <p className="text-sm leading-6 text-app-muted">
          {isMac
            ? text(
                "要退出应用，还是隐藏窗口继续在后台执行计划任务？之后可从程序坞或菜单栏图标重新打开。",
                "Quit the app, or hide the window so background scheduled tasks can continue? Reopen it from the Dock or the menu bar icon.",
              )
            : text(
                "要彻底退出应用，还是最小化到托盘继续执行后台计划任务？",
                "Exit the app completely, or minimize to tray so background scheduled tasks can continue?",
              )}
        </p>
        <label className="flex items-center gap-2 text-sm text-app-muted">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
          {text("不再提示，记住本次选择", "Do not ask again, remember this choice")}
        </label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" disabled={busy} onClick={keepOpen}>
            {text("继续使用", "Keep open")}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void chooseCloseAction("tray")}>
            <Minimize2 className="h-4 w-4" />
            {isMac ? text("隐藏窗口", "Hide window") : text("最小化到托盘", "Minimize to tray")}
          </Button>
          {/* Quitting destroys nothing, so it takes no danger fill; that one is kept for release and delete. */}
          <Button type="button" disabled={busy} onClick={() => void chooseCloseAction("exit")}>
            <Power className="h-4 w-4" />
            {isMac ? text("退出", "Quit") : text("彻底退出", "Exit")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
