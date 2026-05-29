import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ActivitySquare,
  Braces,
  Copy,
  Download,
  FileText,
  MoreHorizontal,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { EmptyState, ErrorState, TableSkeleton } from "../components/DataState";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { StatusBadge } from "../components/StatusBadge";
import { CreateTaskDialog } from "../components/tasks/CreateTaskDialog";
import { TaskLogDialog } from "../components/tasks/TaskLogDialog";
import { Button, Dialog, Input, Panel, Select, TableRegion } from "../components/ui";
import { imageApi, instanceApi } from "../lib/api";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../lib/batch";
import { useDownloadQueue } from "../lib/download-queue-context";
import { asJson, formatSecondsDuration, getTaskName, taskStatusText, taskStatusTextEn } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { i18nText } from "../lib/i18n-text";
import { openMonitorDashboard } from "../lib/monitor-dashboard";
import { browserRuntime } from "../lib/runtime";
import { filterAndSortTasks } from "../lib/task-search";
import { createTaskTemplate, loadTaskTemplates, saveTaskTemplates, taskToEditableTaskTemplate } from "../lib/task-templates";
import {
  parseTaskListQuery,
  serializeTaskListQuery,
  TASK_PAGE_SIZE_OPTIONS,
  taskMatchesQuery,
  toTaskApiQuery,
  type TaskListQueryState,
} from "../lib/task-list-query";
import type { Task } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

const columnHelper = createColumnHelper<Task>();
const TerminalDialog = lazy(() => import("../components/tasks/TerminalDialog").then((module) => ({ default: module.TerminalDialog })));
const COLUMN_VISIBILITY_KEY = "easy-console.tasks.columnVisibility";
const AUTO_REFRESH_KEY = "easy-console.tasks.autoRefresh";
const AUTO_REFRESH_INTERVAL_KEY = "easy-console.tasks.autoRefreshInterval";
const DEFAULT_AUTO_REFRESH_INTERVAL = 10_000;
const autoRefreshOptions = [
  { zh: "5 秒", en: "5 sec", value: 5_000 },
  { zh: "10 秒", en: "10 sec", value: 10_000 },
  { zh: "30 秒", en: "30 sec", value: 30_000 },
];
const ALWAYS_VISIBLE_COLUMNS = new Set(["select", "actions"]);
const defaultColumnVisibility: VisibilityState = {
  node: false,
  endpoint: false,
  owner: false,
  group: false,
  duration: false,
  release: false,
  deleted: false,
};
const columnLabels: Record<string, { zh: string; en: string }> = {
  name: { zh: "实例名称", en: "Instance name" },
  status: { zh: "状态", en: "Status" },
  resource: { zh: "资源", en: "Resources" },
  node: { zh: "节点", en: "Node" },
  endpoint: { zh: "入口", en: "Endpoint" },
  owner: { zh: "用户", en: "User" },
  group: { zh: "用户组", en: "User group" },
  duration: { zh: "时长", en: "Duration" },
  created: { zh: "创建时间", en: "Created" },
  release: { zh: "释放时间", en: "Release time" },
  releaseCondition: { zh: "释放条件", en: "Release condition" },
  deleted: { zh: "删除状态", en: "Delete status" },
};
const ACTION_GRID_CLASS = "grid grid-cols-[2rem_2rem_2rem_2rem_5rem_2rem] items-center gap-1";
const commitPodFields = ["description", "pod_name", "podName", "pod", "k8s_pod_name", "k8sPodName"];

function resourceText(task: Task) {
  return `${task.cpu ?? "-"}C / ${task.gpu ?? "-"}GPU / ${task.memory ?? "-"}G`;
}

function endpointText(task: Task) {
  if (Number(task.status) !== 2) return "-";
  return task.ip && task.ip !== "None" ? task.ip : "-";
}

