import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileJson, FileText, Monitor, TerminalSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { StatusBadge } from "../components/StatusBadge";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { Button, Panel, Select } from "../components/ui";
import { instanceApi } from "../lib/api";
import { getTaskName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { buildMonitorDashboardEmbedUrl } from "../lib/monitor-dashboard";
import { browserRuntime } from "../lib/runtime";
import { taskSnapshotQueryOptions } from "../lib/task-snapshot-query";
import type { MonitorMetricSeries, Task } from "../lib/types";

const TaskLogDialog = lazy(() => import("../components/tasks/TaskLogDialog").then((module) => ({ default: module.TaskLogDialog })));
const TerminalDialog = lazy(() => import("../components/tasks/TerminalDialog").then((module) => ({ default: module.TerminalDialog })));

type Tab = "log" | "monitor" | "ssh" | "raw";
type MonitorRange = "now-1h" | "now-6h" | "now-24h" | "now-7d";

const DETAIL_TABS: Tab[] = ["log", "monitor", "ssh", "raw"];

function parseDetailTab(value: string | null): Tab {
  return DETAIL_TABS.includes(value as Tab) ? (value as Tab) : "log";
}

function findTaskById(items: Task[], id: string) {
  return items.find((item) => String(item.id) === String(id) || String(item.task_id ?? "") === String(id));
}

const MONITOR_RANGES: Array<{ value: MonitorRange; zh: string; en: string }> = [
  { value: "now-1h", zh: "近 1 小时", en: "Last 1 hour" },
  { value: "now-6h", zh: "近 6 小时", en: "Last 6 hours" },
  { value: "now-24h", zh: "近 24 小时", en: "Last 24 hours" },
  { value: "now-7d", zh: "近 7 天", en: "Last 7 days" },
];

function extractSeriesPoints(series: MonitorMetricSeries | undefined): number[] {
  if (!series?.data) return [];
  return series.data
    .map((point) => Number(point.value))
    .filter((value) => Number.isFinite(value));
}

function renderSparkline(points: number[]): string {
  if (points.length < 2) return "";
  const width = 200;
  const height = 40;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  return points
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { text } = useI18n();
  const [tab, setTab] = useState<Tab>(() => parseDetailTab(searchParams.get("tab")));
  const [logOpen, setLogOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [monitorRange, setMonitorRange] = useState<MonitorRange>("now-1h");

  useEffect(() => {
    setTab(parseDetailTab(searchParams.get("tab")));
  }, [searchParams]);

  const snapshotQuery = useQuery({
    ...taskSnapshotQueryOptions(instanceApi),
    enabled: Boolean(id),
    refetchInterval: false,
    select: (data) => (id ? findTaskById(data.items, id) : undefined),
  });

  // Fallback when the shared snapshot has loaded but does not include this id
  // (e.g. TasksPage wrote a filtered page into the snapshot cache).
  const fallbackQuery = useQuery({
    queryKey: ["task-detail", id],
    queryFn: async () => {
      if (!id) throw new Error("Missing task id");
      const result = await instanceApi.tasks({ page: 1, page_size: 500 });
      const found = findTaskById(result.items, id);
      if (!found) throw new Error(text("任务不存在", "Task not found"));
      return found;
    },
    enabled: Boolean(id) && snapshotQuery.isFetched && !snapshotQuery.data,
  });

  const task = snapshotQuery.data ?? fallbackQuery.data;
  const isLoading = snapshotQuery.isLoading || (fallbackQuery.isEnabled && fallbackQuery.isLoading);
  const isError = Boolean(
    (snapshotQuery.isFetched && !snapshotQuery.data && fallbackQuery.isError) ||
      (snapshotQuery.isError && !task),
  );
  const queryError = fallbackQuery.error ?? snapshotQuery.error;
  const monitorUrl = useMemo(
    () => (task ? buildMonitorDashboardEmbedUrl(task, { from: monitorRange, to: "now" }) : null),
    [task, monitorRange],
  );

  const monitorIndexQuery = useQuery({
    queryKey: ["task-monitor-index", id],
    queryFn: () => instanceApi.monitorIndex({ task_id: String(task?.task_id ?? task?.id ?? id) }),
    enabled: Boolean(task && tab === "monitor"),
    refetchInterval: 30_000,
  });

  const sparklineMetrics = useMemo(() => {
    const data = monitorIndexQuery.data;
    if (!data) return [];
    const series: Array<{ label: string; points: number[] }> = [];
    const cpuSeries = Array.isArray(data.cpu) ? data.cpu[0] : undefined;
    const cpuPoints = extractSeriesPoints(cpuSeries);
    if (cpuPoints.length >= 2) series.push({ label: text("CPU", "CPU"), points: cpuPoints });
    const memSeries = Array.isArray(data.memory) ? data.memory[0] : undefined;
    const memPoints = extractSeriesPoints(memSeries);
    if (memPoints.length >= 2) series.push({ label: text("内存", "Memory"), points: memPoints });
    const netSeries = Array.isArray(data.network) ? data.network[0] : undefined;
    const netPoints = extractSeriesPoints(netSeries);
    if (netPoints.length >= 2) series.push({ label: text("网络", "Network"), points: netPoints });
    return series;
  }, [monitorIndexQuery.data, text]);

  useEffect(() => {
    if (tab === "log" && task) setLogOpen(true);
    if (tab === "ssh" && task) setTerminalOpen(true);
  }, [tab, task]);

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={queryError} action={<Button onClick={() => navigate("/tasks")}>{text("返回任务列表", "Back to tasks")}</Button>} />;
  if (!task) return <EmptyState title={text("任务不存在", "Task not found")} action={<Button onClick={() => navigate("/tasks")}>{text("返回任务列表", "Back to tasks")}</Button>} />;

  const tabs: Array<{ key: Tab; label: string; icon: typeof FileText }> = [
    { key: "log", label: text("日志", "Logs"), icon: FileText },
    { key: "monitor", label: text("监控", "Monitor"), icon: Monitor },
    { key: "ssh", label: text("终端", "Terminal"), icon: TerminalSquare },
    { key: "raw", label: text("原始 JSON", "Raw JSON"), icon: FileJson },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => navigate("/tasks")} aria-label={text("返回", "Back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-app-text">{getTaskName(task)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-app-muted">
            <span>ID: {String(task.id)}</span>
            {task.task_id ? <span>Task ID: {String(task.task_id)}</span> : null}
            <StatusBadge status={task.status} />
            {task.release_conditions != null ? <ReleaseConditionBadge condition={Number(task.release_conditions)} /> : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-app-border">
        {tabs.map((tabItem) => {
          const Icon = tabItem.icon;
          return (
            <button
              key={tabItem.key}
              type="button"
              className={`app-interactive flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === tabItem.key
                  ? "border-app-accent text-app-accent"
                  : "border-transparent text-app-muted hover:text-app-text"
              }`}
              onClick={() => setTab(tabItem.key)}
            >
              <Icon className="h-3.5 w-3.5" />
              {tabItem.label}
            </button>
          );
        })}
      </div>

      {tab === "monitor" && monitorUrl ? (
        <>
          {sparklineMetrics.length > 0 ? (
            <Panel className="p-4">
              <div className="mb-3 text-sm font-semibold text-app-text">{text("实时指标", "Live metrics")}</div>
              <div className="grid gap-4 sm:grid-cols-3">
                {sparklineMetrics.map((metric) => {
                  const path = renderSparkline(metric.points);
                  return (
                    <div key={metric.label}>
                      <div className="mb-1 text-xs text-app-muted">{metric.label}</div>
                      {path ? (
                        <svg viewBox="0 0 200 40" className="h-10 w-full" preserveAspectRatio="none" role="img" aria-label={metric.label}>
                          <path d={path} fill="none" stroke="var(--color-app-accent)" strokeWidth={1.5} />
                        </svg>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Panel>
          ) : null}
          <Panel className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border px-3 py-2">
              <span className="text-sm font-medium text-app-text">{text("Grafana 监控面板", "Grafana Monitor Dashboard")}</span>
              <div className="flex items-center gap-2">
                <Select
                  aria-label={text("时间范围", "Time range")}
                  value={monitorRange}
                  onChange={(event) => setMonitorRange(event.target.value as MonitorRange)}
                  className="h-8 text-xs"
                >
                  {MONITOR_RANGES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {text(option.zh, option.en)}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" onClick={() => browserRuntime.openExternal(monitorUrl)}>
                  {text("在新窗口打开", "Open in new window")}
                </Button>
              </div>
            </div>
            <iframe
              src={monitorUrl}
              className="h-[60vh] w-full border-0"
              title={text("任务监控", "Task monitor")}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            />
          </Panel>
        </>
      ) : null}

      {tab === "monitor" && !monitorUrl ? (
        <EmptyState title={text("无法生成监控链接", "Unable to generate monitor URL")} description={text("任务缺少必要的标识信息", "Task is missing required identifier fields")} />
      ) : null}

      {tab === "raw" ? (
        <Panel className="overflow-auto">
          <pre className="max-h-[70vh] overflow-auto bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText">
            {JSON.stringify(task, null, 2)}
          </pre>
        </Panel>
      ) : null}

      {tab === "log" || tab === "ssh" ? (
        <Panel className="p-4">
          <EmptyState
            title={tab === "log" ? text("点击下方按钮查看日志", "Click the button below to view logs") : text("点击下方按钮打开终端", "Click the button below to open terminal")}
            action={
              <Button onClick={() => (tab === "log" ? setLogOpen(true) : setTerminalOpen(true))}>
                {tab === "log" ? text("查看日志", "View logs") : text("打开终端", "Open terminal")}
              </Button>
            }
          />
        </Panel>
      ) : null}

      <Suspense fallback={null}>
        <TaskLogDialog task={logOpen ? task : null} onClose={() => setLogOpen(false)} />
      </Suspense>
      <Suspense fallback={null}>
        <TerminalDialog task={terminalOpen ? task : null} onClose={() => setTerminalOpen(false)} />
      </Suspense>
    </div>
  );
}
