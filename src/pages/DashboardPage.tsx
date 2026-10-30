import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { IdleInstancePill } from "../components/IdleInstancePill";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { StatusBadge } from "../components/StatusBadge";
import { Button, Panel, SegmentedControl, Select, TableRegion } from "../components/ui";
import { instanceApi } from "../lib/api";
import { formatCost, formatHours, formatNumber, formatRelativeUpdatedAt, formatSecondsDuration, getTaskName, getTaskNodeName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { Locale } from "../lib/i18n-text";
import { useIdleEvidence } from "../lib/idle-instance-state";
import { useCompactLayout } from "../lib/use-compact-layout";
import { EXECUTION_LEDGER_ROUTE, useExecutionReviewCount } from "../lib/use-execution-review";
import { browserRuntime } from "../lib/runtime";
import { cn } from "../lib/utils";
import { DEFAULT_TASK_PAGE, DEFAULT_TASK_PAGE_SIZE, serializeTaskListQuery, taskTimestamp } from "../lib/task-list-query";
import { requestCreateTask } from "../lib/task-create-request";
import { getLiveTimedReleaseAt, TIMED_RELEASE_CONDITION } from "../lib/task-release-notifications";
import type { ConsoleSummary, Task } from "../lib/types";

type TimeRange = "day" | "week" | "month";

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
        `最近变化 ${formatRelativeUpdatedAt(updatedAt, now, locale)}`,
        `changed ${formatRelativeUpdatedAt(updatedAt, now, locale)}`,
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

// The whole row is the link target (the name stretches over it), which also gives touch a full-height hit area.
// A live timed release adds its countdown, since an extension is decided from here as often as from the detail page;
// an instance the idle watcher judges idle says so on the same line until it is active again.
function DashboardTaskRow({ task, meta }: { task: Task; meta: string }) {
  const { text } = useI18n();
  const releaseAt = getLiveTimedReleaseAt(task);
  const idle = useIdleEvidence(task) !== null && Number(task.status) === 2;
  return (
    <li className="relative px-3 py-2.5 transition-colors duration-150 hover:bg-app-panel/60">
      <div className="flex items-center justify-between gap-3">
        {/* Two lines before clipping: run names share long prefixes and differ at the end. */}
        <Link
          to={`/tasks/${task.id}`}
          className="line-clamp-2 min-w-0 break-words text-sm font-medium text-app-accent after:absolute after:inset-0 after:content-[''] hover:underline"
          title={getTaskName(task)}
          aria-label={text(`查看实例 ${getTaskName(task)} 详情`, `View details for ${getTaskName(task)}`)}
        >
          {getTaskName(task)}
        </Link>
        <StatusBadge status={task.status} />
      </div>
      {meta ? <p className="mt-0.5 truncate text-xs text-app-muted">{meta}</p> : null}
      {releaseAt !== null || idle ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {idle ? <IdleInstancePill task={task} /> : null}
          {releaseAt !== null ? <ReleaseConditionBadge condition={TIMED_RELEASE_CONDITION} releaseAt={releaseAt} /> : null}
        </div>
      ) : null}
    </li>
  );
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
          {tasks.slice(0, 8).map((task) => (
            <DashboardTaskRow key={String(task.id)} task={task} meta={taskMetaLine(task, now, locale, text)} />
          ))}
        </ul>
      )}
    </section>
  );
}

type BillingRate = { perHour: number; partial: boolean };

// What the running instances cost per hour right now, from each one's own price. An instance
// without a price is not guessed at; the figure then reads as a floor.
function runningBillingRate(tasks: Task[]): BillingRate | null {
  let perHour = 0;
  let priced = 0;
  for (const task of tasks) {
    const price = Number(task.price);
    if (Number.isFinite(price) && price > 0) {
      perHour += price;
      priced += 1;
    }
  }
  return priced === 0 ? null : { perHour, partial: priced < tasks.length };
}

function formatBillingRate(rate: BillingRate, locale: Locale, text: (zh: string, en: string) => string) {
  const amount = formatCost(rate.perHour, locale);
  return rate.partial ? text(`至少 ${amount}/小时`, `≥ ${amount}/hr`) : text(`约 ${amount}/小时`, `≈ ${amount}/hr`);
}

