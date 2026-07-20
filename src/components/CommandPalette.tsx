import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Database,
  FileText,
  Image,
  LayoutDashboard,
  ListFilter,
  Power,
  Search,
  ScrollText,
  Server,
  Settings,
  SquareStack,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { getTaskName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { needsLogAttention } from "../lib/task-status-notifications";
import { invalidateTaskQueries } from "../lib/task-snapshot-query";
import type { Task } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";
import { Dialog, Input } from "./ui";

type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
  shortcut?: string;
  /** When true, selecting the command leaves the palette open (e.g. confirm dialog). */
  keepOpen?: boolean;
  run: () => void;
};

const REMOTE_SEARCH_DEBOUNCE_MS = 300;

function taskName(task: Task) {
  return task.name ?? task.task_name ?? task.description ?? String(task.task_id ?? task.id);
}

function isReleasableTask(task: Task) {
  return [0, 1, 2].includes(Number(task.status));
}

function buildTaskPaletteCommands(
  task: Task,
  helpers: {
    text: (zh: string, en: string) => string;
    navigate: (path: string) => void;
    onRelease: (task: Task) => void;
  },
): PaletteCommand[] {
  const name = taskName(task);
  const id = task.id;
  const open: PaletteCommand = {
    id: `task-${id}-open`,
    label: name,
    description: helpers.text("打开任务详情", "Open task detail"),
    icon: ListFilter,
    run: () => helpers.navigate(`/tasks/${id}`),
  };
  const log: PaletteCommand = {
    id: `task-${id}-log`,
    label: `${name} · ${helpers.text("日志", "Logs")}`,
    description: helpers.text("查看任务日志", "View task logs"),
    icon: FileText,
    run: () => helpers.navigate(`/tasks/${id}?tab=log`),
  };
  const terminal: PaletteCommand = {
    id: `task-${id}-terminal`,
    label: `${name} · ${helpers.text("终端", "Terminal")}`,
    description: helpers.text("打开 SSH / 连接信息", "Open SSH / connection details"),
    icon: TerminalSquare,
    run: () => helpers.navigate(`/tasks/${id}?tab=ssh`),
  };
  const release: PaletteCommand | null = isReleasableTask(task)
    ? {
        id: `task-${id}-release`,
        label: `${name} · ${helpers.text("释放", "Release")}`,
        description: helpers.text("停止实例并回收资源", "Stop the instance and reclaim resources"),
        icon: Power,
        keepOpen: true,
        run: () => helpers.onRelease(task),
      }
    : null;

  const ordered = needsLogAttention(task) ? [log, open, terminal] : [open, log, terminal];
  return release ? [...ordered, release] : ordered;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const runLogger = useRunLogger();
  const { confirm, confirmDialog } = useConfirmAction();
  const { t, text } = useI18n();
  const inputId = useId();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [debouncedTaskQuery, setDebouncedTaskQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const releaseMutation = useMutation({
    mutationFn: (task: Task) => instanceApi.operateTask(task.id),
    onSuccess: (_data, task) => {
      toast.success(text("实例释放已提交", "Instance release submitted"), getTaskName(task));
      void runLogger.log({
        source: "task",
        level: "info",
        action: "task.release",
        result: "success",
        title: text("实例释放已提交", "Instance release submitted"),
        targetName: getTaskName(task),
        targetId: task.id,
      });
      invalidateTaskQueries(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["command-palette"] });
      onClose();
    },
    onError: (error, task) => {
      toast.error(
        text("实例释放失败", "Instance release failed"),
        `${getTaskName(task)}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`,
      );
      void runLogger.log({
        source: "task",
        level: "error",
        action: "task.release",
        result: "failure",
        title: text("实例释放失败", "Instance release failed"),
        targetName: getTaskName(task),
        targetId: task.id,
        error: errorMessage(error, text("实例释放失败", "Instance release failed")),
      });
    },
  });

  const staticCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: "dashboard", label: t("nav.dashboard"), description: "/dashboard", icon: LayoutDashboard, shortcut: "g d", run: () => navigate("/dashboard") },
      { id: "tasks", label: t("nav.tasks"), description: "/tasks", icon: Server, shortcut: "g t", run: () => navigate("/tasks") },
      { id: "scheduled", label: t("nav.scheduledTasks"), description: "/scheduled-tasks", icon: CalendarClock, shortcut: "g c", run: () => navigate("/scheduled-tasks") },
      { id: "templates", label: t("nav.taskTemplates"), description: "/task-templates", icon: SquareStack, shortcut: "g m", run: () => navigate("/task-templates") },
      { id: "storage", label: t("nav.storage"), description: "/storage", icon: Database, shortcut: "g s", run: () => navigate("/storage") },
      { id: "images", label: t("nav.images"), description: "/images", icon: Image, shortcut: "g i", run: () => navigate("/images") },
      { id: "logs", label: t("nav.runLogs"), description: "/run-logs", icon: ScrollText, shortcut: "g r", run: () => navigate("/run-logs") },
      { id: "settings", label: t("nav.settings"), description: "/settings", icon: Settings, shortcut: "g e", run: () => navigate("/settings") },
    ],
    [navigate, t],
  );

  const normalizedQuery = query.trim().toLowerCase();
  useEffect(() => {
    if (!open || normalizedQuery.length < 2) {
      setDebouncedTaskQuery("");
      return undefined;
    }

    const timer = window.setTimeout(() => setDebouncedTaskQuery(normalizedQuery), REMOTE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open]);

  const taskQuery = useQuery({
    enabled: open && debouncedTaskQuery.length >= 2,
    queryKey: ["command-palette", "tasks", debouncedTaskQuery],
    queryFn: () => instanceApi.tasks({ page: 1, page_size: 50, keyword: debouncedTaskQuery }),
  });

  const onRelease = useCallback(
    (task: Task) => {
      confirm({
        title: text("确认释放实例", "Confirm Instance Release"),
        description: text(
          `将释放 ${getTaskName(task)}。释放会停止实例并回收计算资源；适用于运行中/排队等可释放状态。此操作不可从 EasyConsole 撤销。`,
          `Release ${getTaskName(task)}. Release stops the instance and reclaims compute resources; use it for releasable states (running, queued, etc.). EasyConsole cannot undo this.`,
        ),
        confirmLabel: text("释放", "Release"),
        tone: "danger",
        run: () => releaseMutation.mutateAsync(task),
      });
    },
    [confirm, releaseMutation, text],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const filtered = staticCommands.filter((command) => {
      if (!normalizedQuery) return true;
      return `${command.label} ${command.description}`.toLowerCase().includes(normalizedQuery);
    });
    const taskCommands = (taskQuery.data?.items ?? []).flatMap((task) =>
      buildTaskPaletteCommands(task, { text, navigate, onRelease }),
    );
    return [...filtered, ...taskCommands];
  }, [navigate, normalizedQuery, onRelease, staticCommands, taskQuery.data?.items, text]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebouncedTaskQuery("");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery]);

  useEffect(() => {
    setActiveIndex((index) => (commands.length === 0 ? 0 : Math.min(index, commands.length - 1)));
  }, [commands.length]);

  function runCommand(command: PaletteCommand) {
    command.run();
    if (!command.keepOpen) onClose();
  }

  function runActive() {
    const command = commands[activeIndex];
    if (!command) return;
    runCommand(command);
  }

  const activeOptionId = commands[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <>
      <Dialog open={open} title={text("命令面板", "Command Palette")} onClose={onClose} width="max-w-2xl">
        <div
          className="p-3"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, Math.max(commands.length - 1, 0)));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            }
            if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(Math.max(commands.length - 1, 0));
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              runActive();
            }
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input
              id={inputId}
              autoFocus
              className="w-full pl-9"
              value={query}
              placeholder={text("搜索页面、任务或操作", "Search pages, tasks, or actions")}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={open}
              aria-activedescendant={activeOptionId}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div
            id={listboxId}
            className="mt-3 max-h-[55vh] overflow-auto rounded-md border border-app-border"
            role="listbox"
            aria-label={text("命令结果", "Command results")}
            aria-busy={taskQuery.isFetching}
          >
            {commands.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-app-muted" role="status">
                {text("没有匹配的命令", "No matching commands")}
              </div>
            ) : (
              commands.map((command, index) => (
                <div
                  key={command.id}
                  id={`${listboxId}-option-${index}`}
                  className={`flex w-full cursor-pointer select-none items-center gap-3 border-b border-app-border px-3 py-2 text-left text-sm last:border-0 ${index === activeIndex ? "bg-app-accentSoft text-app-accent" : "hover:bg-app-panel"}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runCommand(command)}
                >
                  <command.icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{command.label}</span>
                    <span className="block truncate text-xs text-app-muted">{command.description}</span>
                  </span>
                  {command.shortcut ? (
                    <kbd className="shrink-0 rounded border border-app-border bg-app-panel px-1.5 py-0.5 font-mono text-[10px] text-app-muted">
                      {command.shortcut}
                    </kbd>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </Dialog>
      {confirmDialog}
    </>
  );
}
