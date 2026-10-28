import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, Crosshair, ListFilter, RefreshCw, WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, memo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { ErrorState, LoadingState } from "../DataState";
import { Button, Input } from "../ui";
import { useI18n } from "../../lib/i18n";
import { browserRuntime } from "../../lib/runtime";
import { FAILURE_STATUSES } from "../../lib/task-status-notifications";
import { taskLogQueryOptions } from "../../lib/task-log-query";
import type { Task } from "../../lib/types";
import { useCompactLayout } from "../../lib/use-compact-layout";
import { useToast } from "../../lib/use-toast";
import { cn } from "../../lib/utils";
import { RelativeUpdatedAt } from "../RelativeUpdatedAt";

const LONG_LOG_CHARS = 200_000;
/**
 * Render cap for the log body: only the tail is rendered (copy still uses the
 * full log). Aligned with LONG_LOG_CHARS so the "long log" hint and the
 * truncation cutoff describe the same magnitude.
 */
const MAX_LOG_DISPLAY_CHARS = 200_000;
const FOLLOW_BOTTOM_THRESHOLD_PX = 48;
const FILTER_DEBOUNCE_MS = 200;

/** Lines that read as a failure: tracebacks, exceptions, fatal signals, OOM, non-zero exits. */
const ERROR_LINE_PATTERN = /traceback \(most recent call last\)|\b(?:error|exception|fatal|panic|killed|segmentation fault)\b|out of memory|exit(?:ed)? (?:with )?(?:code|status) [1-9]/i;
/** The line that names the failure, e.g. `torch.OutOfMemoryError: CUDA out of memory`. */
const EXCEPTION_LINE_PATTERN = /^\s*[\w.]*(?:Error|Exception|Interrupt)\b:?/;
const EXIT_CODE_PATTERN = /exit(?:ed)? (?:with )?(?:code|status) (\d+)/i;

function truncateLogForDisplay(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return { text: value, truncated: false, totalChars: value.length, displayedChars: value.length };
  }
  return {
    text: value.slice(value.length - maxChars),
    truncated: true,
    totalChars: value.length,
    displayedChars: maxChars,
  };
}

/** The failure a reader wants first: the last exception line (else the last error-looking line) and any exit code. */
function findFailureSummary(lines: string[], errorLines: Set<number>) {
  let exceptionIndex = -1;
  let lastErrorIndex = -1;
  let exitCode: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!errorLines.has(index)) continue;
    if (lastErrorIndex < 0) lastErrorIndex = index;
    if (exitCode === null) exitCode = EXIT_CODE_PATTERN.exec(lines[index])?.[1] ?? null;
    if (exceptionIndex < 0 && EXCEPTION_LINE_PATTERN.test(lines[index])) exceptionIndex = index;
    if (exceptionIndex >= 0 && exitCode !== null) break;
  }
  const index = exceptionIndex >= 0 ? exceptionIndex : lastErrorIndex;
  return index >= 0 ? { index, line: lines[index].trim(), exitCode } : null;
}

/**
 * Memoized log body. A live poll re-renders the panel even when the
 * fetched text is unchanged; with plain rendering that reconciles thousands of
 * line spans every poll. All props come from memos over the log text, so an
 * unchanged poll keeps every prop identity and skips this subtree entirely.
 */
const LogLines = memo(function LogLines({
  lines,
  errorLines,
  matchSet,
  visibleLineIndexes,
  currentMatch,
  focusedLine,
}: {
  lines: string[];
  errorLines: Set<number>;
  matchSet: Set<number>;
  visibleLineIndexes: number[] | null;
  currentMatch: number | null;
  focusedLine: number | null;
}) {
  const renderLine = (index: number) => {
    const line = lines[index];
    const isError = errorLines.has(index);
    return (
      <span
        key={index}
        data-log-line={index}
        className={cn(
          "block",
          isError && "bg-app-danger/25",
          matchSet.has(index) && "bg-app-terminalAccent/20",
          (index === currentMatch || index === focusedLine) && "bg-app-terminalAccent/35 outline outline-1 -outline-offset-1 outline-app-terminalAccent",
        )}
      >
        {line || " "}
      </span>
    );
  };

  return (
    <>
      {visibleLineIndexes ? visibleLineIndexes.map(renderLine) : lines.map((_, index) => renderLine(index))}
    </>
  );
});

