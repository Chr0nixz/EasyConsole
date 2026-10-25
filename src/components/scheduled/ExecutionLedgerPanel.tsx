import { AlertTriangle, ClipboardList, Copy, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState } from "../DataState";
import { StatusBadge } from "../StatusBadge";
import { Button, Panel, Select, StatePill, TableRegion, type StateTone } from "../ui";
import { instanceApi } from "../../lib/api";
import {
  isPendingReviewEntry,
  listExecutionLedger,
  resolveExecutionLedgerEntry,
  type ExecutionLedgerEntry,
  type ExecutionOutcome,
} from "../../lib/execution-ledger";
import { getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import type { Locale } from "../../lib/i18n-text";
import { i18nText } from "../../lib/i18n-text";
import { browserRuntime } from "../../lib/runtime";
import type { Task } from "../../lib/types";
import { errorMessage } from "../../lib/use-run-logger";
import { useConfirmAction } from "../../lib/use-confirm-action";
import { useToast } from "../../lib/use-toast";

type LedgerFilter = "all" | "needs-review" | ExecutionOutcome;

const isPendingReview = isPendingReviewEntry;

/** How far from the execution start a remote instance may have been created and still count as this run. */
const MATCH_WINDOW_MS = 30 * 60 * 1000;
const MATCH_SCAN_PAGE_SIZE = 100;

type MatchState = { loading: true } | { loading: false; tasks: Task[] } | { loading: false; error: string };

function taskCreatedAt(task: Task) {
  const raw = String(task.create_time ?? task.created_at ?? "").trim();
  if (!raw) return Number.NaN;
  return Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
}

/** Instances whose name starts with the schedule's name (auto-numbering appends a suffix) created near the run. */
function matchingInstances(entry: ExecutionLedgerEntry, tasks: Task[]) {
  const started = Date.parse(entry.startedAt);
  return tasks.filter((task) => {
    if (!getTaskName(task).startsWith(entry.scheduledTaskName)) return false;
    const created = taskCreatedAt(task);
    return !Number.isFinite(created) || !Number.isFinite(started) || Math.abs(created - started) <= MATCH_WINDOW_MS;
  });
}

const outcomeText: Record<ExecutionOutcome, { zh: string; en: string }> = {
  completed: { zh: "已完成", en: "Completed" },
  "local-persist-failed": { zh: "本地保存失败", en: "Local save failed" },
  unknown: { zh: "结果未知", en: "Unknown result" },
  failed: { zh: "执行失败", en: "Failed" },
  "held-owner-mismatch": { zh: "账号不一致已挂起", en: "Held: owner mismatch" },
};

function outcomeTone(outcome: ExecutionOutcome): StateTone {
  if (outcome === "completed") return "success";
  if (outcome === "failed" || outcome === "local-persist-failed") return "danger";
  return "warning";
}

const triggerText: Record<ExecutionLedgerEntry["trigger"], { zh: string; en: string }> = {
  schedule: { zh: "计划调度", en: "Schedule" },
  manual: { zh: "手动", en: "Manual" },
  cli: { zh: "CLI", en: "CLI" },
};

/** Local-time display for ISO ledger stamps, mirroring the run logs page. */
function formatLedgerTime(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, { hour12: false });
}

/**
 * Read-only execution ledger for scheduled/manual task submissions (review 6.1).
 * Uncertain outcomes (remote created but local persist failed, or result unknown)
 * aggregate into a "needs review" section with manual confirm actions; everything
 * else stays as history. Confirming only records the resolution locally — it never
 * touches the remote API or retries the submission.
 */
