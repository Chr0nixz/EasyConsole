import { Download, Eye, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { Button, Dialog, Input, Panel, Select } from "../components/ui";
import { saveBlob } from "../lib/download";
import {
  clearRunLogs,
  filterRunLogs,
  formatRunLogExport,
  loadRunLogs,
  type RunLogChannel,
  type RunLogEntry,
  type RunLogResult,
  type RunLogSource,
} from "../lib/run-logs";
import { browserRuntime } from "../lib/runtime";
import { useI18n } from "../lib/i18n";
import type { Locale } from "../lib/i18n-text";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useToast } from "../lib/use-toast";

const sourceLabels: Record<RunLogSource, { zh: string; en: string }> = {
  auth: { zh: "登录", en: "Auth" },
  task: { zh: "任务", en: "Task" },
  "scheduled-task": { zh: "定时任务", en: "Scheduled Task" },
  "task-template": { zh: "实例模板", en: "Instance Template" },
  storage: { zh: "存储", en: "Storage" },
  image: { zh: "镜像", en: "Image" },
  settings: { zh: "设置", en: "Settings" },
  system: { zh: "系统", en: "System" },
};

const channelLabels: Record<RunLogChannel, { zh: string; en: string }> = {
  web: { zh: "Web", en: "Web" },
  tauri: { zh: "桌面", en: "Desktop" },
  cli: { zh: "CLI", en: "CLI" },
  mcp: { zh: "MCP", en: "MCP" },
};

const resultLabels: Record<RunLogResult, { zh: string; en: string }> = {
  success: { zh: "成功", en: "Success" },
  failure: { zh: "失败", en: "Failure" },
};

function labelFor<T extends string>(labels: Record<T, { zh: string; en: string }>, value: T, locale: Locale) {
  const label = labels[value];
  return locale === "en-US" ? label.en : label.zh;
}

function formatDateTime(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, { hour12: false });
}

function resultClass(result: RunLogResult) {
  return result === "success"
    ? "bg-app-successSoft text-app-success ring-app-successRing"
    : "bg-app-dangerSoft text-app-danger ring-app-dangerRing";
}

function levelClass(level: RunLogEntry["level"]) {
  if (level === "error") return "bg-app-dangerSoft text-app-danger ring-app-dangerRing";
  if (level === "warning") return "bg-app-warningSoft text-app-warning ring-app-warningRing";
  return "bg-app-infoSoft text-app-info ring-app-infoRing";
}

function withinRange(item: RunLogEntry, range: string) {
  if (!range) return true;
  const createdTime = Date.parse(item.createdAt);
  if (!Number.isFinite(createdTime)) return false;
  const days = Number(range);
  return createdTime >= Date.now() - days * 24 * 60 * 60 * 1000;
}