// The status line stays a sentence, not a stat-card row. Figures update in place; the
// one live pulse in the product sits here, on the running count, and nowhere else.
// The billing rate sits beside the running count, so the line answers "what is this costing now".
function SummaryLine({ running, queued, runtime, cost, rangeName, billingRate }: { running: number; queued: number; runtime: number; cost: number; rangeName: string; billingRate: BillingRate | null }) {
  const { locale, text } = useI18n();
  const rateValue = billingRate ? formatBillingRate(billingRate, locale, text) : null;
  const segments = [
    { key: "running", label: text("运行中", "Running"), value: formatNumber(running, 0, locale), live: running > 0 },
    ...(rateValue ? [{ key: "rate", label: text("当前计费", "Billing now"), value: rateValue, live: false, wide: true }] : []),
    { key: "queued", label: text("队列中", "Queued"), value: formatNumber(queued, 0, locale), live: false },
    { key: "runtime", label: text(`${rangeName}时长`, rangeName), value: formatSecondsDuration(runtime, locale), live: false },
    { key: "cost", label: text("费用", "Cost"), value: formatCost(cost, locale), live: false },
  ];

  return (
    <p className="min-w-0 text-sm text-app-text">
      <span className="sr-only">
        {text(
          `运行中 ${formatNumber(running, 0, locale)}${rateValue ? ` · 当前计费 ${rateValue}` : ""} · 队列中 ${formatNumber(queued, 0, locale)} · ${rangeName}时长 ${formatSecondsDuration(runtime, locale)} · 费用 ${formatCost(cost, locale)}`,
          `Running ${formatNumber(running, 0, locale)}${rateValue ? ` · billing now ${rateValue}` : ""} · queued ${formatNumber(queued, 0, locale)} · ${rangeName} ${formatSecondsDuration(runtime, locale)} · cost ${formatCost(cost, locale)}`,
        )}
      </span>
      {/* Two columns on phones (no rules to strand at a wrap), one ruled sentence from sm up.
          The billing rate is too long for half a phone row, so it takes a whole one under the counts. */}
      <span aria-hidden="true" className="grid grid-flow-row-dense grid-cols-2 gap-x-4 gap-y-1.5 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-0">
        {segments.map((segment, index) => (
          <span key={segment.key} className={cn("inline-flex items-baseline gap-2 sm:pr-4", index > 0 && "sm:border-l sm:border-app-border sm:pl-4", "wide" in segment && "col-span-2 sm:col-span-1")}>
            {segment.live ? <span className="app-live-dot h-1.5 w-1.5 shrink-0 self-center rounded-full bg-app-info text-app-info" /> : null}
            <span className="whitespace-nowrap text-app-muted">{segment.label}</span>
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
    </div>
  );
}

export function DashboardPage() {
  const { locale, t, text } = useI18n();
  const compactLayout = useCompactLayout();
  const [timeRange, setTimeRange] = useState<TimeRange>("week");
  const executionReviewCount = useExecutionReviewCount();
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
  const failedTasks = byRecency(allTasks.filter((task) => Number(task.status) === 7 || Number(task.status) === 8));
  const runningTasks = byRecency(allTasks.filter((task) => Number(task.status) === 2));
  // Initializing (0) has not started either; the backend's pending count includes it, so the column does too.
  const queuedTasks = byRecency(allTasks.filter((task) => Number(task.status) === 0 || Number(task.status) === 1));
  // The attention columns already list failed, running and queued instances; this panel carries
  // the rest (finished, released, paused) so nothing appears twice. With tasks but nothing else
  // to show, the panel is left out rather than shown empty.
  const inColumns = new Set([...failedTasks, ...runningTasks, ...queuedTasks]);
  const recentTasks = byRecency(allTasks.filter((task) => !inColumns.has(task))).slice(0, 8);
  const showRecentPanel = allTasks.length === 0 || recentTasks.length > 0 || staticsQuery.isError;

  const runtimeValue = Number(summary.run_time?.[timeRange] ?? 0);
  const costValue = Number(summary.cost_map?.[timeRange] ?? 0);

  const refreshAll = () => {
    void consoleQuery.refetch();
    void staticsQuery.refetch();
  };
  const rangeControl = (
    <SegmentedControl
      className={compactLayout ? "flex-1" : undefined}
      label={text("时间范围", "Time range")}
      value={timeRange}
      options={TIME_RANGES.map((range) => ({ value: range, label: rangeLabel(range, text) }))}
      optionClassName={compactLayout ? "flex-1 px-3" : "px-3"}
      onChange={setTimeRange}
    />
  );
  const freshness = lastFetchedAt > 0 ? (
    <span className="whitespace-nowrap text-xs text-app-muted" title={new Date(lastFetchedAt).toLocaleString(locale)}>
      {consoleQuery.isFetching || staticsQuery.isFetching
        ? text("刷新中…", "Refreshing…")
        : text(`更新于 ${formatRelativeUpdatedAt(lastFetchedAt, Math.max(nowMs, lastFetchedAt), locale)}`, `Updated ${formatRelativeUpdatedAt(lastFetchedAt, Math.max(nowMs, lastFetchedAt), locale)}`)}
    </span>
  ) : null;
  const autoRefreshControl = (
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
          billingRate={runningBillingRate(runningTasks)}
        />
        {compactLayout ? (
          // Phones: the range choice spans the row with refresh in thumb reach beside it,
          // and the freshness line sits under it as small print rather than a third control row.
          <div className="w-full space-y-1.5">
            <div className="flex items-center gap-2">
              {rangeControl}
              <Button
                aria-label={text("刷新", "Refresh")}
                className="shrink-0 px-0"
                title={text("刷新", "Refresh")}
                variant="secondary"
                onClick={refreshAll}
              >
                <RefreshCw className={consoleQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3">
              {freshness ?? <span />}
              {autoRefreshControl}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {rangeControl}
            {/* Refresh controls wrap as one unit so the button never strands on its own row. */}
            <div className="flex items-center gap-2">
              {freshness}
              {autoRefreshControl}
              <Button className="h-8" variant="secondary" onClick={refreshAll}>
                <RefreshCw className={consoleQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                {text("刷新", "Refresh")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {executionReviewCount > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-app-warningSoft px-3 py-2 text-sm text-app-warningText">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {text(
            `${executionReviewCount} 次定时执行的远程结果不确定，实例可能已创建并在计费。`,
            `${executionReviewCount} scheduled ${executionReviewCount === 1 ? "run has" : "runs have"} an uncertain remote result; an instance may exist and be billing.`,
          )}
          <Link className="font-medium underline underline-offset-2" to={EXECUTION_LEDGER_ROUTE}>
            {text("去核对", "Review")}
          </Link>
        </p>
      ) : null}
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
          title={text("队列中", "Queued")}
          href={tasksHref("1")}
          tasks={queuedTasks}
          emptyLabel={text("没有队列中的实例", "No queued instances")}
          now={tasksFetchedAt}
        />
      </div>}

      {taskDataAvailable && showRecentPanel ? <Panel>
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="text-sm font-semibold">{text("其他最近实例", "Other recent instances")}</div>
          {staticsQuery.isError ? (
            <Button className="h-8" variant="secondary" onClick={() => staticsQuery.refetch()}>
              {text("重试", "Retry")}
            </Button>
          ) : null}
        </div>
        {staticsQuery.isLoading ? (
          <LoadingState label={text("正在加载实例", "Loading instances")} />
        ) : staticsQuery.isError ? (
          <ErrorState error={staticsQuery.error} action={<Button variant="secondary" onClick={() => staticsQuery.refetch()}>{text("重试", "Retry")}</Button>} />
        ) : recentTasks.length > 0 ? (
          compactLayout ? (
            // Same rows as the attention columns above, so the page reads as one list on a phone.
            <ul className="divide-y divide-app-border">
              {recentTasks.map((task) => (
                <DashboardTaskRow
                  key={String(task.id)}
                  task={task}
                  meta={[
                    `${task.cpu ?? "-"}C / ${task.gpu ?? "-"}GPU / ${task.memory ?? "-"}G`,
                    getTaskNodeName(task),
                    formatCost(task.cost, locale),
                    Number.isFinite(Number(task.use_time)) ? text(`时长 ${formatHours(task.use_time, locale)}`, `Duration ${formatHours(task.use_time, locale)}`) : "",
                  ].filter(Boolean).join(" · ")}
                />
              ))}
            </ul>
          ) : (
            <TableRegion label={text("最近实例表格", "Recent instances table")}>
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-app-panel text-left text-xs text-app-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium" scope="col">{text("名称", "Name")}</th>
                    <th className="px-3 py-2 font-medium" scope="col">{text("状态", "Status")}</th>
                    <th className="px-3 py-2 font-medium" scope="col">{text("资源", "Resources")}</th>
                    <th className="px-3 py-2 font-medium" scope="col">{text("节点", "Node")}</th>
                    <th className="px-3 py-2 font-medium" scope="col">{text("时长", "Duration")}</th>
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
                      <td className="app-numeric px-3 py-2 text-app-muted">{formatHours(task.use_time, locale)}</td>
                      <td className="app-numeric px-3 py-2 text-app-muted">{formatCost(task.cost, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          )
        ) : (
          <EmptyState
            title={text("暂无最近实例", "No recent instances")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  to="/tasks"
                  className="app-interactive inline-flex h-9 items-center rounded-md border border-app-borderStrong bg-app-surface px-3 text-sm font-medium text-app-text shadow-raised hover:border-app-muted hover:bg-app-panel"
                >
                  {text("去任务实例", "Go to tasks")}
                </Link>
                {/* Lands on the list with the create form already open, as the command palette does. */}
                <Link
                  to="/tasks"
                  onClick={() => requestCreateTask()}
                  className="app-interactive inline-flex h-9 items-center rounded-md bg-app-accent px-3 text-sm font-medium text-app-onAccent"
                >
                  {text("新建实例", "New instance")}
                </Link>
              </div>
            }
          />
        )}
      </Panel> : null}
    </div>
  );
}
