import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, Coins, RefreshCw, Server, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { StatusBadge } from "../components/StatusBadge";
import { Button, Panel, Select, TableRegion } from "../components/ui";
import { instanceApi } from "../lib/api";
import { formatCost, formatNumber, formatSecondsDuration, getTaskName, getTaskNodeName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import type { ConsoleSummary, Task } from "../lib/types";

type TimeRange = "day" | "week" | "month";

const TIME_RANGES: TimeRange[] = ["day", "week", "month"];
const AUTO_REFRESH_OPTIONS = [
  { zh: "关闭", en: "Off", value: 0 },
  { zh: "30 秒", en: "30 sec", value: 30_000 },
  { zh: "1 分钟", en: "1 min", value: 60_000 },
  { zh: "5 分钟", en: "5 min", value: 300_000 },
];

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

function rangeLabel(range: TimeRange, text: (zh: string, en: string) => string) {
  if (range === "day") return text("今日", "Today");
  if (range === "week") return text("本周", "This week");
  return text("本月", "This month");
}

export function DashboardPage() {
  const { locale, text } = useI18n();
  const [timeRange, setTimeRange] = useState<TimeRange>("week");
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);

  const refetchInterval = autoRefreshMs > 0 ? autoRefreshMs : false;
  const consoleQuery = useQuery({ queryKey: ["console"], queryFn: instanceApi.console, refetchInterval });
  const staticsQuery = useQuery({ queryKey: ["statics"], queryFn: () => instanceApi.statics({}), refetchInterval });

  const summary = toSummary(consoleQuery.data);
  const recentTasks = toTasks(staticsQuery.data).slice(0, 8);

  const runtimeValue = summary.run_time?.[timeRange];
  const costValue = summary.cost_map?.[timeRange];

  const chartData = TIME_RANGES.map((range) => ({
    range,
    label: rangeLabel(range, text),
    runtime: Number(summary.run_time?.[range] ?? 0),
    cost: Number(summary.cost_map?.[range] ?? 0),
  }));

  const selectedRangeIndex = TIME_RANGES.indexOf(timeRange);
  const runtimeSummary = text(
    `运行时长对比：共 ${chartData.length} 个时间范围，当前选中 ${rangeLabel(timeRange, text)}，值为 ${formatSecondsDuration(runtimeValue, locale)}。极值约 ${formatSecondsDuration(Math.max(...chartData.map((d) => d.runtime), 0), locale)}。`,
    `Runtime comparison: ${chartData.length} ranges; selected ${rangeLabel(timeRange, text)} is ${formatSecondsDuration(runtimeValue, locale)}. Peak about ${formatSecondsDuration(Math.max(...chartData.map((d) => d.runtime), 0), locale)}.`,
  );
  const costSummary = text(
    `费用对比：共 ${chartData.length} 个时间范围，当前选中 ${rangeLabel(timeRange, text)}，值为 ${formatCost(costValue, locale)}。极值约 ${formatCost(Math.max(...chartData.map((d) => d.cost), 0), locale)}。`,
    `Cost comparison: ${chartData.length} ranges; selected ${rangeLabel(timeRange, text)} is ${formatCost(costValue, locale)}. Peak about ${formatCost(Math.max(...chartData.map((d) => d.cost), 0), locale)}.`,
  );

  if (consoleQuery.isLoading) return <LoadingState />;
  if (consoleQuery.isError) return <ErrorState error={consoleQuery.error} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-1 rounded-md border border-app-border bg-app-surface p-0.5"
          role="group"
          aria-label={text("时间范围", "Time range")}
        >
          {TIME_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={timeRange === range}
              onClick={() => setTimeRange(range)}
              className={[
                "app-interactive rounded px-3 py-1 text-xs font-medium",
                timeRange === range ? "bg-app-accent text-white" : "text-app-muted hover:text-app-text",
              ].join(" ")}
            >
              {rangeLabel(range, text)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label={text("自动刷新", "Auto refresh")}
            value={String(autoRefreshMs)}
            onChange={(event) => setAutoRefreshMs(Number(event.target.value))}
            className="h-8 text-xs"
          >
            {AUTO_REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={String(option.value)}>
                {locale === "en-US" ? option.en : option.zh}
              </option>
            ))}
          </Select>
          <Button
            className="h-8"
            variant="secondary"
            onClick={() => {
              void consoleQuery.refetch();
              void staticsQuery.refetch();
            }}
          >
            <RefreshCw className={consoleQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {text("刷新", "Refresh")}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label={text("运行中任务", "Running tasks")} value={formatNumber(summary.run_task_count, 0, locale)} icon={Activity} />
        <StatTile label={text("排队中任务", "Queued tasks")} value={formatNumber(summary.pending_task_count, 0, locale)} icon={Server} />
        <StatTile label={text("运行时长", "Runtime")} value={formatSecondsDuration(runtimeValue, locale)} icon={Clock} />
        <StatTile label={text("费用", "Cost")} value={formatCost(costValue, locale)} icon={Coins} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="p-4">
          <div className="mb-3 text-sm font-semibold text-app-text">{text("运行时长对比", "Runtime comparison")}</div>
          <div className="h-48" role="img" aria-label={runtimeSummary}>
            <span className="sr-only">{runtimeSummary}</span>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="currentColor" className="text-app-muted" />
                <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-app-muted" width={48} tickFormatter={(value) => formatSecondsDuration(Number(value), locale)} />
                <Tooltip
                  cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
                  contentStyle={{ background: "var(--color-app-surface)", border: "1px solid var(--color-app-border)", borderRadius: 6, fontSize: 12 }}
                  formatter={(value: number) => [formatSecondsDuration(value, locale), text("时长", "Runtime")]}
                />
                <Bar dataKey="runtime" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={entry.range} fill={index === selectedRangeIndex ? "var(--color-app-accent)" : "var(--color-app-muted)"} fillOpacity={index === selectedRangeIndex ? 1 : 0.4} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-sm font-semibold text-app-text">{text("费用对比", "Cost comparison")}</div>
          <div className="h-48" role="img" aria-label={costSummary}>
            <span className="sr-only">{costSummary}</span>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="currentColor" className="text-app-muted" />
                <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-app-muted" width={48} tickFormatter={(value) => formatCost(Number(value), locale)} />
                <Tooltip
                  cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
                  contentStyle={{ background: "var(--color-app-surface)", border: "1px solid var(--color-app-border)", borderRadius: 6, fontSize: 12 }}
                  formatter={(value: number) => [formatCost(value, locale), text("费用", "Cost")]}
                />
                <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={entry.range} fill={index === selectedRangeIndex ? "var(--color-app-accent)" : "var(--color-app-muted)"} fillOpacity={index === selectedRangeIndex ? 1 : 0.4} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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
          browserRuntime.isMobile ? (
            <div className="divide-y divide-app-border">
              {recentTasks.map((task) => (
                <article key={String(task.id)} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to={`/tasks/${task.id}`}
                      className="truncate font-medium text-app-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
                      aria-label={text(`查看实例 ${getTaskName(task)} 详情`, `View details for ${getTaskName(task)}`)}
                    >
                      {getTaskName(task)}
                    </Link>
                    <StatusBadge status={task.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div>
                      <dt className="text-app-muted">{text("资源", "Resources")}</dt>
                      <dd>{task.cpu ?? "-"}C / {task.gpu ?? "-"}GPU / {task.memory ?? "-"}G</dd>
                    </div>
                    <div>
                      <dt className="text-app-muted">{text("节点", "Node")}</dt>
                      <dd>{getTaskNodeName(task) || "-"}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-app-muted">{text("费用", "Cost")}</dt>
                      <dd>{formatCost(task.cost, locale)} ({formatSecondsDuration(task.use_time, locale)})</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
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
                      <td className="px-3 py-2 font-medium">
                        <Link
                          to={`/tasks/${task.id}`}
                          className="text-app-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
                          aria-label={text(`查看实例 ${getTaskName(task)} 详情`, `View details for ${getTaskName(task)}`)}
                        >
                          {getTaskName(task)}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={task.status} />
                      </td>
                      <td className="px-3 py-2 text-app-muted">
                        {task.cpu ?? "-"}C / {task.gpu ?? "-"}GPU / {task.memory ?? "-"}G
                      </td>
                      <td className="px-3 py-2 text-app-muted">{getTaskNodeName(task) || "-"}</td>
                      <td className="px-3 py-2 text-app-muted">
                        {formatCost(task.cost, locale)} ({formatSecondsDuration(task.use_time, locale)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          )
        ) : (
          <EmptyState title={text("暂无最近任务", "No recent tasks")} />
        )}
      </Panel>
    </div>
  );
}