export function RunLogsPage() {
  const toast = useToast();
  const { locale, text } = useI18n();
  const { confirm, confirmDialog } = useConfirmAction();
  const [logs, setLogs] = useState<RunLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [keyword, setKeyword] = useState("");
  const [source, setSource] = useState<RunLogSource | "">("");
  const [channel, setChannel] = useState<RunLogChannel | "">("");
  const [result, setResult] = useState<RunLogResult | "">("");
  const [rangeDays, setRangeDays] = useState("30");
  const [selected, setSelected] = useState<RunLogEntry | null>(null);

  async function reload() {
    setLoading(true);
    try {
      setLogs(await loadRunLogs(browserRuntime.storage));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError : new Error(text("运行日志读取失败", "Failed to read run logs")));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleLogs = useMemo(
    () => filterRunLogs(logs.filter((item) => withinRange(item, rangeDays)), { keyword, source, channel, result }),
    [channel, keyword, logs, rangeDays, result, source],
  );

  function exportLogs() {
    saveBlob(new Blob([formatRunLogExport(visibleLogs)], { type: "application/json;charset=utf-8" }), "easy-console-run-logs.json");
    toast.success(text("运行日志已导出", "Run logs exported"), text(`${visibleLogs.length} 条记录`, `${visibleLogs.length} records`));
  }

  function confirmClear() {
    confirm({
      title: text("清空运行日志", "Clear Run Logs"),
      description: text("将清空当前环境保存的 EasyConsole 运行日志，实例日志不受影响。", "This clears EasyConsole run logs saved in the current environment. Instance logs are not affected."),
      confirmLabel: text("清空", "Clear"),
      tone: "danger",
      run: async () => {
        await clearRunLogs(browserRuntime.storage);
        setLogs([]);
        toast.success(text("运行日志已清空", "Run logs cleared"));
      },
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{text("运行日志", "Run Logs")}</h2>
          <p className="mt-1 text-sm text-app-muted">{text("记录 EasyConsole 的关键操作，与实例日志分开保存。", "Records key EasyConsole operations separately from instance logs.")}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <Button variant="secondary" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" />
            {text("刷新", "Refresh")}
          </Button>
          <Button variant="secondary" onClick={exportLogs}>
            <Download className="h-4 w-4" />
            {text("导出", "Export")}
          </Button>
          <Button className="border-app-danger text-app-danger hover:text-app-danger" variant="secondary" onClick={confirmClear}>
            <Trash2 className="h-4 w-4" />
            {text("清空", "Clear")}
          </Button>
        </div>
      </div>

      <Panel className="p-3">
        <div className="grid gap-2 md:grid-cols-[minmax(12rem,1fr)_9rem_9rem_9rem_9rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input className="w-full pl-9" placeholder={text("搜索操作、对象、错误", "Search action, target, or error")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          </div>
          <Select value={source} onChange={(event) => setSource(event.target.value as RunLogSource | "")}>
            <option value="">{text("全部模块", "All modules")}</option>
            {Object.entries(sourceLabels).map(([value]) => (
              <option key={value} value={value}>
                {labelFor(sourceLabels, value as RunLogSource, locale)}
              </option>
            ))}
          </Select>
          <Select value={channel} onChange={(event) => setChannel(event.target.value as RunLogChannel | "")}>
            <option value="">{text("全部来源", "All channels")}</option>
            {Object.entries(channelLabels).map(([value]) => (
              <option key={value} value={value}>
                {labelFor(channelLabels, value as RunLogChannel, locale)}
              </option>
            ))}
          </Select>
          <Select value={result} onChange={(event) => setResult(event.target.value as RunLogResult | "")}>
            <option value="">{text("全部结果", "All results")}</option>
            <option value="success">{text("成功", "Success")}</option>
            <option value="failure">{text("失败", "Failure")}</option>
          </Select>
          <Select value={rangeDays} onChange={(event) => setRangeDays(event.target.value)}>
            <option value="">{text("全部时间", "All time")}</option>
            <option value="1">{text("最近 1 天", "Last 1 day")}</option>
            <option value="7">{text("最近 7 天", "Last 7 days")}</option>
            <option value="30">{text("最近 30 天", "Last 30 days")}</option>
          </Select>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        {loading ? (
          <LoadingState label={text("正在读取运行日志", "Reading run logs")} />
        ) : error ? (
          <ErrorState error={error} action={<Button variant="secondary" onClick={() => void reload()}>{text("重试", "Retry")}</Button>} />
        ) : visibleLogs.length === 0 ? (
          <EmptyState title={text("还没有匹配的运行日志。关键操作完成后会自动记录。", "No matching run logs yet. Key operations are recorded automatically after completion.")} />
        ) : (
          <div className="overflow-auto">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("时间", "Time")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("级别", "Level")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("模块", "Module")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("来源", "Channel")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("结果", "Result")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("摘要", "Summary")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("对象", "Target")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("耗时", "Duration")}</th>
                  <th className="sticky right-0 z-20 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 font-medium">{text("操作", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((item) => (
                  <tr key={item.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{formatDateTime(item.createdAt, locale)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${levelClass(item.level)}`}>{item.level}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{labelFor(sourceLabels, item.source, locale)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{labelFor(channelLabels, item.channel, locale)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${resultClass(item.result)}`}>{labelFor(resultLabels, item.result, locale)}</span>
                    </td>
                    <td className="max-w-96 truncate px-3 py-2" title={item.error ?? item.title}>
                      {item.title}
                      {item.error ? <span className="ml-2 text-app-danger">{item.error}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{item.targetName ?? item.targetId ?? "-"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{item.durationMs === undefined ? "-" : `${item.durationMs}ms`}</td>
                    <td className="sticky right-0 z-10 bg-app-surface px-3 py-2">
                      <Button className="h-8 w-8 px-0" title={text("详情", "Details")} variant="ghost" onClick={() => setSelected(item)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog open={Boolean(selected)} title={text("运行日志详情", "Run Log Details")} onClose={() => setSelected(null)} width="max-w-4xl">
        <pre className="max-h-[70vh] overflow-auto bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText">
          {JSON.stringify(selected, null, 2)}
        </pre>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