/** `toolbarEnd` sits at the right end of the toolbar, e.g. the detail page's expand action. */
export function TaskLogPanel({ task, toolbarEnd }: { task: Task; toolbarEnd?: ReactNode }) {
  const { locale, text } = useI18n();
  const toast = useToast();
  const compactLayout = useCompactLayout();
  // A phone-width log is unreadable unwrapped, whether or not it runs in the native app.
  const [wrapLines, setWrapLines] = useState(() => compactLayout);
  const [followBottom, setFollowBottom] = useState(true);
  const [findInput, setFindInput] = useState("");
  const [debouncedFind, setDebouncedFind] = useState("");
  // Find highlights matches in place by default, so the traceback around a hit stays readable.
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [matchCursor, setMatchCursor] = useState(0);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollRef = useRef(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  // Only a running task still writes to its log; following one turns the panel into a feed.
  const live = followBottom && Number(task.status) === 2;
  const failedTask = FAILURE_STATUSES.has(Number(task.status));
  const query = useQuery(taskLogQueryOptions(task, live));

  const refreshNow = () => {
    setManualRefreshing(true);
    void query.refetch().finally(() => setManualRefreshing(false));
  };

  const rawLog = query.data?.text ?? "";
  const canCopy = Boolean(rawLog) && !query.isLoading && !query.isError;
  const normalizedFind = debouncedFind.trim().toLowerCase();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedFind(findInput);
      setMatchCursor(0);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [findInput]);

  const display = useMemo(() => truncateLogForDisplay(rawLog, MAX_LOG_DISPLAY_CHARS), [rawLog]);

  const analysis = useMemo(() => {
    const lines = display.text ? display.text.split("\n") : [];
    const errorLines = new Set<number>();
    const matchLines: number[] = [];
    lines.forEach((line, index) => {
      if (ERROR_LINE_PATTERN.test(line)) errorLines.add(index);
      if (normalizedFind && line.toLowerCase().includes(normalizedFind)) matchLines.push(index);
    });
    return { lines, errorLines, matchLines, failure: findFailureSummary(lines, errorLines) };
  }, [display.text, normalizedFind]);

  const { lines, errorLines, matchLines, failure } = analysis;
  const matchSet = useMemo(() => new Set(matchLines), [matchLines]);
  const currentMatch = matchLines.length > 0 ? matchLines[Math.min(matchCursor, matchLines.length - 1)] : null;
  const filtering = onlyMatches && Boolean(normalizedFind);
  // Memoized so LogLines receives a stable identity when the log text is unchanged.
  const visibleLineIndexes = useMemo(() => (filtering ? matchLines : null), [filtering, matchLines]);

  const scrollToLine = (index: number) => {
    setFollowBottom(false);
    setFocusedLine(index);
    window.requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-log-line="${index}"]`)?.scrollIntoView({ block: "center" });
    });
  };

  const stepMatch = (delta: 1 | -1) => {
    if (matchLines.length === 0) return;
    const next = (Math.min(matchCursor, matchLines.length - 1) + delta + matchLines.length) % matchLines.length;
    setMatchCursor(next);
    scrollToLine(matchLines[next]);
  };

  const onFindKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    stepMatch(event.shiftKey ? -1 : 1);
  };

  const findStatus = !normalizedFind || !rawLog
    ? ""
    : matchLines.length === 0
      ? text("无匹配", "No matches")
      : text(`第 ${Math.min(matchCursor, matchLines.length - 1) + 1} / ${matchLines.length} 处`, `${Math.min(matchCursor, matchLines.length - 1) + 1} of ${matchLines.length}`);

  useEffect(() => {
    if (!followBottom || !scrollRef.current) return;
    programmaticScrollRef.current = true;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    const frame = window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [display.text, followBottom, query.dataUpdatedAt]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element || programmaticScrollRef.current || !followBottom) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom > FOLLOW_BOTTOM_THRESHOLD_PX) {
      setFollowBottom(false);
    }
  };

  const copyAll = () => {
    if (!canCopy) return;
    void browserRuntime
      .copyText(rawLog)
      .then(() => toast.success(text("已复制", "Copied"), text("任务日志", "Task log")))
      .catch(() => toast.error(text("复制失败", "Copy failed"), text("当前浏览器不允许写入剪贴板", "The current browser does not allow clipboard writes")));
  };

  const updatedAt = query.dataUpdatedAt;
  // Phones keep the dot and the age; the words stay for screen readers.
  const updatedLabel = updatedAt ? (
    <>
      <span className="max-sm:sr-only">
        {live ? `${text("实时跟随", "Live")} · ` : ""}
        {text("更新于 ", "updated ")}
      </span>
      <RelativeUpdatedAt updatedAt={updatedAt} intervalMs={live ? 1_000 : 10_000} />
    </>
  ) : null;

  const charCount = rawLog.length;
  const showLongHint = display.truncated || charCount >= LONG_LOG_CHARS;
  const longHint = display.truncated
    ? text(
        `日志已截断展示：共 ${display.totalChars.toLocaleString()} 字符，显示末尾 ${display.displayedChars.toLocaleString()} 字符；复制仍为全文`,
        `Log display truncated: ${display.totalChars.toLocaleString()} characters total, showing last ${display.displayedChars.toLocaleString()}; copy still uses the full log`,
      )
    : text(
        `日志较长（约 ${charCount.toLocaleString()} 字符），已全部加载`,
        `Long log (~${charCount.toLocaleString()} characters), fully loaded`,
      );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">
        <Button
          className="h-8 px-2"
          disabled={manualRefreshing}
          type="button"
          variant="secondary"
          onClick={refreshNow}
        >
          <RefreshCw className={cn("h-4 w-4", manualRefreshing && "animate-spin")} aria-hidden="true" />
          <span className="max-sm:sr-only">{text("刷新", "Refresh")}</span>
        </Button>
        <Button className="h-8 px-2" disabled={!canCopy} type="button" variant="secondary" onClick={copyAll}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{text("复制全部", "Copy all")}</span>
        </Button>
        <Button
          aria-pressed={wrapLines}
          className={cn("h-8 px-2", wrapLines && "border-app-accent/40 text-app-accent")}
          type="button"
          variant="secondary"
          onClick={() => setWrapLines((value) => !value)}
        >
          <WrapText className="h-4 w-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{text("自动换行", "Wrap lines")}</span>
        </Button>
        <Button
          aria-pressed={followBottom}
          className={cn("h-8 px-2", followBottom && "border-app-accent/40 text-app-accent")}
          type="button"
          variant="secondary"
          title={Number(task.status) === 2
            ? text("跟随底部时每 6–60 秒读取日志全文；无变化或日志较大时降低频率", "While following, full logs are read every 6–60 seconds; idle or large logs are polled less often")
            : text("实例未在运行，日志不再更新", "The instance is not running, so its log no longer changes")}
          onClick={() => {
            setFocusedLine(null);
            setFollowBottom((value) => !value);
          }}
        >
          <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{text("跟随底部", "Follow bottom")}</span>
        </Button>
        {/* On phones search takes the first row to itself and the view toggles share the second. */}
        <div className="flex min-w-[12rem] flex-1 items-center gap-1 max-sm:order-first max-sm:basis-full sm:max-w-sm">
          <Input
            aria-label={text("查找日志", "Search logs")}
            className="h-8 min-w-0 flex-1"
            placeholder={compactLayout ? text("查找日志", "Find in log") : text("查找…（Enter 下一处）", "Find… (Enter for next)")}
            value={findInput}
            onChange={(event) => setFindInput(event.target.value)}
            onKeyDown={onFindKeyDown}
          />
          <Button aria-label={text("上一处", "Previous match")} className="h-8 w-8 px-0" disabled={matchLines.length === 0} title={text("上一处（Shift+Enter）", "Previous (Shift+Enter)")} type="button" variant="ghost" onClick={() => stepMatch(-1)}>
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button aria-label={text("下一处", "Next match")} className="h-8 w-8 px-0" disabled={matchLines.length === 0} title={text("下一处（Enter）", "Next (Enter)")} type="button" variant="ghost" onClick={() => stepMatch(1)}>
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            aria-label={text("只显示匹配行", "Show matching lines only")}
            aria-pressed={onlyMatches}
            className={cn("h-8 w-8 px-0", onlyMatches && "text-app-accent")}
            title={text("只显示匹配行", "Show matching lines only")}
            type="button"
            variant="ghost"
            onClick={() => setOnlyMatches((value) => !value)}
          >
            <ListFilter className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {findStatus ? (
          <span className="app-numeric whitespace-nowrap text-xs text-app-muted" aria-live="polite">
            {findStatus}
          </span>
        ) : null}
        {updatedLabel || toolbarEnd ? (
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {updatedLabel ? (
              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-app-muted" title={updatedAt ? new Date(updatedAt).toLocaleString(locale) : undefined}>
                {live ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-app-info" /> : null}
                {updatedLabel}
              </span>
            ) : null}
            {toolbarEnd}
          </div>
        ) : null}
      </div>
      {failedTask && failure ? (
        <div className="flex min-w-0 items-center gap-2 border-b border-app-border bg-app-dangerSoft px-3 py-1.5 text-xs text-app-danger">
          <span className="shrink-0 font-medium">{text("失败原因", "Failure")}</span>
          <span className="min-w-0 flex-1 truncate font-mono" title={failure.line}>{failure.line}</span>
          {failure.exitCode ? <span className="app-numeric shrink-0">{text(`退出码 ${failure.exitCode}`, `exit code ${failure.exitCode}`)}</span> : null}
          <Button className="h-7 shrink-0 px-2 text-xs" type="button" variant="ghost" onClick={() => scrollToLine(failure.index)}>
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {text("定位", "Jump to line")}
          </Button>
        </div>
      ) : null}
      {showLongHint ? (
        <div className="border-b border-app-border bg-app-panel px-3 py-1.5 text-xs text-app-muted">
          {longHint}
        </div>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={handleScroll}>
        {query.isLoading ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState
            error={query.error}
            action={
              <Button disabled={query.isFetching} type="button" variant="secondary" onClick={refreshNow}>
                {text("重试", "Retry")}
              </Button>
            }
          />
        ) : (
          <pre
            className={cn(
              "min-h-full bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText",
              wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto",
            )}
          >
            {!rawLog
              ? text("暂无日志输出", "No log output")
              : filtering && matchLines.length === 0
                ? text("无匹配日志行", "No matching log lines")
                : (
                  <LogLines
                    currentMatch={currentMatch}
                    errorLines={errorLines}
                    focusedLine={focusedLine}
                    lines={lines}
                    matchSet={matchSet}
                    visibleLineIndexes={visibleLineIndexes}
                  />
                )}
          </pre>
        )}
      </div>
    </div>
  );
}
