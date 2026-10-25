import { ShieldAlert, UserRound } from "lucide-react";

import { ANONYMOUS_ACCOUNT_SCOPE_KEY, getActiveAccountScope } from "../../lib/account-scope";
import { LEGACY_SCHEDULED_TASK_OWNER_KEY, scheduledTaskOwnerMismatch } from "../../lib/scheduled-tasks";
import type { ScheduledTask } from "../../lib/types";
import { useI18n } from "../../lib/i18n";

/** Statuses a schedule can still auto-execute from; finished records cannot. */
const AUTO_EXECUTE_STATUSES: ScheduledTask["status"][] = ["pending", "running", "paused", "needs_review"];

/**
 * Workspace summary for the scheduled tasks page: the account the local client
 * currently acts as, plus the schedules whose recorded owner cannot be verified
 * against it and therefore will not auto-execute. Presentation and jump-to-row
 * only — resuming or migrating stays on the task row's existing resume action.
 */
export function WorkspaceAccountBanner({ tasks, onFocusTask }: { tasks: ScheduledTask[]; onFocusTask: (id: string) => void }) {
  const { text } = useI18n();
  const scope = getActiveAccountScope();
  const anonymous = scope.key === ANONYMOUS_ACCOUNT_SCOPE_KEY;
  const held = tasks.filter(
    (task) => AUTO_EXECUTE_STATUSES.includes(task.status) && scheduledTaskOwnerMismatch(task, scope) !== null,
  );

  return (
    <section
      aria-label={text("当前工作区账号", "Current workspace account")}
      className="rounded-lg border border-app-border bg-app-panel/60 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <UserRound className="h-4 w-4 text-app-muted" aria-hidden="true" />
        <span className="text-app-muted">{text("当前工作区账号", "Current workspace account")}</span>
        <span className="font-medium">{anonymous ? text("未登录", "Not signed in") : scope.displayName || scope.key}</span>
        {held.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-app-warningText">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            {anonymous
              ? text(
                  `当前未登录，${held.length} 个定时任务的归属无法确认，已暂停自动执行`,
                  `Not signed in: ownership of ${held.length} scheduled task(s) cannot be verified, so automatic execution is paused`,
                )
              : text(
                  `${held.length} 个定时任务属于其他账号或来源未知，已暂停自动执行`,
                  `${held.length} scheduled task(s) belong to other accounts or have an unknown origin, so automatic execution is paused`,
                )}
          </span>
        ) : null}
      </div>
      {held.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {held.map((task) => {
            const ownerLabel =
              !task.owner || task.owner.key === LEGACY_SCHEDULED_TASK_OWNER_KEY
                ? text("来源未知（旧版本数据）", "Unknown origin (legacy data)")
                : task.owner.displayName;
            return (
              <li key={task.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <button
                  type="button"
                  className="app-interactive rounded font-medium text-app-accent underline-offset-2 hover:underline"
                  onClick={() => onFocusTask(task.id)}
                >
                  {task.name}
                </button>
                <span className="text-app-muted">
                  {text("归属", "Owner")}: {ownerLabel}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
