import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, Coins, Server, type LucideIcon } from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { StatusBadge } from "../components/StatusBadge";
import { Button, Panel, TableRegion } from "../components/ui";
import { instanceApi } from "../lib/api";
import { formatCost, formatNumber, formatSecondsDuration, getTaskName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { ConsoleSummary, Task } from "../lib/types";

function StatTile({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-app-muted">{label}</span>
        <Icon className="h-4 w-4 text-app-accent" />
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
    </Panel>
  );
}

function toSummary(raw: unknown): ConsoleSummary {
  return raw && typeof raw === "object" ? (raw as ConsoleSummary) : {};
}

function toTasks(raw: unknown): Task[] {
  if (Array.isArray(raw)) return raw as Task[];
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const value = record.list ?? record.items ?? record.results ?? record.data;
  return Array.isArray(value) ? (value as Task[]) : [];
}

export function DashboardPage() {
  const { locale, text } = useI18n();
  const consoleQuery = useQuery({ queryKey: ["console"], queryFn: instanceApi.console });
  const staticsQuery = useQuery({ queryKey: ["statics"], queryFn: () => instanceApi.statics({}) });

  if (consoleQuery.isLoading) return <LoadingState />;
  if (consoleQuery.isError) return <ErrorState error={consoleQuery.error} />;

  const summary = toSummary(consoleQuery.data);
  const recentTasks = toTasks(staticsQuery.data).slice(0, 8);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label={text("运行中任务", "Running tasks")} value={formatNumber(summary.run_task_count, 0, locale)} icon={Activity} />
        <StatTile label={text("排队中任务", "Queued tasks")} value={formatNumber(summary.pending_task_count, 0, locale)} icon={Server} />
        <StatTile label={text("本周运行时长", "Runtime this week")} value={formatSecondsDuration(summary.run_time?.week, locale)} icon={Clock} />
        <StatTile label={text("本月费用", "Cost this month")} value={formatCost(summary.cost_map?.month, locale)} icon={Coins} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel className="p-4">
          <div className="text-sm text-app-muted">{text("今日运行时长", "Runtime today")}</div>
          <div className="mt-2 text-xl font-semibold">{formatSecondsDuration(summary.run_time?.day, locale)}</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-sm text-app-muted">{text("本月运行时长", "Runtime this month")}</div>
          <div className="mt-2 text-xl font-semibold">{formatSecondsDuration(summary.run_time?.month, locale)}</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-sm text-app-muted">{text("本周费用", "Cost this week")}</div>
          <div className="mt-2 text-xl font-semibold">{formatCost(summary.cost_map?.week, locale)}</div>
        </Panel>
      </div>

      <Panel>
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="text-sm font-semibold">{text("最近任务", "Recent tasks")}</div>
          {staticsQuery.isError ? (
            <Button className="h-8" variant="secondary" onClick={() => staticsQuery.refetch()}>
              {text("重试", "Retry")}
            </Button>
          ) : null}
        </div>
        {staticsQuery.isLoading ? (
          <LoadingState label={text("正在加载任务", "Loading tasks")} />
        ) : staticsQuery.isError ? (
          <ErrorState error={staticsQuery.error} action={<Button variant="secondary" onClick={() => staticsQuery.refetch()}>{text("重试", "Retry")}</Button>} />
        ) : recentTasks.length > 0 ? (
          <TableRegion label={text("最近任务表格", "Recent tasks table")}>
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="px-3 py-2 font-medium" scope="col">{text("名称", "Name")}</th>
                  <th className="px-3 py-2 font-medium" scope="col">{text("状态", "Status")}</th>
                  <th className="px-3 py-2 font-medium" scope="col">{text("资源", "Resources")}</th>
                  <th className="px-3 py-2 font-medium" scope="col">{text("节点", "Node")}</th>
                  <th className="px-3 py-2 font-medium" scope="col">{text("费用", "Cost")}</th>
                </tr>
              </thead>
              <tbody>
                {recentTasks.map((task) => (
                  <tr key={String(task.id)} className="border-t border-app-border">
                    <td className="px-3 py-2 font-medium">{getTaskName(task)}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={task.status} />
                    </td>
                    <td className="px-3 py-2 text-app-muted">
                      {task.cpu ?? "-"}C / {task.gpu ?? "-"}GPU / {task.memory ?? "-"}G
                    </td>
                    <td className="px-3 py-2 text-app-muted">{task.node_name || "-"}</td>
                    <td className="px-3 py-2 text-app-muted">
                      {formatCost(task.cost, locale)} ({formatSecondsDuration(task.use_time, locale)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        ) : (
          <EmptyState title={text("暂无最近任务", "No recent tasks")} />
        )}
      </Panel>
    </div>
  );
}
