import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Copy, RefreshCw, WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ErrorState, LoadingState } from "../DataState";
import { Button, Drawer, Input } from "../ui";
import { instanceApi } from "../../lib/api";
import { getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { browserRuntime } from "../../lib/runtime";
import type { Task } from "../../lib/types";
import { useToast } from "../../lib/use-toast";
import { cn } from "../../lib/utils";

const LONG_LOG_CHARS = 200_000;
const MAX_LOG_DISPLAY_CHARS = 500_000;
const FOLLOW_BOTTOM_THRESHOLD_PX = 48;
const FILTER_DEBOUNCE_MS = 200;

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

export function TaskLogDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { text } = useI18n();
  const toast = useToast();
  const [wrapLines, setWrapLines] = useState(false);
  const [followBottom, setFollowBottom] = useState(true);
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollRef = useRef(false);
  const query = useQuery({
    queryKey: ["task-log", task?.task_id ?? task?.id],
    queryFn: () => instanceApi.taskLog(task!),
    enabled: Boolean(task),
  });

  const rawLog = query.data ?? "";
  const emptyLabel = text("暂无日志输出", "No log output");
  const canCopy = Boolean(query.data) && !query.isLoading && !query.isError;
  const normalizedFilter = debouncedFilter.trim().toLowerCase();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedFilter(filter), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filter]);

  const filtered = useMemo(() => {
    if (!rawLog) return { text: emptyLabel, matchCount: 0, filtered: false };
    if (!normalizedFilter) return { text: rawLog, matchCount: 0, filtered: false };
    const lines = rawLog.split("\n").filter((line) => line.toLowerCase().includes(normalizedFilter));
    if (lines.length === 0) {
      return { text: text("无匹配日志行", "No matching log lines"), matchCount: 0, filtered: true };
    }
    return { text: lines.join("\n"), matchCount: lines.length, filtered: true };
  }, [emptyLabel, normalizedFilter, rawLog, text]);

  const display = useMemo(() => truncateLogForDisplay(filtered.text, MAX_LOG_DISPLAY_CHARS), [filtered.text]);
  const displayText = display.text;

  const filterStatus = useMemo(() => {
    if (!normalizedFilter) return "";
    if (!rawLog) return "";
    if (filtered.matchCount === 0) return text("无匹配日志行", "No matching log lines");
    return text(`${filtered.matchCount} 行匹配`, `${filtered.matchCount} matching lines`);
  }, [filtered.matchCount, normalizedFilter, rawLog, text]);

  useEffect(() => {
    if (!followBottom || !scrollRef.current) return;
    programmaticScrollRef.current = true;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    const frame = window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayText, followBottom, query.dataUpdatedAt]);

  useEffect(() => {
    if (!task) {
      setFilter("");
      setDebouncedFilter("");
      setFollowBottom(true);
      setWrapLines(false);
    }
  }, [task]);

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
      .copyText(query.data!)
      .then(() => toast.success(text("已复制", "Copied"), text("任务日志", "Task log")))
      .catch(() => toast.error(text("复制失败", "Copy failed"), text("当前浏览器不允许写入剪贴板", "The current browser does not allow clipboard writes")));
  };

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
    <Drawer
      open={Boolean(task)}
      title={text(`任务日志 ${task ? getTaskName(task) : ""}`, `Task Log ${task ? getTaskName(task) : ""}`)}
      onClose={onClose}
      width="max-w-5xl"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-3 py-2">
          <Button
            className="h-8 px-2"
            disabled={query.isFetching}
            type="button"
            variant="secondary"
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} />
            {text("刷新", "Refresh")}
          </Button>
          <Button className="h-8 px-2" disabled={!canCopy} type="button" variant="secondary" onClick={copyAll}>
            <Copy className="h-4 w-4" aria-hidden="true" />
            {text("复制全部", "Copy all")}
          </Button>
          <Button
            aria-pressed={wrapLines}
            className={cn("h-8 px-2", wrapLines && "border-app-accent/40 text-app-accent")}
            type="button"
            variant="secondary"
            onClick={() => setWrapLines((value) => !value)}
          >
            <WrapText className="h-4 w-4" aria-hidden="true" />
            {text("自动换行", "Wrap lines")}
          </Button>
          <Button
            aria-pressed={followBottom}
            className={cn("h-8 px-2", followBottom && "border-app-accent/40 text-app-accent")}
            type="button"
            variant="secondary"
            onClick={() => setFollowBottom((value) => !value)}
          >
            <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
            {text("跟随底部", "Follow bottom")}
          </Button>
          <Input
            aria-label={text("查找日志", "Search logs")}
            className="h-8 w-full min-w-[10rem] flex-1 sm:max-w-xs"
            placeholder={text("查找…", "Find…")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {filterStatus ? (
            <span className="text-xs text-app-muted" aria-live="polite">
              {filterStatus}
            </span>
          ) : null}
        </div>
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
                <Button disabled={query.isFetching} type="button" variant="secondary" onClick={() => void query.refetch()}>
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
              {displayText}
            </pre>
          )}
        </div>
      </div>
    </Drawer>
  );
}
