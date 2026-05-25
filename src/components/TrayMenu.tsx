import { CalendarClock, MonitorUp, Power, X } from "lucide-react";
import { useEffect } from "react";

import { browserRuntime } from "../lib/runtime";
import { useI18n } from "../lib/i18n";
import { cn } from "../lib/utils";

function TrayMenuButton({
  children,
  danger = false,
  icon: Icon,
  onClick,
}: {
  children: string;
  danger?: boolean;
  icon: typeof MonitorUp;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "app-interactive flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium",
        danger
          ? "text-app-danger hover:bg-app-dangerSoft"
          : "text-app-text hover:bg-app-panel",
      )}
      type="button"
      onClick={onClick}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
          danger
            ? "border-app-dangerRing bg-app-dangerSoft text-app-danger"
            : "border-app-border bg-app-surface text-app-accent",
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export function TrayMenu() {
  const { text } = useI18n();

  useEffect(() => {
    const hide = () => void browserRuntime.hideDesktopTrayMenu();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    window.addEventListener("blur", hide);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <main className="min-h-screen bg-app-bg p-2 text-app-text">
      <section className="app-surface-enter overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-shell">
        <div className="flex items-center gap-3 border-b border-app-border px-3 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-app-accent text-app-onAccent">
            <MonitorUp className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">EasyConsole</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-app-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-app-success" />
              <span>{text("后台就绪", "Background ready")}</span>
            </div>
          </div>
          <button
            className="app-interactive flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
            type="button"
            onClick={() => void browserRuntime.hideDesktopTrayMenu()}
            aria-label={text("关闭托盘菜单", "Close tray menu")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1 px-2 py-2">
          <TrayMenuButton icon={MonitorUp} onClick={() => void browserRuntime.showDesktopMainWindow()}>
            {text("显示主窗口", "Show main window")}
          </TrayMenuButton>
          <TrayMenuButton icon={CalendarClock} onClick={() => void browserRuntime.runDueScheduledTasks()}>
            {text("执行到期计划", "Run due schedules")}
          </TrayMenuButton>
        </div>

        <div className="border-t border-app-border px-2 py-2">
          <TrayMenuButton danger icon={Power} onClick={() => void browserRuntime.quitDesktopApp()}>
            {text("退出 EasyConsole", "Quit EasyConsole")}
          </TrayMenuButton>
        </div>
      </section>
    </main>
  );
}
