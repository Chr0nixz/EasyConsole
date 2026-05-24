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
import { useConfirmAction } from "../lib/use-confirm-action";
import { useToast } from "../lib/use-toast";

const sourceLabels: Record<RunLogSource, string> = {
  auth: "登录",
  task: "任务",
  "scheduled-task": "定时任务",
  "task-template": "实例模板",
  storage: "存储",
  image: "镜像",
  settings: "设置",
  system: "系统",
};

const channelLabels: Record<RunLogChannel, string> = {
  web: "Web",
  tauri: "桌面",
  cli: "CLI",
  mcp: "MCP",
};

const resultLabels: Record<RunLogResult, string> = {
  success: "成功",
  failure: "失败",
};

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
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
      setError(loadError instanceof Error ? loadError : new Error("运行日志读取失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const visibleLogs = useMemo(
    () => filterRunLogs(logs.filter((item) => withinRange(item, rangeDays)), { keyword, source, channel, result }),
    [channel, keyword, logs, rangeDays, result, source],
  );

  function exportLogs() {
    saveBlob(new Blob([formatRunLogExport(visibleLogs)], { type: "application/json;charset=utf-8" }), "easy-console-run-logs.json");
    toast.success("运行日志已导出", `${visibleLogs.length} 条记录`);
  }

  function confirmClear() {
    confirm({
      title: "清空运行日志",
      description: "将清空当前环境保存的 EasyConsole 运行日志，实例日志不受影响。",
      confirmLabel: "清空",
      tone: "danger",
      run: async () => {
        await clearRunLogs(browserRuntime.storage);
        setLogs([]);
        toast.success("运行日志已清空");
      },
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">运行日志</h2>
          <p className="mt-1 text-sm text-app-muted">记录 EasyConsole 的关键操作，与实例日志分开保存。</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <Button variant="secondary" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <Button variant="secondary" onClick={exportLogs}>
            <Download className="h-4 w-4" />
            导出
          </Button>
          <Button className="border-app-danger text-app-danger hover:text-app-danger" variant="secondary" onClick={confirmClear}>
            <Trash2 className="h-4 w-4" />
            清空
          </Button>
        </div>
      </div>

      <Panel className="p-3">
        <div className="grid gap-2 md:grid-cols-[minmax(12rem,1fr)_9rem_9rem_9rem_9rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input className="w-full pl-9" placeholder="搜索操作、对象、错误" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          </div>
          <Select value={source} onChange={(event) => setSource(event.target.value as RunLogSource | "")}>
            <option value="">全部模块</option>
            {Object.entries(sourceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select value={channel} onChange={(event) => setChannel(event.target.value as RunLogChannel | "")}>
            <option value="">全部来源</option>
            {Object.entries(channelLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select value={result} onChange={(event) => setResult(event.target.value as RunLogResult | "")}>
            <option value="">全部结果</option>
            <option value="success">成功</option>
            <option value="failure">失败</option>
          </Select>
          <Select value={rangeDays} onChange={(event) => setRangeDays(event.target.value)}>
            <option value="">全部时间</option>
            <option value="1">最近 1 天</option>
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
          </Select>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        {loading ? (
          <LoadingState label="正在读取运行日志" />
        ) : error ? (
          <ErrorState error={error} action={<Button variant="secondary" onClick={() => void reload()}>重试</Button>} />
        ) : visibleLogs.length === 0 ? (
          <EmptyState title="还没有匹配的运行日志。关键操作完成后会自动记录。" />
        ) : (
          <div className="overflow-auto">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">时间</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">级别</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">模块</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">来源</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">结果</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">摘要</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">对象</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">耗时</th>
                  <th className="sticky right-0 z-20 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((item) => (
                  <tr key={item.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{formatDateTime(item.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${levelClass(item.level)}`}>{item.level}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{sourceLabels[item.source]}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{channelLabels[item.channel]}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${resultClass(item.result)}`}>{resultLabels[item.result]}</span>
                    </td>
                    <td className="max-w-96 truncate px-3 py-2" title={item.error ?? item.title}>
                      {item.title}
                      {item.error ? <span className="ml-2 text-app-danger">{item.error}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{item.targetName ?? item.targetId ?? "-"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-app-muted">{item.durationMs === undefined ? "-" : `${item.durationMs}ms`}</td>
                    <td className="sticky right-0 z-10 bg-app-surface px-3 py-2">
                      <Button className="h-8 w-8 px-0" title="详情" variant="ghost" onClick={() => setSelected(item)}>
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

      <Dialog open={Boolean(selected)} title="运行日志详情" onClose={() => setSelected(null)} width="max-w-4xl">
        <pre className="max-h-[70vh] overflow-auto bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText">
          {JSON.stringify(selected, null, 2)}
        </pre>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
