import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { StatusBadge } from "../components/StatusBadge";
import { Button, Panel, SegmentedControl, Select, TableRegion } from "../components/ui";
import { instanceApi } from "../lib/api";
import { formatCost, formatHours, formatNumber, formatRelativeUpdatedAt, formatSecondsDuration, getTaskName, getTaskNodeName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { Locale } from "../lib/i18n-text";
import { useCompactLayout } from "../lib/use-compact-layout";
import { browserRuntime } from "../lib/runtime";
import { cn } from "../lib/utils";
import { DEFAULT_TASK_PAGE, DEFAULT_TASK_PAGE_SIZE, serializeTaskListQuery, taskTimestamp } from "../lib/task-list-query";
import type { ConsoleSummary, Task } from "../lib/types";

type TimeRange = "day" | "week" | "month";
type ChartMetric = "runtime" | "cost";

const TIME_RANGES: TimeRange[] = ["day", "week", "month"];
const AUTO_REFRESH_STORAGE_KEY = "easy-console.dashboard.autoRefreshMs";
// A dashboard left open is a monitor, so it refreshes by default; the choice is remembered.
const DEFAULT_AUTO_REFRESH_MS = 60_000;
const AUTO_REFRESH_OPTIONS = [
  { zh: "关闭", en: "Off", value: 0 },
  { zh: "30 秒", en: "30 sec", value: 30_000 },
  { zh: "1 分钟", en: "1 min", value: 60_000 },
  { zh: "5 分钟", en: "5 min", value: 300_000 },
];

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

function tasksHref(status: string) {
  const params = serializeTaskListQuery({
    page: DEFAULT_TASK_PAGE,
    pageSize: DEFAULT_TASK_PAGE_SIZE,
    keyword: "",
    status,
    sortBy: "",
    sortDir: "desc",
  });
  const query = params.toString();
  return query ? `/tasks?${query}` : "/tasks";
}

// Segments are omitted rather than placeholdered: "-" or "0 分钟" in a triage line reads as a measurement.
function taskMetaLine(task: Task, now: number, locale: Locale, text: (zh: string, en: string) => string) {
  const segments: string[] = [];
  const hours = Number(task.use_time);
  if (Number.isFinite(hours) && hours >= 1 / 60) {
    segments.push(
      text(`时长 ${formatHours(hours, locale)}`, `Duration ${formatHours(hours, locale)}`),
    );
  }
  const updatedAt = taskTimestamp(task, "updated");
  if (updatedAt > 0 && now > 0) {
    segments.push(
      text(
        `更新于 ${formatRelativeUpdatedAt(updatedAt, now, locale)}`,
        `updated ${formatRelativeUpdatedAt(updatedAt, now, locale)}`,
      ),
    );
  }
  const cost = Number(task.cost);
  if (Number.isFinite(cost) && cost > 0) {
    segments.push(text(`费用 ${formatCost(cost, locale)}`, `cost ${formatCost(cost, locale)}`));
  }
  return segments.length > 0 ? segments.join(" · ") : "";
}

function byRecency(tasks: Task[]) {
  return [...tasks].sort((left, right) => taskTimestamp(right, "updated") - taskTimestamp(left, "updated"));
}

function AttentionGroup({
  title,
  href,
  tasks,
  emptyLabel,
  now,
  links,
}: {
  title: string;
  href: string;
  tasks: Task[];
  emptyLabel: string;
  now: number;
  links?: Array<{ label: string; href: string }>;
}) {
  const { locale, text } = useI18n();
  return (
    <section className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-app-text">
          {links ? title : <Link
            to={href}
            className="text-app-text hover:underline"
          >
            {title}
          </Link>}
          <span className="ml-2 text-xs font-normal text-app-muted">{tasks.length}</span>
        </h2>
        {/* On touch screens the links keep a ~40px hit area via padding that negative margins cancel out of the layout. */}
        <div className="flex shrink-0 gap-3">
          {(links ?? [{ label: text("查看全部", "View all"), href }]).map((link) => (
            <Link
              key={link.href}
              to={link.href}
              className="text-xs text-app-accent hover:underline [@media(pointer:coarse)]:-my-3 [@media(pointer:coarse)]:min-h-0 [@media(pointer:coarse)]:py-3"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
      {tasks.length === 0 ? (
        <p className="mt-2.5 rounded-lg border border-dashed border-app-border px-3 py-6 text-center text-sm text-app-muted">{emptyLabel}</p>
      ) : (
        <ul className="mt-2.5 divide-y divide-app-border overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-shell">
          {tasks.slice(0, 8).map((task) => {
            const meta = taskMetaLine(task, now, locale, text);
            return (
              <li key={String(task.id)} className="px-3 py-2.5 transition-colors duration-150 hover:bg-app-panel/60">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    to={`/tasks/${task.id}`}
                    className="min-w-0 truncate text-sm font-medium text-app-accent hover:underline [@media(pointer:coarse)]:leading-[44px]"
                    aria-label={text(`查看实例 ${getTaskName(task)} 详情`, `View details for ${getTaskName(task)}`)}
                  >
                    {getTaskName(task)}
                  </Link>
                  <StatusBadge status={task.status} />
                </div>
                {meta ? <p className="mt-0.5 truncate text-xs text-app-muted">{meta}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The status line stays a sentence, not a stat-card row. Figures update in place; the
// one live pulse in the product sits here, on the running count, and nowhere else.
function SummaryLine({ running, queued, runtime, cost, rangeName }: { running: number; queued: number; runtime: number; cost: number; rangeName: string }) {
  const { locale, text } = useI18n();
  const segments = [
    { key: "running", label: text("运行中", "Running"), value: formatNumber(running, 0, locale), live: running > 0 },
    { key: "queued", label: text("排队", "Queued"), value: formatNumber(queued, 0, locale), live: false },
    { key: "runtime", label: text(`${rangeName}时长`, rangeName), value: formatSecondsDuration(runtime, locale), live: false },
    { key: "cost", label: text("费用", "Cost"), value: formatCost(cost, locale), live: false },
  ];

  return (
    <p className="min-w-0 text-sm text-app-text">
      <span className="sr-only">
        {text(
          `运行中 ${formatNumber(running, 0, locale)} · 排队 ${formatNumber(queued, 0, locale)} · ${rangeName}时长 ${formatSecondsDuration(runtime, locale)} · 费用 ${formatCost(cost, locale)}`,
          `Running ${formatNumber(running, 0, locale)} · queued ${formatNumber(queued, 0, locale)} · ${rangeName} ${formatSecondsDuration(runtime, locale)} · cost ${formatCost(cost, locale)}`,
        )}
      </span>
      {/* Two columns on phones (no rules to strand at a wrap), one ruled sentence from sm up. */}
      <span aria-hidden="true" className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-0">
        {segments.map((segment, index) => (
          <span key={segment.key} className={cn("inline-flex items-baseline gap-2 sm:pr-4", index > 0 && "sm:border-l sm:border-app-border sm:pl-4")}>
            {segment.live ? <span className="app-live-dot h-1.5 w-1.5 shrink-0 self-center rounded-full bg-app-info text-app-info" /> : null}
            <span className="text-app-muted">{segment.label}</span>
            <span className="app-numeric text-[0.9375rem] font-semibold tracking-[-0.01em]">{segment.value}</span>
          </span>
        ))}
      </span>
    </p>
  );
}

// Loading keeps the page's own shape, so content lands where the placeholders were.
function AttentionColumnsSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 3 }, (_, column) => (
        <div key={column} className="min-w-0">
          <div className="h-4 w-24 animate-pulse rounded bg-app-neutralSoft" />
          <div className="mt-2.5 divide-y divide-app-border overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-shell">
            {Array.from({ length: 3 }, (_, row) => (
              <div key={row} className="space-y-2 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="h-3.5 w-2/5 animate-pulse rounded bg-app-neutralSoft" />
                  <div className="h-5 w-14 animate-pulse rounded-full bg-app-neutralSoft" />
                </div>
                <div className="h-3 w-3/5 animate-pulse rounded bg-app-neutralSoft" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-3" aria-hidden="true">
        <div className="h-5 w-80 max-w-full animate-pulse rounded bg-app-neutralSoft" />
        <div className="h-8 w-72 max-w-full animate-pulse rounded-md bg-app-neutralSoft" />
      </div>
      <AttentionColumnsSkeleton />
      <div className="h-64 animate-pulse rounded-lg border border-app-border bg-app-surface shadow-shell" aria-hidden="true" />
    </div>
  );
}

export function DashboardPage() {
  const { locale, t, text } = useI18n();
  const compactLayout = useCompactLayout();
  const [timeRange, setTimeRange] = useState<TimeRange>("week");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("runtime");
  const [autoRefreshMs, setAutoRefreshMs] = useState(DEFAULT_AUTO_REFRESH_MS);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void browserRuntime.storage.get(AUTO_REFRESH_STORAGE_KEY).then((stored) => {
      const value = Number(stored);
      if (!cancelled && stored !== null && AUTO_REFRESH_OPTIONS.some((option) => option.value === value)) setAutoRefreshMs(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const changeAutoRefresh = (value: number) => {
    setAutoRefreshMs(value);
    void browserRuntime.storage.set(AUTO_REFRESH_STORAGE_KEY, String(value));
  };

  const refetchInterval = autoRefreshMs > 0 ? autoRefreshMs : false;
  const consoleQuery = useQuery({ queryKey: ["console"], queryFn: instanceApi.console, refetchInterval });
  const staticsQuery = useQuery({ queryKey: ["statics"], queryFn: () => instanceApi.statics({}), refetchInterval });

  const summary = toSummary(consoleQuery.data);
  const allTasks = toTasks(staticsQuery.data);
  const tasksFetchedAt = staticsQuery.dataUpdatedAt;
  // The older of the two reads: the line is only as fresh as its stalest half.
  const lastFetchedAt = consoleQuery.dataUpdatedAt && staticsQuery.dataUpdatedAt
    ? Math.min(consoleQuery.dataUpdatedAt, staticsQuery.dataUpdatedAt)
    : consoleQuery.dataUpdatedAt || staticsQuery.dataUpdatedAt;
  const taskDataAvailable = staticsQuery.data !== undefined;
  const recentTasks = allTasks.slice(0, 8);
  const failedTasks = byRecency(allTasks.filter((task) => Number(task.status) === 7 || Number(task.status) === 8));
  const runningTasks = byRecency(allTasks.filter((task) => Number(task.status) === 2));
  const queuedTasks = byRecency(allTasks.filter((task) => Number(task.status) === 1));

  const runtimeValue = Number(summary.run_time?.[timeRange] ?? 0);
  const costValue = Number(summary.cost_map?.[timeRange] ?? 0);

  const chartData = TIME_RANGES.map((range) => ({
    range,
    label: rangeLabel(range, text),
    runtime: Number(summary.run_time?.[range] ?? 0),
    cost: Number(summary.cost_map?.[range] ?? 0),
  }));

  const selectedRangeIndex = TIME_RANGES.indexOf(timeRange);
  const maxRuntime = Math.max(...chartData.map((entry) => entry.runtime), 0);
  const runtimeAxisDivisor = maxRuntime >= 86_400 ? 86_400 : maxRuntime >= 3_600 ? 3_600 : 60;
  const runtimeAxisUnit = maxRuntime >= 86_400 ? text("天", "d") : maxRuntime >= 3_600 ? text("时", "h") : text("分", "min");
  const axisNumber = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" });
  const chartSummary =
    chartMetric === "runtime"
      ? text(
          `运行时长对比：共 ${chartData.length} 个时间范围，当前选中 ${rangeLabel(timeRange, text)}，值为 ${formatSecondsDuration(runtimeValue, locale)}。极值约 ${formatSecondsDuration(Math.max(...chartData.map((d) => d.runtime), 0), locale)}。`,
          `Runtime comparison: ${chartData.length} ranges; selected ${rangeLabel(timeRange, text)} is ${formatSecondsDuration(runtimeValue, locale)}. Peak about ${formatSecondsDuration(Math.max(...chartData.map((d) => d.runtime), 0), locale)}.`,
        )
      : text(
          `费用对比：共 ${chartData.length} 个时间范围，当前选中 ${rangeLabel(timeRange, text)}，值为 ${formatCost(costValue, locale)}。极值约 ${formatCost(Math.max(...chartData.map((d) => d.cost), 0), locale)}。`,
          `Cost comparison: ${chartData.length} ranges; selected ${rangeLabel(timeRange, text)} is ${formatCost(costValue, locale)}. Peak about ${formatCost(Math.max(...chartData.map((d) => d.cost), 0), locale)}.`,
        );

  if (consoleQuery.isLoading) return <DashboardSkeleton label={t("common.loading")} />;
  if (consoleQuery.isError) return <ErrorState error={consoleQuery.error} action={<Button variant="secondary" onClick={() => consoleQuery.refetch()}>{text("重试", "Retry")}</Button>} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SummaryLine
          running={Number(summary.run_task_count ?? 0)}
          queued={Number(summary.pending_task_count ?? 0)}
          runtime={runtimeValue}
          cost={costValue}
          rangeName={rangeLabel(timeRange, text)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label={text("时间范围", "Time range")}
            value={timeRange}
            options={TIME_RANGES.map((range) => ({ value: range, label: rangeLabel(range, text) }))}
            optionClassName="px-3"
            onChange={setTimeRange}
          />
          {/* Refresh controls wrap as one unit so the button never strands on its own row. */}
          <div className="flex items-center gap-2">
            {lastFetchedAt > 0 ? (
              <span className="whitespace-nowrap text-xs text-app-muted" title={new Date(lastFetchedAt).toLocaleString(locale)}>
                {consoleQuery.isFetching || staticsQuery.isFetching
                  ? text("刷新中…", "Refreshing…")
                  : text(`更新于 ${formatRelativeUpdatedAt(lastFetchedAt, Math.max(nowMs, lastFetchedAt), locale)}`, `Updated ${formatRelativeUpdatedAt(lastFetchedAt, Math.max(nowMs, lastFetchedAt), locale)}`)}
              </span>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-app-muted">
              <span className="whitespace-nowrap">{text("自动刷新", "Auto refresh")}</span>
              <Select
                value={String(autoRefreshMs)}
                onChange={(event) => changeAutoRefresh(Number(event.target.value))}
                className="h-8 text-xs"
              >
                {AUTO_REFRESH_OPTIONS.map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {locale === "en-US" ? option.en : option.zh}
                  </option>
                ))}
              </Select>
            </label>
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
      </div>

      {staticsQuery.isError && taskDataAvailable ? (
        <p className="rounded-md bg-app-warningSoft px-3 py-2 text-sm text-app-warningText" role="alert">
          {text("实例状态刷新失败，以下为上次成功读取的数据，状态可能已变化。", "Instance status could not be refreshed. The last successful data is shown below and may be out of date.")}
        </p>
      ) : null}
      {!taskDataAvailable ? (
        staticsQuery.isError
          ? <ErrorState error={staticsQuery.error} action={<Button variant="secondary" onClick={() => staticsQuery.refetch()}>{text("重试", "Retry")}</Button>} />
          : (
            <div role="status" aria-live="polite" aria-busy="true" aria-label={text("正在读取实例状态", "Loading instance status")}>
              <AttentionColumnsSkeleton />
            </div>
          )
      ) : <div className="grid gap-5 lg:grid-cols-3">
        <AttentionGroup
          title={text("失败 / 异常", "Failed / exception")}
          href={tasksHref("7")}
          links={[
            { label: text("查看失败", "View failed"), href: tasksHref("7") },
            { label: text("查看异常", "View exceptions"), href: tasksHref("8") },
          ]}
          tasks={failedTasks}
          emptyLabel={text("没有失败或异常实例", "No failed or exception instances")}
          now={tasksFetchedAt}
        />
        <AttentionGroup
          title={text("运行中", "Running")}
          href={tasksHref("2")}
          tasks={runningTasks}
          emptyLabel={text("没有运行中的实例", "No running instances")}
          now={tasksFetchedAt}
        />
        <AttentionGroup
          title={text("排队中", "Queued")}
          href={tasksHref("1")}
          tasks={queuedTasks}
          emptyLabel={text("没有排队中的实例", "No queued instances")}
          now={tasksFetchedAt}
        />
      </div>}

      <Panel className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-app-text">
            {chartMetric === "runtime" ? text("运行时长对比", "Runtime comparison") : text("费用对比", "Cost comparison")}
          </div>
          <SegmentedControl<ChartMetric>
            label={text("对比指标", "Comparison metric")}
            value={chartMetric}
            options={[
              { value: "runtime", label: text("时长", "Runtime") },
              { value: "cost", label: text("费用", "Cost") },
            ]}
            optionClassName="px-3"
            onChange={setChartMetric}
          />
        </div>
        <div className="h-48" role="img" aria-label={chartSummary}>
          <span className="sr-only">{chartSummary}</span>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="currentColor" className="text-app-muted" />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                className="text-app-muted"
                width={64}
                tickCount={4}
                minTickGap={8}
                tickFormatter={(value) =>
                  chartMetric === "runtime"
                    ? `${axisNumber.format(Number(value) / runtimeAxisDivisor)}${runtimeAxisUnit}`
                    : axisNumber.format(Number(value))
                }
              />
              <Tooltip
                cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
                contentStyle={{ background: "var(--color-app-elevated)", border: "1px solid var(--color-app-border)", borderRadius: 8, boxShadow: "var(--app-shadow-popover)", color: "var(--color-app-text)", fontSize: 12 }}
                formatter={(value: number) =>
                  chartMetric === "runtime"
                    ? [formatSecondsDuration(value, locale), text("时长", "Runtime")]
                    : [formatCost(value, locale), text("费用", "Cost")]
                }
              />
              <Bar dataKey={chartMetric} radius={[6, 6, 0, 0]} maxBarSize={88} animationDuration={240} animationEasing="ease-out">
                {chartData.map((entry, index) => (
                  <Cell key={entry.range} fill={index === selectedRangeIndex ? "var(--color-app-accent)" : "var(--color-app-muted)"} fillOpacity={index === selectedRangeIndex ? 1 : 0.28} style={{ transition: "fill-opacity 180ms ease-out" }} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {taskDataAvailable ? <Panel>
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
          compactLayout ? (
            <div className="divide-y divide-app-border">
              {recentTasks.map((task) => (
                <article key={String(task.id)} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to={`/tasks/${task.id}`}
                      className="truncate font-medium text-app-accent hover:underline"
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
                      <dd>{formatCost(task.cost, locale)} ({formatHours(task.use_time, locale)})</dd>
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
                          className="text-app-accent hover:underline"
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
                        {formatCost(task.cost, locale)} ({formatHours(task.use_time, locale)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          )
        ) : (
          <EmptyState
            title={text("暂无最近任务", "No recent tasks")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  to="/tasks"
                  className="app-interactive inline-flex h-9 items-center rounded-md border border-app-borderStrong bg-app-surface px-3 text-sm font-medium text-app-text shadow-raised hover:border-app-muted hover:bg-app-panel"
                >
                  {text("去任务实例", "Go to tasks")}
                </Link>
                <Link
                  to="/tasks"
                  className="app-interactive inline-flex h-9 items-center rounded-md bg-app-accent px-3 text-sm font-medium text-app-onAccent"
                >
                  {text("新建任务", "New task")}
                </Link>
              </div>
            }
          />
        )}
      </Panel> : null}
    </div>
  );
}
