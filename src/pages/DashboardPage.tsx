import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, Coins, Server, type LucideIcon } from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { StatusBadge } from "../components/StatusBadge";
import { Panel } from "../components/ui";
import { instanceApi } from "../lib/api";
import { formatCost, formatHours, formatNumber, formatSecondsDuration, getTaskName } from "../lib/format";
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
  const consoleQuery = useQuery({ queryKey: ["console"], queryFn: instanceApi.console });
  const staticsQuery = useQuery({ queryKey: ["statics"], queryFn: () => instanceApi.statics({}) });

  if (consoleQuery.isLoading) return <LoadingState />;
  if (consoleQuery.isError) return <ErrorState error={consoleQuery.error} />;

  const summary = toSummary(consoleQuery.data);
  const recentTasks = toTasks(staticsQuery.data).slice(0, 8);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="运行中任务" value={formatNumber(summary.run_task_count)} icon={Activity} />
        <StatTile label="排队中任务" value={formatNumber(summary.pending_task_count)} icon={Server} />
        <StatTile label="本周运行时长" value={formatSecondsDuration(summary.run_time?.week)} icon={Clock} />
        <StatTile label="本月费用" value={formatCost(summary.cost_map?.month)} icon={Coins} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel className="p-4">
          <div className="text-sm text-app-muted">今日运行时长</div>
          <div className="mt-2 text-xl font-semibold">{formatSecondsDuration(summary.run_time?.day)}</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-sm text-app-muted">本月运行时长</div>
          <div className="mt-2 text-xl font-semibold">{formatSecondsDuration(summary.run_time?.month)}</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-sm text-app-muted">本周费用</div>
          <div className="mt-2 text-xl font-semibold">{formatCost(summary.cost_map?.week)}</div>
        </Panel>
      </div>

      <Panel>
        <div className="border-b border-app-border px-4 py-3 text-sm font-semibold">最近任务</div>
        {staticsQuery.isLoading ? (
          <LoadingState label="正在加载任务" />
        ) : recentTasks.length > 0 ? (
          <div className="overflow-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">资源</th>
                  <th className="px-3 py-2 font-medium">节点</th>
                  <th className="px-3 py-2 font-medium">费用</th>
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
                      {formatCost(task.cost)} ({formatHours(task.use_time)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无最近任务" />
        )}
      </Panel>
    </div>
  );
}
