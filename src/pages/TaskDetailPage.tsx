import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileJson, FileText, Maximize2, Monitor, TerminalSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { StatusBadge } from "../components/StatusBadge";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { TaskLogPanel } from "../components/tasks/TaskLogPanel";
import { TaskSshPanel } from "../components/tasks/TaskSshPanel";
import { Button, Panel, Select } from "../components/ui";
import { instanceApi } from "../lib/api";
import { getTaskName, getTaskNodeName, getTaskReleaseCondition } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { buildMonitorDashboardUrl } from "../lib/monitor-dashboard";
import { browserRuntime } from "../lib/runtime";
import { buildTaskSshInfo } from "../lib/ssh-info";
import { taskSnapshotQueryOptions } from "../lib/task-snapshot-query";
import type { MonitorMetricSeries, Task } from "../lib/types";
import { useAuth } from "../lib/use-auth";

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

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-app-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs text-app-text">{value}</dd>
    </div>
  );
}

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { text } = useI18n();
  const auth = useAuth();
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
    () => (task ? buildMonitorDashboardUrl(task, { from: monitorRange, to: "now" }) : null),
    [task, monitorRange],
  );
  const releaseCondition = task ? getTaskReleaseCondition(task) : undefined;
  const sshSummary = useMemo(
    () => (task ? buildTaskSshInfo(task, { loginUsername: auth.user?.username ?? "" }) : null),
    [auth.user?.username, task],
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

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={queryError} action={<Button onClick={() => navigate("/tasks")}>{text("返回任务列表", "Back to tasks")}</Button>} />;
  if (!task) return <EmptyState title={text("任务不存在", "Task not found")} action={<Button onClick={() => navigate("/tasks")}>{text("返回任务列表", "Back to tasks")}</Button>} />;

  const tabs: Array<{ key: Tab; label: string; icon: typeof FileText }> = [
    { key: "log", label: text("日志", "Logs"), icon: FileText },
    { key: "monitor", label: text("监控", "Monitor"), icon: Monitor },
    { key: "ssh", label: text("终端", "Terminal"), icon: TerminalSquare },
    { key: "raw", label: text("原始 JSON", "Raw JSON"), icon: FileJson },
  ];
  const storagePath = typeof task.storage_path === "string" && task.storage_path.trim() ? task.storage_path : "-";
  const endpoint = sshSummary && sshSummary.host !== "-"
    ? `${sshSummary.host}${sshSummary.port !== "-" ? `:${sshSummary.port}` : ""}`
    : "-";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => navigate("/tasks")} aria-label={text("返回", "Back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-app-text">{getTaskName(task)}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-app-muted">
            <span>ID: {String(task.id)}</span>
            {task.task_id ? <span>Task ID: {String(task.task_id)}</span> : null}
            <StatusBadge status={task.status} />
            {releaseCondition != null ? <ReleaseConditionBadge condition={releaseCondition} /> : null}
          </div>
        </div>
      </div>

      <dl className="grid gap-3 rounded-md border border-app-border bg-app-surface px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryField
          label={text("资源", "Resources")}
          value={`${task.cpu ?? "-"}C / ${task.gpu ?? "-"}GPU / ${task.memory ?? "-"}G`}
        />
        <SummaryField label={text("节点", "Node")} value={getTaskNodeName(task) || "-"} />
        <SummaryField label={text("存储路径", "Storage path")} value={storagePath} />
        <SummaryField label={text("入口", "Endpoint")} value={endpoint} />
      </dl>

      <div
        className="flex flex-wrap gap-1 border-b border-app-border"
        role="tablist"
        aria-label={text("任务详情页签", "Task detail tabs")}
        onKeyDown={(event) => {
          const currentIndex = tabs.findIndex((item) => item.key === tab);
          if (currentIndex < 0) return;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const delta = event.key === "ArrowRight" ? 1 : -1;
            const next = tabs[(currentIndex + delta + tabs.length) % tabs.length];
            if (next) setTab(next.key);
            const nextButton = event.currentTarget.querySelector<HTMLElement>(`[data-tab-key="${next?.key}"]`);
            nextButton?.focus();
          } else if (event.key === "Home") {
            event.preventDefault();
            setTab(tabs[0].key);
            event.currentTarget.querySelector<HTMLElement>(`[data-tab-key="${tabs[0].key}"]`)?.focus();
          } else if (event.key === "End") {
            event.preventDefault();
            const last = tabs[tabs.length - 1];
            setTab(last.key);
            event.currentTarget.querySelector<HTMLElement>(`[data-tab-key="${last.key}"]`)?.focus();
          }
        }}
      >
        {tabs.map((tabItem) => {
          const Icon = tabItem.icon;
          const selected = tab === tabItem.key;
          return (
            <button
              key={tabItem.key}
              type="button"
              role="tab"
              id={`task-detail-tab-${tabItem.key}`}
              data-tab-key={tabItem.key}
              aria-selected={selected}
              aria-controls={`task-detail-panel-${tabItem.key}`}
              tabIndex={selected ? 0 : -1}
              className={`app-interactive flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selected
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
        <div role="tabpanel" id="task-detail-panel-monitor" aria-labelledby="task-detail-tab-monitor">
          {sparklineMetrics.length > 0 ? (
            <Panel className="p-4">
              <div className="mb-3 text-sm font-semibold text-app-text">{text("实时指标", "Live metrics")}</div>
              <div className="grid gap-4 sm:grid-cols-3">
                {sparklineMetrics.map((metric) => {
                  const path = renderSparkline(metric.points);
                  const min = Math.min(...metric.points);
                  const max = Math.max(...metric.points);
                  const summary = text(
                    `${metric.label}：${metric.points.length} 个采样点，最低 ${min.toFixed(2)}，最高 ${max.toFixed(2)}。`,
                    `${metric.label}: ${metric.points.length} samples, min ${min.toFixed(2)}, max ${max.toFixed(2)}.`,
                  );
                  return (
                    <div key={metric.label}>
                      <div className="mb-1 text-xs text-app-muted">{metric.label}</div>
                      {path ? (
                        <svg viewBox="0 0 200 40" className="h-10 w-full" preserveAspectRatio="none" role="img" aria-label={summary}>
                          <title>{summary}</title>
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
                <Button onClick={() => browserRuntime.openExternal(monitorUrl)}>
                  {text("在新窗口打开", "Open in new window")}
                </Button>
              </div>
            </div>
            <div className="px-4 py-10">
              <EmptyState
                icon={Monitor}
                title={text("无法在应用内嵌套显示 Grafana", "Grafana cannot be embedded in-app")}
                description={text(
                  "监控服务返回了 X-Frame-Options: deny，浏览器会拦截内嵌页面。请选择时间范围后，在新窗口打开完整 Grafana 面板。",
                  "The monitor service returns X-Frame-Options: deny, so the browser blocks the embedded page. Choose a time range, then open the full Grafana dashboard in a new window.",
                )}
                action={
                  <Button onClick={() => browserRuntime.openExternal(monitorUrl)}>
                    {text("打开 Grafana 面板", "Open Grafana dashboard")}
                  </Button>
                }
              />
            </div>
          </Panel>
        </div>
      ) : null}

      {tab === "monitor" && !monitorUrl ? (
        <div role="tabpanel" id="task-detail-panel-monitor" aria-labelledby="task-detail-tab-monitor">
          <EmptyState title={text("无法生成监控链接", "Unable to generate monitor URL")} description={text("任务缺少必要的标识信息", "Task is missing required identifier fields")} />
        </div>
      ) : null}

      {tab === "raw" ? (
        <div role="tabpanel" id="task-detail-panel-raw" aria-labelledby="task-detail-tab-raw">
          <Panel className="overflow-auto">
            <pre className="max-h-[70vh] overflow-auto bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText">
              {JSON.stringify(task, null, 2)}
            </pre>
          </Panel>
        </div>
      ) : null}

      {tab === "log" ? (
        <div role="tabpanel" id="task-detail-panel-log" aria-labelledby="task-detail-tab-log" className="space-y-2">
          <div className="flex justify-end">
            <Button className="h-8" type="button" variant="secondary" onClick={() => setLogOpen(true)}>
              <Maximize2 className="h-4 w-4" />
              {text("放大", "Expand")}
            </Button>
          </div>
          <Panel className="h-[min(60vh,36rem)] overflow-hidden p-0">
            <TaskLogPanel task={task} />
          </Panel>
        </div>
      ) : null}

      {tab === "ssh" ? (
        <div role="tabpanel" id="task-detail-panel-ssh" aria-labelledby="task-detail-tab-ssh" className="space-y-2">
          <div className="flex justify-end">
            <Button className="h-8" type="button" variant="secondary" onClick={() => setTerminalOpen(true)}>
              <Maximize2 className="h-4 w-4" />
              {text("放大", "Expand")}
            </Button>
          </div>
          <Panel className="overflow-hidden p-0">
            <TaskSshPanel task={task} />
          </Panel>
        </div>
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
