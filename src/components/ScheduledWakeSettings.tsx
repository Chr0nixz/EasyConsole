import { useEffect, useState } from "react";

import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { Button, SettingTag } from "./ui";

/** OS-global setting. Read actual registration rather than an account snapshot. */
export function ScheduledWakeSettings() {
  const { text } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void browserRuntime.desktopScheduledWake().then((value) => {
      if (!disposed) setEnabled(value);
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { disposed = true; };
  }, []);

  async function toggle(value?: boolean) {
    setPending(true);
    setError(null);
    try {
      const actual = await browserRuntime.desktopScheduledWake(value);
      setEnabled(actual);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  if (enabled === null && !error && !pending) return null;
  return (
    <div className="border-t border-app-border px-4 py-3">
      <label className="flex items-start gap-3 text-sm">
        <input className="mt-1" type="checkbox" checked={enabled === true} disabled={pending || enabled === null}
          onChange={(event) => void toggle(event.target.checked)} aria-describedby="scheduled-wake-help" />
        <span>
          <span className="flex flex-wrap items-center gap-2 font-medium">
            <span>{text("计划到期时自动启动应用", "Start app for due schedules")}</span>
            <SettingTag>{text("实验性", "Experimental")}</SettingTag>
          </span>
          <span id="scheduled-wake-help" className="mt-1 block text-xs leading-5 text-app-muted">
            {text("立即应用到 Windows 计划任务，每分钟检查本机桌面计划。需要已登录系统；应用启动后仍校验账号并遵循错过执行策略。令牌失效时需重新登录。", "Applies immediately to Windows Task Scheduler. Checks desktop schedules every minute while you are signed in. The app still verifies the account and missed-run policy; expired credentials require sign-in.")}
          </span>
          {pending ? <span role="status" className="mt-1 block text-xs text-app-muted">{text("正在更新系统计划…", "Updating OS schedule…")}</span> : null}
        </span>
      </label>
      {error ? <div className="mt-2 flex flex-wrap items-center gap-2">
        <p role="alert" className="text-xs text-app-danger">{error}</p>
        {enabled === null ? <Button variant="secondary" type="button" onClick={() => void toggle()}>{text("重新检查", "Check again")}</Button> : null}
      </div> : null}
    </div>
  );
}