function displayText(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "-";
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function getTaskCommitPodName(task: Task) {
  return firstText(...commitPodFields.map((field) => task[field]));
}

function getTaskCommitUser(task: Task) {
  if (task.user && typeof task.user === "object") return task.user;
  return firstText(task.username, task.ssh_username, task.ssh_user, task.login_user);
}

function buildTaskCommitPayload(task: Task) {
  const podName = getTaskCommitPodName(task);
  if (!podName) throw new Error(i18nText("后端未返回 pod 标识，无法 Commit。请刷新实例列表或查看原始 JSON。", "The backend did not return a pod identifier, so Commit cannot continue. Refresh the instance list or inspect the raw JSON."));
  const user = getTaskCommitUser(task);
  if (!user) throw new Error(i18nText("后端未返回用户信息，无法 Commit。请刷新实例列表或查看原始 JSON。", "The backend did not return user information, so Commit cannot continue. Refresh the instance list or inspect the raw JSON."));
  return { user, pod_name: podName };
}

function userRecord(task: Task) {
  return task.user && typeof task.user === "object" ? task.user : undefined;
}

function ownerText(task: Task) {
  const user = userRecord(task);
  return displayText(task.username ?? user?.username ?? user?.name ?? task.user);
}

function groupText(task: Task) {
  const user = userRecord(task);
  return displayText(task.user_group ?? task.user_group_name ?? task.group_name ?? user?.user_group ?? user?.group_name);
}

function taskRowId(task: Task) {
  return String(task.task_id ?? task.id);
}

function isRunningTask(task: Task) {
  return Number(task.status) === 2;
}

function isReleasableTask(task: Task) {
  return [0, 1, 2].includes(Number(task.status));
}

function isActionsColumn(id: string) {
  return id === "actions";
}

function ActionHeader() {
  const { text } = useI18n();
  return (
    <div className={`${ACTION_GRID_CLASS} text-center text-xs text-app-muted`}>
      <span>{text("监控", "Monitor")}</span>
      <span>{text("日志", "Logs")}</span>
      <span>{text("终端", "Terminal")}</span>
      <span>{text("复制", "Copy")}</span>
      <span>{text("释放/删除", "Release/Delete")}</span>
      <span>{text("更多", "More")}</span>
    </div>
  );
}

function loadColumnVisibility(): VisibilityState {
  try {
    const raw = window.localStorage.getItem(COLUMN_VISIBILITY_KEY);
    if (!raw) return defaultColumnVisibility;
    const parsed = JSON.parse(raw) as VisibilityState;
    delete parsed.actions;
    delete parsed.select;
    if ("cost" in parsed) {
      parsed.duration = parsed.duration ?? parsed.cost;
      delete parsed.cost;
    }
    if (Object.keys(parsed).length === 0) return defaultColumnVisibility;
    if (!("release" in parsed)) {
      return {
        ...defaultColumnVisibility,
        ...parsed,
        node: false,
        created: true,
        release: false,
      };
    }
    return parsed;
  } catch {
    return defaultColumnVisibility;
  }
}

function loadBooleanSetting(key: string, fallback = false) {
  try {
    return window.localStorage.getItem(key) === "true" || fallback;
  } catch {
    return fallback;
  }
}

function loadNumberSetting(key: string, fallback: number) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function taskQueryKey(state: TaskListQueryState) {
  return [
    "tasks",
    state.page,
    state.pageSize,
    state.keyword,
    state.status,
  ];
}

export function MoreActionsMenu({
  task,
  onRaw,
  onDownload,
  onCommit,
  onSaveTemplate,
}: {
  task: Task;
  onRaw: (task: Task) => void;
  onDownload: (task: Task) => void;
  onCommit: (task: Task) => void;
  onSaveTemplate: (task: Task) => void;
}) {
  const { text } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialFocusIndexRef = useRef(0);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerButtonRef.current?.focus(), 0);
  }, []);

  const focusMenuItem = useCallback((index: number) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    const nextIndex = (index + items.length) % items.length;
    items[nextIndex].focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const width = 160;
      const estimatedHeight = 112;
      const margin = 8;
      const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
      const top =
        rect.bottom + estimatedHeight + margin > window.innerHeight ? rect.top - estimatedHeight - 4 : rect.bottom + 4;

      setMenuPosition({ left, top: Math.max(margin, top) });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeMenu(true);
      }
    };
    const handleScroll = () => closeMenu();

    updatePosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open || !menuPosition) return;
    window.setTimeout(() => focusMenuItem(initialFocusIndexRef.current), 0);
  }, [focusMenuItem, menuPosition, open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    initialFocusIndexRef.current = event.key === "ArrowUp" ? -1 : 0;
    setOpen(true);
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    const currentIndex = items.findIndex((item) => item === document.activeElement);

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }

    if (event.key === "Tab") {
      closeMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(currentIndex + 1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(currentIndex - 1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(items.length - 1);
    }
  };

  return (
    <div ref={triggerRef} className="relative z-30">
      <Button
        ref={triggerButtonRef}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={text(`更多操作 ${getTaskName(task)}`, `More actions for ${getTaskName(task)}`)}
        className="h-8 w-8 px-0"
        title={text("更多", "More")}
        type="button"
        variant="ghost"
        onClick={() => {
          initialFocusIndexRef.current = 0;
          setOpen((value) => !value);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && menuPosition
        ? createPortal(
          <div
            id={menuId}
            ref={menuRef}
            className="fixed z-[100] w-40 rounded-md border border-app-border bg-app-surface p-1 shadow-popover"
            role="menu"
            aria-label={text(`实例操作 ${getTaskName(task)}`, `Instance actions for ${getTaskName(task)}`)}
            style={{ left: menuPosition.left, top: menuPosition.top }}
            onKeyDown={handleMenuKeyDown}
          >
            <button
              ref={(element) => {
                menuItemRefs.current[0] = element;
              }}
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel"
              role="menuitem"
              tabIndex={-1}
              type="button"
              onClick={() => {
                closeMenu();
                onDownload(task);
              }}
            >
              <Download className="h-4 w-4 text-app-muted" />
              {text("下载", "Download")}
            </button>
            <button
              ref={(element) => {
                menuItemRefs.current[1] = element;
              }}
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!isRunningTask(task)}
              role="menuitem"
              tabIndex={-1}
              title={isRunningTask(task) ? "Commit" : text("仅运行中实例可 Commit", "Only running instances can be committed")}
              type="button"
              onClick={() => {
                closeMenu();
                onCommit(task);
              }}
            >
              <Upload className="h-4 w-4 text-app-muted" />
              Commit
            </button>
            <button
              ref={(element) => {
                menuItemRefs.current[2] = element;
              }}
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel"
              role="menuitem"
              tabIndex={-1}
              type="button"
              onClick={() => {
                closeMenu();
                onSaveTemplate(task);
              }}
            >
              <Save className="h-4 w-4 text-app-muted" />
              {text("存为模板", "Save as template")}
            </button>
            <button
              ref={(element) => {
                menuItemRefs.current[3] = element;
              }}
              className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel"
              role="menuitem"
              tabIndex={-1}
              type="button"
              onClick={() => {
                closeMenu();
                onRaw(task);
              }}
            >
              <Braces className="h-4 w-4 text-app-muted" />
              {text("原始 JSON", "Raw JSON")}
            </button>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

export function TasksPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const downloadQueue = useDownloadQueue();
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = useMemo(() => parseTaskListQuery(searchParams), [searchParams]);
  const { confirm, confirmDialog } = useConfirmAction();
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneTask, setCloneTask] = useState<Task | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);
  const [terminalTask, setTerminalTask] = useState<Task | null>(null);
  const [rawTask, setRawTask] = useState<Task | null>(null);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => loadColumnVisibility());
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [autoRefresh, setAutoRefresh] = useState(() => loadBooleanSetting(AUTO_REFRESH_KEY));
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(() =>
    loadNumberSetting(AUTO_REFRESH_INTERVAL_KEY, DEFAULT_AUTO_REFRESH_INTERVAL),
  );

  const updateTaskQuery = useCallback((patch: Partial<TaskListQueryState>) => {
    const next = { ...queryState, ...patch };
    if (!("page" in patch)) next.page = 1;
    setSearchParams(serializeTaskListQuery(next), { replace: true });
  }, [queryState, setSearchParams]);

  const deleteMutation = useMutation({
    mutationFn: (task: Task) => instanceApi.deleteTask(task.id),
    onSuccess: (_data, task) => {
      toast.success(text("实例删除已提交", "Instance deletion submitted"), getTaskName(task));
      void runLogger.log({
        source: "task",
        level: "info",
        action: "task.delete",
        result: "success",
        title: text("实例删除已提交", "Instance deletion submitted"),
        targetName: getTaskName(task),
        targetId: task.id,
      });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error, task) => {
      toast.error(text("实例删除失败", "Instance deletion failed"), `${getTaskName(task)}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
      void runLogger.log({
        source: "task",
        level: "error",
        action: "task.delete",
        result: "failure",
        title: text("实例删除失败", "Instance deletion failed"),
        targetName: getTaskName(task),
        targetId: task.id,
        error: errorMessage(error, text("实例删除失败", "Instance deletion failed")),
      });
    },
  });

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
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error, task) => {
      toast.error(text("实例释放失败", "Instance release failed"), `${getTaskName(task)}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
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

  const commitMutation = useMutation({
    mutationFn: (task: Task) => imageApi.commitImage(buildTaskCommitPayload(task)),
    onSuccess: (_data, task) => {
      toast.success(text("Commit 已提交", "Commit submitted"), getTaskName(task));
      void runLogger.log({
        source: "image",
        level: "info",
        action: "image.commit",
        result: "success",
        title: text("Commit 已提交", "Commit submitted"),
        targetName: getTaskName(task),
        targetId: task.id,
      });
      queryClient.invalidateQueries({ queryKey: ["images"] });
    },
    onError: (error, task) => {
      toast.error(text("Commit 失败", "Commit failed"), `${getTaskName(task)}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
      void runLogger.log({
        source: "image",
        level: "error",
        action: "image.commit",
        result: "failure",
        title: text("Commit 失败", "Commit failed"),
        targetName: getTaskName(task),
        targetId: task.id,
        error: errorMessage(error, text("Commit 失败", "Commit failed")),
      });
    },
  });

  const saveTemplateMutation = useMutation({
    mutationFn: async (task: Task) => {
      const editableTemplate = taskToEditableTaskTemplate(task, auth.user?.username ?? "");
      if (!editableTemplate.imageId) throw new Error(text("实例缺少镜像字段，无法保存为模板。请查看原始 JSON 确认 image_id 或 img。", "The instance is missing an image field and cannot be saved as a template. Check raw JSON for image_id or img."));
      const templates = await loadTaskTemplates(browserRuntime.storage);
      const template = createTaskTemplate(editableTemplate);
      await saveTaskTemplates(browserRuntime.storage, [template, ...templates]);
      return template;
    },
    onSuccess: (template, task) => {
      toast.success(text("已保存为实例模板", "Saved as instance template"), template.name);
      void runLogger.log({
        source: "task-template",
        level: "info",
        action: "taskTemplate.createFromTask",
        result: "success",
        title: text("已从实例保存模板", "Saved template from instance"),
        targetName: getTaskName(task),
        targetId: task.id,
        metadata: { templateId: template.id, templateName: template.name },
      });
    },
    onError: (error, task) => {
      toast.error(text("保存模板失败", "Failed to save template"), `${getTaskName(task)}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
      void runLogger.log({
        source: "task-template",
        level: "error",
        action: "taskTemplate.createFromTask",
        result: "failure",
        title: text("从实例保存模板失败", "Failed to save template from instance"),
        targetName: getTaskName(task),
        targetId: task.id,
        error: errorMessage(error, text("保存模板失败", "Failed to save template")),
      });
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async (tasks: Task[]) => {
      await runSequentiallyWithDelay(tasks, (task) => instanceApi.deleteTask(task.id));
    },
    onSuccess: (_data, tasks) => {
      toast.success(text("批量删除已提交", "Batch deletion submitted"), text(`${tasks.length} 个不可释放实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms`, `${tasks.length} non-releasable instances, ${BATCH_REQUEST_DELAY_MS}ms apart`));
      void runLogger.log({
        source: "task",
        level: "info",
        action: "task.batchDelete",
        result: "success",
        title: text("批量删除已提交", "Batch deletion submitted"),
        metadata: { count: tasks.length, ids: tasks.map((task) => task.id) },
      });
      setRowSelection({});
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      toast.error(text("批量删除失败", "Batch deletion failed"), error instanceof Error ? error.message : text("请稍后重试", "Try again later"));
      void runLogger.log({
        source: "task",
        level: "error",
        action: "task.batchDelete",
        result: "failure",
        title: text("批量删除失败", "Batch deletion failed"),
        error: errorMessage(error, text("批量删除失败", "Batch deletion failed")),
      });
    },
  });

  const batchReleaseMutation = useMutation({
    mutationFn: async (tasks: Task[]) => {
      await runSequentiallyWithDelay(tasks, (task) => instanceApi.operateTask(task.id));
    },
    onSuccess: (_data, tasks) => {
      toast.success(text("批量释放已提交", "Batch release submitted"), text(`${tasks.length} 个可释放实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms`, `${tasks.length} releasable instances, ${BATCH_REQUEST_DELAY_MS}ms apart`));
      void runLogger.log({
        source: "task",
        level: "info",
        action: "task.batchRelease",
        result: "success",
        title: text("批量释放已提交", "Batch release submitted"),
        metadata: { count: tasks.length, ids: tasks.map((task) => task.id) },
      });
      setRowSelection({});
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      toast.error(text("批量释放失败", "Batch release failed"), error instanceof Error ? error.message : text("请稍后重试", "Try again later"));
      void runLogger.log({
        source: "task",
        level: "error",
        action: "task.batchRelease",
        result: "failure",
        title: text("批量释放失败", "Batch release failed"),
        error: errorMessage(error, text("批量释放失败", "Batch release failed")),
      });
    },
  });

  const batchPending = batchDeleteMutation.isPending || batchReleaseMutation.isPending || commitMutation.isPending;
  const autoRefreshPaused = batchPending || createOpen || Boolean(logTask) || Boolean(terminalTask) || Boolean(rawTask) || columnSettingsOpen;
  const query = useQuery({
    queryKey: taskQueryKey(queryState),
    queryFn: () => instanceApi.tasks(toTaskApiQuery(queryState)),
    refetchInterval: autoRefresh && !autoRefreshPaused ? autoRefreshInterval : false,
    refetchIntervalInBackground: false,
  });

  const filteredTasks = useMemo(() => {
    const tasks = query.data?.items ?? [];
    return filterAndSortTasks(tasks.filter((task) => taskMatchesQuery(task, queryState)), queryState.keyword);
  }, [query.data?.items, queryState]);

  const handleDownloadTask = useCallback((task: Task) => {
    const taskName = getTaskName(task);
    downloadQueue.enqueue({
      source: "task",
      sourceLabel: text("任务", "Task"),
      filename: `${taskName}.zip`,
      targetName: taskName,
      targetId: task.id,
      successTitle: text("任务文件已下载", "Task files downloaded"),
      failureTitle: text("任务下载失败", "Task download failed"),
      action: "task.download",
      request: ({ signal, onProgress }) => instanceApi.downloadTask({ task_id: task.id }, { signal, onProgress }),
    });
  }, [downloadQueue, text]);

  const openCreateTask = () => {
    setCloneTask(null);
    setCreateOpen(true);
  };

  const openCloneTask = (task: Task) => {
    setCloneTask(task);
    setCreateOpen(true);
  };

  const closeCreateTask = () => {
    setCreateOpen(false);
    setCloneTask(null);
  };

  const confirmReleaseTask = useCallback((task: Task) => {
    confirm({
      title: text("确认释放实例", "Confirm Instance Release"),
      description: text(`将释放 ${getTaskName(task)}。释放后实例会停止运行，请确认当前任务状态。`, `Release ${getTaskName(task)}. The instance will stop running after release. Confirm the current task state.`),
      confirmLabel: text("释放", "Release"),
      tone: "danger",
      run: () => releaseMutation.mutateAsync(task),
    });
  }, [confirm, releaseMutation, text]);

  const confirmDeleteTask = useCallback((task: Task) => {
    confirm({
      title: text("确认删除实例", "Confirm Instance Deletion"),
      description: text(`将删除 ${getTaskName(task)}。此操作不可从 EasyConsole 撤销。`, `Delete ${getTaskName(task)}. EasyConsole cannot undo this operation.`),
      confirmLabel: text("删除", "Delete"),
      tone: "danger",
      run: () => deleteMutation.mutateAsync(task),
    });
  }, [confirm, deleteMutation, text]);

  const confirmCommitTask = useCallback((task: Task) => {
    confirm({
      title: text("确认 Commit 实例", "Confirm Instance Commit"),
      description: text(`将把 ${getTaskName(task)} 的当前运行环境提交为镜像。此操作可能需要一段时间，请确认实例内文件状态已经稳定。`, `Commit the current runtime environment of ${getTaskName(task)} as an image. This may take some time; confirm files inside the instance are stable.`),
      confirmLabel: "Commit",
      run: () => commitMutation.mutateAsync(task),
    });
  }, [commitMutation, confirm, text]);

  const confirmBatchRelease = useCallback((tasks: Task[]) => {
    confirm({
      title: text("确认批量释放", "Confirm Batch Release"),
      description: text(`将按顺序释放 ${tasks.length} 个可释放实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms。`, `Release ${tasks.length} releasable instances in order, ${BATCH_REQUEST_DELAY_MS}ms apart.`),
      confirmLabel: text("批量释放", "Batch release"),
      tone: "danger",
      run: () => batchReleaseMutation.mutateAsync(tasks),
    });
  }, [batchReleaseMutation, confirm, text]);

  const confirmBatchDelete = useCallback((tasks: Task[]) => {
    confirm({
      title: text("确认批量删除", "Confirm Batch Deletion"),
      description: text(`将按顺序删除 ${tasks.length} 个不可释放实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms。`, `Delete ${tasks.length} non-releasable instances in order, ${BATCH_REQUEST_DELAY_MS}ms apart.`),
      confirmLabel: text("批量删除", "Batch delete"),
      tone: "danger",
      run: () => batchDeleteMutation.mutateAsync(tasks),
    });
  }, [batchDeleteMutation, confirm, text]);

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "select",
        header: ({ table }) => (
          <input
            aria-label={text("选择当前页实例", "Select current page instances")}
            className="h-4 w-4 accent-app-accent"
            type="checkbox"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            aria-label={text(`选择实例 ${getTaskName(row.original)}`, `Select instance ${getTaskName(row.original)}`)}
            className="h-4 w-4 accent-app-accent"
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      }),
      columnHelper.accessor((row) => getTaskName(row), {
        id: "name",
        header: text("实例名称", "Instance name"),
        cell: ({ row, getValue }) => (
          <div className="whitespace-nowrap">
            <div className="font-medium">{getValue()}</div>
            <div className="mt-0.5 text-xs text-app-muted">#{row.original.id}</div>
          </div>
        ),
      }),
      columnHelper.accessor("status", {
        header: text("状态", "Status"),
        cell: (info) => <StatusBadge status={info.getValue()} />,
      }),
      columnHelper.accessor((row) => resourceText(row), {
        id: "resource",
        header: text("资源", "Resources"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.node_name || "-", {
        id: "node",
        header: text("节点", "Node"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => endpointText(row), {
        id: "endpoint",
        header: text("入口", "Endpoint"),
        cell: (info) => <span className="whitespace-nowrap font-mono text-xs text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => ownerText(row), {
        id: "owner",
        header: text("用户", "User"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => groupText(row), {
        id: "group",
        header: text("用户组", "User group"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.use_time, {
        id: "duration",
        header: text("时长", "Duration"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{formatSecondsDuration(info.getValue(), locale)}</span>,
      }),
      columnHelper.accessor((row) => row.create_time ?? row.created_at ?? "-", {
        id: "created",
        header: text("创建时间", "Created"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.releace_time ?? "-", {
        id: "release",
        header: text("释放时间", "Release time"),
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.releace_conditions ?? row.release_condition, {
        id: "releaseCondition",
        header: text("释放条件", "Release condition"),
        cell: (info) => <ReleaseConditionBadge condition={info.getValue()} />,
      }),
      columnHelper.accessor((row) => (row.is_delete ? text("已删除", "Deleted") : text("正常", "Normal")), {
        id: "deleted",
        header: text("删除状态", "Delete status"),
        cell: (info) => (
          <span className={info.getValue() === text("已删除", "Deleted") ? "text-app-danger" : "text-app-muted"}>{info.getValue()}</span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: () => <ActionHeader />,
        cell: ({ row }) => {
          const task = row.original;
          const release = isReleasableTask(task);
          return (
            <div className={ACTION_GRID_CLASS}>
              <Button aria-label={text(`打开 ${getTaskName(task)} 的监控`, `Open monitor for ${getTaskName(task)}`)} className="h-8 w-8 px-0" variant="ghost" title={text("监控", "Monitor")} onClick={() => openMonitorDashboard(task)}>
                <ActivitySquare className="h-4 w-4" />
              </Button>
              <Button aria-label={text(`查看 ${getTaskName(task)} 的日志`, `View logs for ${getTaskName(task)}`)} className="h-8 w-8 px-0" variant="ghost" title={text("日志", "Logs")} onClick={() => setLogTask(task)}>
                <FileText className="h-4 w-4" />
              </Button>
              <Button aria-label={text(`打开 ${getTaskName(task)} 的终端`, `Open terminal for ${getTaskName(task)}`)} className="h-8 w-8 px-0" variant="ghost" title={text("终端", "Terminal")} onClick={() => setTerminalTask(task)}>
                <Terminal className="h-4 w-4" />
              </Button>
              <Button aria-label={text(`复制 ${getTaskName(task)} 的配置`, `Copy configuration for ${getTaskName(task)}`)} className="h-8 w-8 px-0" variant="ghost" title={text("复制", "Copy")} onClick={() => openCloneTask(task)}>
                <Copy className="h-4 w-4" />
              </Button>
              {release ? (
                <Button
                  className="h-8 w-20 justify-center px-2 text-app-warning hover:text-app-warning"
                  disabled={releaseMutation.isPending}
                  title={text("释放", "Release")}
                  variant="ghost"
                  onClick={() => confirmReleaseTask(task)}
                >
                  <Power className="h-4 w-4" />
                  {text("释放", "Release")}
                </Button>
              ) : (
                <Button
                  className="h-8 w-20 justify-center px-2 text-app-danger hover:text-app-danger"
                  disabled={deleteMutation.isPending}
                  title={text("删除", "Delete")}
                  variant="ghost"
                  onClick={() => confirmDeleteTask(task)}
                >
                  <Trash2 className="h-4 w-4" />
                  {text("删除", "Delete")}
                </Button>
              )}
              <MoreActionsMenu
                task={task}
                onCommit={confirmCommitTask}
                onDownload={handleDownloadTask}
                onRaw={setRawTask}
                onSaveTemplate={(selectedTask) => saveTemplateMutation.mutate(selectedTask)}
              />
            </div>
          );
        },
      }),
    ],
    [confirmCommitTask, confirmDeleteTask, confirmReleaseTask, deleteMutation.isPending, handleDownloadTask, locale, releaseMutation.isPending, saveTemplateMutation, text],
  );

  const table = useReactTable({
    data: filteredTasks,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: taskRowId,
    enableRowSelection: true,
    state: {
      columnVisibility,
      rowSelection,
    },
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
  });

  useEffect(() => {
    window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(columnVisibility));
  }, [columnVisibility]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_REFRESH_KEY, String(autoRefresh));
  }, [autoRefresh]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, String(autoRefreshInterval));
  }, [autoRefreshInterval]);

  const configurableColumns = table.getAllLeafColumns().filter((column) => !ALWAYS_VISIBLE_COLUMNS.has(column.id));
  const selectedTasks = table.getSelectedRowModel().flatRows.map((row) => row.original);
  const selectedReleasableTasks = selectedTasks.filter(isReleasableTask);
  const selectedNonReleasableTasks = selectedTasks.filter((task) => !isReleasableTask(task));
  const total = query.data?.total;
  const hasKnownTotal = typeof total === "number";
  const totalPages = hasKnownTotal ? Math.max(1, Math.ceil(total / queryState.pageSize)) : undefined;
  const hasNextPage = hasKnownTotal ? queryState.page < (totalPages ?? 1) : (query.data?.items.length ?? 0) >= queryState.pageSize;

  useEffect(() => {
    setRowSelection({});
  }, [queryState.page, queryState.pageSize, queryState.keyword, queryState.status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <div className="relative w-full sm:w-auto">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input
              className="w-full pl-9 sm:w-64"
              placeholder={text("搜索实例名称", "Search instance name")}
              value={queryState.keyword}
              onChange={(event) => updateTaskQuery({ keyword: event.target.value })}
            />
          </div>
          <Select className="w-32" value={queryState.status} onChange={(event) => updateTaskQuery({ status: event.target.value })}>
            <option value="">{text("全部状态", "All statuses")}</option>
            {Object.entries(locale === "en-US" ? taskStatusTextEn : taskStatusText).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            {text("刷新", "Refresh")}
          </Button>
          <div className="flex min-h-9 items-center gap-2 rounded-md border border-app-border bg-app-surface px-3 text-sm [@media(pointer:coarse)]:min-h-11">
            <label className="flex cursor-pointer items-center gap-2 text-app-text">
              <input
                type="checkbox"
                className="h-4 w-4 accent-app-accent"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              {text("自动刷新", "Auto refresh")}
            </label>
            <Select
              className="h-7 border-0 bg-app-panel px-2 text-xs"
              disabled={!autoRefresh}
              value={String(autoRefreshInterval)}
              onChange={(event) => setAutoRefreshInterval(Number(event.target.value))}
            >
              {autoRefreshOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {locale === "en-US" ? option.en : option.zh}
                </option>
              ))}
            </Select>
            {autoRefresh && autoRefreshPaused ? <span className="text-xs text-app-warning">{text("已暂停", "Paused")}</span> : null}
          </div>
          <Button variant="secondary" onClick={() => setColumnSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" />
            {text("列设置", "Columns")}
          </Button>
        </div>
        <Button className="w-full sm:w-auto" onClick={openCreateTask}>
          <Plus className="h-4 w-4" />
          {text("新建任务", "New task")}
        </Button>
      </div>

      {selectedTasks.length > 0 ? (
        <Panel className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div className="text-sm text-app-muted">
            {text("已选", "Selected")} <span className="font-medium text-app-text">{selectedTasks.length}</span> {text("个实例", "instances")}
            {selectedReleasableTasks.length > 0 ? text(`，可释放 ${selectedReleasableTasks.length} 个`, `, releasable ${selectedReleasableTasks.length}`) : ""}
            {selectedNonReleasableTasks.length > 0 ? text(`，不可释放 ${selectedNonReleasableTasks.length} 个`, `, non-releasable ${selectedNonReleasableTasks.length}`) : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selectedReleasableTasks.length > 0 ? (
              <Button
                disabled={batchPending}
                variant="secondary"
                onClick={() => confirmBatchRelease(selectedReleasableTasks)}
              >
                <Power className="h-4 w-4 text-app-warning" />
                {text("批量释放", "Batch release")} {selectedReleasableTasks.length}
              </Button>
            ) : null}
            {selectedNonReleasableTasks.length > 0 ? (
              <Button
                className="border-app-danger text-app-danger hover:text-app-danger"
                disabled={batchPending}
                variant="secondary"
                onClick={() => confirmBatchDelete(selectedNonReleasableTasks)}
              >
                <Trash2 className="h-4 w-4" />
                {text("批量删除", "Batch delete")} {selectedNonReleasableTasks.length}
              </Button>
            ) : null}
            <Button disabled={batchPending} variant="ghost" onClick={() => setRowSelection({})}>
              {text("取消选择", "Clear selection")}
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <TableSkeleton columns={7} />
        ) : query.isError ? (
          <ErrorState error={query.error} action={<Button variant="secondary" onClick={() => query.refetch()}>{text("重试", "Retry")}</Button>} />
        ) : table.getRowModel().rows.length === 0 && queryState.keyword.trim() ? (
          <EmptyState title={text("未找到匹配实例", "No matching instances")} action={<Button variant="secondary" onClick={() => updateTaskQuery({ keyword: "" })}>{text("清空搜索", "Clear search")}</Button>} />
        ) : table.getRowModel().rows.length === 0 ? (
          <EmptyState title={text("暂无任务实例", "No task instances")} action={<Button onClick={openCreateTask}>{text("新建任务", "New task")}</Button>} />
        ) : (
          <>
          <div className="divide-y divide-app-border sm:hidden">
            {table.getRowModel().rows.map((row) => {
              const task = row.original;
              const release = isReleasableTask(task);
              const taskName = getTaskName(task);
              return (
                <article key={row.id} className="space-y-3 px-3 py-3" aria-labelledby={`task-card-${row.id}`}>
                  <div className="flex items-start gap-3">
                    <input
                      aria-label={text(`选择 ${taskName}`, `Select ${taskName}`)}
                      className="mt-1 h-4 w-4 shrink-0 accent-app-accent"
                      type="checkbox"
                      checked={row.getIsSelected()}
                      onChange={row.getToggleSelectedHandler()}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 id={`task-card-${row.id}`} className="truncate text-sm font-semibold text-app-text">{taskName}</h3>
                        <StatusBadge status={task.status} />
                      </div>
                      <div className="mt-1 font-mono text-xs text-app-muted">#{task.id}</div>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div>
                      <dt className="text-app-muted">{text("资源", "Resources")}</dt>
                      <dd className="mt-0.5 text-app-text">{resourceText(task)}</dd>
                    </div>
                    <div>
                      <dt className="text-app-muted">{text("入口", "Endpoint")}</dt>
                      <dd className="mt-0.5 truncate font-mono text-app-text">{endpointText(task)}</dd>
                    </div>
                    <div>
                      <dt className="text-app-muted">{text("用户", "User")}</dt>
                      <dd className="mt-0.5 truncate text-app-text">{ownerText(task)}</dd>
                    </div>
                    <div>
                      <dt className="text-app-muted">{text("时长", "Duration")}</dt>
                      <dd className="mt-0.5 text-app-text">{formatSecondsDuration(task.use_time, locale)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-app-muted">{text("释放条件", "Release condition")}</dt>
                      <dd className="mt-1"><ReleaseConditionBadge condition={task.releace_conditions ?? task.release_condition} /></dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-1.5">
                    <Button aria-label={text(`打开 ${taskName} 的监控`, `Open monitor for ${taskName}`)} className="h-9 px-2" variant="ghost" title={text("监控", "Monitor")} onClick={() => openMonitorDashboard(task)}>
                      <ActivitySquare className="h-4 w-4" />
                      {text("监控", "Monitor")}
                    </Button>
                    <Button aria-label={text(`查看 ${taskName} 的日志`, `View logs for ${taskName}`)} className="h-9 px-2" variant="ghost" title={text("日志", "Logs")} onClick={() => setLogTask(task)}>
                      <FileText className="h-4 w-4" />
                      {text("日志", "Logs")}
                    </Button>
                    <Button aria-label={text(`打开 ${taskName} 的终端`, `Open terminal for ${taskName}`)} className="h-9 px-2" variant="ghost" title={text("终端", "Terminal")} onClick={() => setTerminalTask(task)}>
                      <Terminal className="h-4 w-4" />
                      {text("终端", "Terminal")}
                    </Button>
                    {release ? (
                      <Button className="h-9 px-2 text-app-warning hover:text-app-warning" disabled={releaseMutation.isPending} title={text("释放", "Release")} variant="ghost" onClick={() => confirmReleaseTask(task)}>
                        <Power className="h-4 w-4" />
                        {text("释放", "Release")}
                      </Button>
                    ) : (
                      <Button className="h-9 px-2 text-app-danger hover:text-app-danger" disabled={deleteMutation.isPending} title={text("删除", "Delete")} variant="ghost" onClick={() => confirmDeleteTask(task)}>
                        <Trash2 className="h-4 w-4" />
                        {text("删除", "Delete")}
                      </Button>
                    )}
                    <MoreActionsMenu
                      task={task}
                      onCommit={confirmCommitTask}
                      onDownload={handleDownloadTask}
                      onRaw={setRawTask}
                      onSaveTemplate={(selectedTask) => saveTemplateMutation.mutate(selectedTask)}
                    />
                  </div>
                </article>
              );
            })}
          </div>
          <TableRegion className="hidden sm:block" label={text("任务实例表格", "Task instances table")}>
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        scope="col"
                        className={[
                          "whitespace-nowrap border-b border-app-border px-3 py-2 font-medium",
                          isActionsColumn(header.column.id)
                            ? "sticky right-0 z-20 bg-app-panel shadow-stickyColumn"
                            : "",
                        ].join(" ")}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="relative border-b border-app-border last:border-0 hover:z-20 hover:bg-app-panel/60">
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={[
                          "whitespace-nowrap px-3 py-2 align-middle",
                          isActionsColumn(cell.column.id)
                            ? "sticky right-0 z-30 bg-app-surface shadow-stickyColumn"
                            : "",
                        ].join(" ")}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
          </>
        )}
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-app-muted">
        <div>
          {hasKnownTotal
            ? text(`共 ${total} 个实例，第 ${queryState.page} / ${totalPages} 页`, `${total} instances, page ${queryState.page} / ${totalPages}`)
            : text(`第 ${queryState.page} 页，当前返回 ${query.data?.items.length ?? 0} 个实例`, `Page ${queryState.page}, ${query.data?.items.length ?? 0} instances returned`)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span>{text("每页", "Per page")}</span>
          <Select
            className="w-24"
            value={String(queryState.pageSize)}
            onChange={(event) => updateTaskQuery({ pageSize: Number(event.target.value) })}
          >
            {TASK_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Button
            disabled={queryState.page <= 1 || query.isFetching}
            type="button"
            variant="secondary"
            onClick={() => updateTaskQuery({ page: Math.max(1, queryState.page - 1) })}
          >
            {text("上一页", "Previous")}
          </Button>
          <Button
            disabled={!hasNextPage || query.isFetching}
            type="button"
            variant="secondary"
            onClick={() => updateTaskQuery({ page: queryState.page + 1 })}
          >
            {text("下一页", "Next")}
          </Button>
        </div>
      </div>

      <CreateTaskDialog initialTask={cloneTask} open={createOpen} onClose={closeCreateTask} />
      <TaskLogDialog task={logTask} onClose={() => setLogTask(null)} />
      <Suspense fallback={null}>
        <TerminalDialog task={terminalTask} onClose={() => setTerminalTask(null)} />
      </Suspense>
      <Dialog open={Boolean(rawTask)} title={text(`实例原始 JSON ${rawTask ? getTaskName(rawTask) : ""}`, `Instance Raw JSON ${rawTask ? getTaskName(rawTask) : ""}`)} onClose={() => setRawTask(null)} width="max-w-4xl">
        <pre className="max-h-[70vh] overflow-auto bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText">
          {asJson(rawTask)}
        </pre>
      </Dialog>
      <Dialog open={columnSettingsOpen} title={text("列设置", "Columns")} onClose={() => setColumnSettingsOpen(false)} width="max-w-md">
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {configurableColumns.map((column) => (
              <label
                key={column.id}
                className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-app-border bg-app-surface px-3 text-sm hover:bg-app-panel"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-app-accent"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                />
                <span>{columnLabels[column.id] ? (locale === "en-US" ? columnLabels[column.id].en : columnLabels[column.id].zh) : column.id}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 border-t border-app-border pt-3">
            <Button variant="secondary" onClick={() => setColumnVisibility(defaultColumnVisibility)}>
              {text("恢复默认", "Restore defaults")}
            </Button>
            <Button onClick={() => setColumnSettingsOpen(false)}>{text("完成", "Done")}</Button>
          </div>
        </div>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