export function ExecutionLedgerPanel() {
  const { locale, text } = useI18n();
  const toast = useToast();
  const { confirm, confirmDialog } = useConfirmAction();
  const [entries, setEntries] = useState<ExecutionLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [matches, setMatches] = useState<Record<string, MatchState>>({});
  const noteInputRef = useRef<HTMLInputElement | null>(null);

  async function findMatches(entry: ExecutionLedgerEntry) {
    setMatches((current) => ({ ...current, [entry.id]: { loading: true } }));
    try {
      const { items } = await instanceApi.tasks({ page: 1, page_size: MATCH_SCAN_PAGE_SIZE });
      setMatches((current) => ({ ...current, [entry.id]: { loading: false, tasks: matchingInstances(entry, items) } }));
    } catch (error) {
      setMatches((current) => ({ ...current, [entry.id]: { loading: false, error: errorMessage(error, text("查找失败", "Lookup failed")) } }));
    }
  }

  const reload = useCallback(
    () =>
      listExecutionLedger(browserRuntime.storage)
        .then((list) => {
          setEntries(list);
          setLoadError(null);
        })
        .catch((error) =>
          setLoadError(error instanceof Error ? error : new Error(i18nText("执行台账读取失败", "Failed to read the execution ledger"))),
        )
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void reload();
    // The background runner appends to the same storage key, so re-read on
    // focus instead of holding the mount-time snapshot for the whole session.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const pending = useMemo(() => entries.filter(isPendingReview), [entries]);
  const history = useMemo(
    () => entries.filter((entry) => (filter === "all" ? true : filter === "needs-review" ? isPendingReview(entry) : entry.outcome === filter)),
    [entries, filter],
  );

  function confirmCreated(entry: ExecutionLedgerEntry, remoteTaskId?: string) {
    confirm({
      title: text("确认已创建远程实例", "Confirm remote instance was created"),
      description: (
        <span className="block space-y-3 text-left">
          <span className="block">
            {text(
              `将把「${entry.scheduledTaskName}」在 ${formatLedgerTime(entry.startedAt, locale)} 的这次执行标记为“远程已创建”。`,
              `This run of "${entry.scheduledTaskName}" at ${formatLedgerTime(entry.startedAt, locale)} will be marked as created remotely.`,
            )}
          </span>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("远程任务 ID（可选备注）", "Remote task ID (optional note)")}</span>
            <input
              ref={noteInputRef}
              className="h-9 w-full rounded-md border border-app-borderStrong bg-app-surface px-3 font-mono text-xs text-app-text placeholder:text-app-muted hover:border-app-muted"
              defaultValue={remoteTaskId ?? entry.remoteTaskId ?? ""}
              placeholder={text("例如 12345", "e.g. 12345")}
            />
          </label>
        </span>
      ),
      confirmLabel: text("确认已创建", "Confirmed created"),
      run: async () => {
        const note = noteInputRef.current?.value.trim();
        try {
          const resolved = await resolveExecutionLedgerEntry(browserRuntime.storage, entry.id, {
            status: "confirmed-created",
            resolvedAt: new Date().toISOString(),
            note: note || undefined,
          });
          await reload();
          if (!resolved) {
            toast.error(
              text("核对失败", "Review failed"),
              text("该执行记录不存在或已被清理，请刷新后重试。", "This execution record no longer exists or was pruned; refresh and try again."),
            );
            return;
          }
          toast.success(text("执行台账已更新", "Execution ledger updated"), text("已标记为远程已创建", "Marked as created remotely"));
        } catch (error) {
          toast.error(text("核对失败", "Review failed"), errorMessage(error, text("请稍后重试", "Try again later")));
        }
      },
    });
  }

  function confirmNotCreated(entry: ExecutionLedgerEntry) {
    confirm({
      title: text("确认未创建远程实例", "Confirm remote instance was not created"),
      description: text(
        `将把「${entry.scheduledTaskName}」在 ${formatLedgerTime(entry.startedAt, locale)} 的这次执行标记为“远程未创建”。这只是一条本地核对记录，不会对远端做任何操作。`,
        `This run of "${entry.scheduledTaskName}" at ${formatLedgerTime(entry.startedAt, locale)} will be marked as not created remotely. This is a local review note only; nothing is sent to the server.`,
      ),
      confirmLabel: text("确认未创建", "Confirmed not created"),
      run: async () => {
        try {
          const resolved = await resolveExecutionLedgerEntry(browserRuntime.storage, entry.id, {
            status: "confirmed-not-created",
            resolvedAt: new Date().toISOString(),
          });
          await reload();
          if (!resolved) {
            toast.error(
              text("核对失败", "Review failed"),
              text("该执行记录不存在或已被清理，请刷新后重试。", "This execution record no longer exists or was pruned; refresh and try again."),
            );
            return;
          }
          toast.success(text("执行台账已更新", "Execution ledger updated"), text("已标记为远程未创建", "Marked as not created remotely"));
        } catch (error) {
          toast.error(text("核对失败", "Review failed"), errorMessage(error, text("请稍后重试", "Try again later")));
        }
      },
    });
  }

  function copyRemoteTaskId(entry: ExecutionLedgerEntry) {
    const value = entry.remoteTaskId ?? "";
    void browserRuntime.copyText(value).then(
      () => toast.success(text("已复制", "Copied"), value),
      () => toast.error(text("复制失败", "Copy failed"), text("当前环境不允许写入剪贴板。", "The current environment cannot write to the clipboard.")),
    );
  }

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardList className="h-4 w-4 text-app-muted" aria-hidden="true" />
          {text("执行台账", "Execution ledger")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={text("按结果筛选", "Filter by outcome")}
            className="h-8 text-xs"
            value={filter}
            onChange={(event) => setFilter(event.target.value as LedgerFilter)}
          >
            <option value="all">{text("全部结果", "All outcomes")}</option>
            <option value="needs-review">{text("待核对", "Needs review")}</option>
            <option value="completed">{text("已完成", "Completed")}</option>
            <option value="unknown">{text("结果未知", "Unknown result")}</option>
            <option value="local-persist-failed">{text("本地保存失败", "Local save failed")}</option>
            <option value="failed">{text("执行失败", "Failed")}</option>
            <option value="held-owner-mismatch">{text("账号不一致已挂起", "Held: owner mismatch")}</option>
          </Select>
          <Button className="h-8 px-2" type="button" variant="ghost" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" />
            {text("刷新", "Refresh")}
          </Button>
        </div>
      </div>

      {loadError ? (
        <ErrorState
          error={loadError}
          action={
            <Button variant="secondary" onClick={() => void reload()}>
              {text("重新加载", "Reload")}
            </Button>
          }
        />
      ) : null}
      {!loadError && loading ? <LoadingState /> : null}
      {!loadError && !loading && entries.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={text("暂无执行记录", "No execution records yet")}
          description={text(
            "定时任务与手动执行的每次提交都会在这里留档，远程结果不确定时会进入“待核对”。",
            "Every scheduled and manual submission is recorded here; uncertain remote results are queued for review.",
          )}
        />
      ) : null}
      {!loadError && !loading && entries.length > 0 ? (
        <>
          {pending.length > 0 ? (
            <section aria-label={text("待核对", "Needs review")} className="border-b border-app-border">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-app-border bg-app-panel/60 px-3 py-2 text-xs text-app-muted">
                <AlertTriangle className="h-3.5 w-3.5 text-app-warning" aria-hidden="true" />
                <span className="font-medium text-app-text">{text(`待核对（${pending.length}）`, `Needs review (${pending.length})`)}</span>
                <span>{text("远程可能已创建实例并在计费，不会自动重试。先查找匹配实例再确认。", "A remote instance may exist and be billing; nothing retries automatically. Find the matching instance, then confirm.")}</span>
              </div>
              <ul className="divide-y divide-app-border">
                {pending.map((entry) => {
                  const match = matches[entry.id];
                  return (
                  <li key={entry.id} className="space-y-2 px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{entry.scheduledTaskName}</span>
                      <StatePill tone={outcomeTone(entry.outcome)}>
                        {locale === "en-US" ? outcomeText[entry.outcome].en : outcomeText[entry.outcome].zh}
                      </StatePill>
                      <span className="text-xs text-app-muted">
                        {locale === "en-US" ? triggerText[entry.trigger].en : triggerText[entry.trigger].zh} · <time dateTime={entry.startedAt}>{formatLedgerTime(entry.startedAt, locale)}</time> · {entry.accountDisplayName || entry.accountKey}
                      </span>
                    </div>
                    {entry.error ? <p className="max-w-3xl text-xs text-app-danger">{entry.error}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.remoteTaskId ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-app-panel px-2 py-1 font-mono text-xs">
                          {entry.remoteTaskId}
                          <button
                            type="button"
                            className="app-interactive rounded text-app-muted hover:text-app-text"
                            title={text("复制远程任务 ID", "Copy remote task ID")}
                            aria-label={text("复制远程任务 ID", "Copy remote task ID")}
                            onClick={() => copyRemoteTaskId(entry)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ) : null}
                      <Button className="h-8 px-2" type="button" variant="secondary" disabled={match?.loading} onClick={() => void findMatches(entry)}>
                        <Search className="h-4 w-4" aria-hidden="true" />
                        {text("查找匹配实例", "Find matching instance")}
                      </Button>
                      <Button className="h-8 px-2" type="button" variant="ghost" onClick={() => confirmCreated(entry)}>
                        {text("确认已创建", "Confirm created")}
                      </Button>
                      <Button className="h-8 px-2" type="button" variant="ghost" onClick={() => confirmNotCreated(entry)}>
                        {text("确认未创建", "Confirm not created")}
                      </Button>
                    </div>
                    {match ? (
                      <div className="max-w-3xl rounded-md bg-app-panel px-3 py-2 text-xs text-app-muted" role="status">
                        {match.loading ? (
                          text("正在最近的实例中查找…", "Searching recent instances…")
                        ) : "error" in match ? (
                          <span className="text-app-danger">{match.error}</span>
                        ) : match.tasks.length === 0 ? (
                          text(
                            `最近 ${MATCH_SCAN_PAGE_SIZE} 个实例里没有以「${entry.scheduledTaskName}」开头、且在执行前后 30 分钟内创建的实例，这次执行很可能没有创建成功。`,
                            `No instance among the latest ${MATCH_SCAN_PAGE_SIZE} starts with "${entry.scheduledTaskName}" and was created within 30 minutes of this run, so it most likely was not created.`,
                          )
                        ) : (
                          <ul className="space-y-1.5">
                            {match.tasks.map((task) => (
                              <li key={String(task.id)} className="flex flex-wrap items-center gap-2">
                                <Link className="font-medium text-app-accent underline-offset-2 hover:underline" to={`/tasks/${encodeURIComponent(String(task.id))}`}>
                                  {getTaskName(task)}
                                </Link>
                                <span className="font-mono">#{task.id}</span>
                                <StatusBadge status={task.status} />
                                <span className="app-numeric">{String(task.create_time ?? task.created_at ?? "")}</span>
                                <Button className="h-7 px-2 text-xs" type="button" variant="secondary" onClick={() => confirmCreated(entry, String(task.id))}>
                                  {text("就是这个，确认已创建", "This one: confirm created")}
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          <TableRegion label={text("执行台账记录", "Execution ledger records")}>
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("时间", "Time")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("任务名", "Task")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("触发来源", "Trigger")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("账号", "Account")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("结果", "Outcome")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("远程任务 ID", "Remote task ID")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("错误摘要", "Error")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("核对状态", "Review")}</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-sm text-app-muted" colSpan={8}>
                      {text("没有匹配当前筛选的执行记录。", "No execution records match the current filter.")}
                    </td>
                  </tr>
                ) : null}
                {history.map((entry) => (
                  <tr key={entry.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">
                      <time dateTime={entry.startedAt}>{formatLedgerTime(entry.startedAt, locale)}</time>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle font-medium">{entry.scheduledTaskName}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">
                      {locale === "en-US" ? triggerText[entry.trigger].en : triggerText[entry.trigger].zh}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{entry.accountDisplayName || entry.accountKey}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <StatePill tone={outcomeTone(entry.outcome)}>
                        {locale === "en-US" ? outcomeText[entry.outcome].en : outcomeText[entry.outcome].zh}
                      </StatePill>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      {entry.remoteTaskId ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-xs">{entry.remoteTaskId}</span>
                          <button
                            type="button"
                            className="app-interactive rounded text-app-muted hover:text-app-text"
                            title={text("复制远程任务 ID", "Copy remote task ID")}
                            aria-label={text("复制远程任务 ID", "Copy remote task ID")}
                            onClick={() => copyRemoteTaskId(entry)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ) : (
                        <span className="text-app-muted">-</span>
                      )}
                    </td>
                    <td className="max-w-72 px-3 py-2 align-middle text-xs text-app-muted">
                      {entry.error ? <span className="line-clamp-2" title={entry.error}>{entry.error}</span> : "-"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      {entry.resolution ? (
                        <StatePill tone={entry.resolution.status === "confirmed-created" ? "success" : "neutral"}>
                          {entry.resolution.status === "confirmed-created" ? text("已核对：已创建", "Verified: created") : text("已核对：未创建", "Verified: not created")}
                        </StatePill>
                      ) : isPendingReview(entry) ? (
                        <StatePill tone="warning">{text("待核对", "Needs review")}</StatePill>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        </>
      ) : null}
      {confirmDialog}
    </Panel>
  );
}
