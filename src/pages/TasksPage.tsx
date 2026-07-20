import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ActivitySquare,
  Braces,
  CopyPlus,
  Download,
  FileText,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
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
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";

import { needsLogAttention } from "../lib/task-status-notifications";

import { EmptyState, ErrorState, LoadingState, SearchXIcon, TableSkeleton } from "../components/DataState";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { StatusBadge } from "../components/StatusBadge";
import { AppSshTerminalDialog } from "../components/tasks/AppSshTerminalDialog";
import { TaskInstanceName } from "../components/tasks/TaskInstanceName";
import { Button, Dialog, Input, Panel, Select, TableRegion } from "../components/ui";
import { instanceApi } from "../lib/api";
import { getTaskEditableState } from "../lib/api-factory";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../lib/batch";
import { useCommitQueue } from "../lib/commit-queue-context";
import { useDownloadQueue } from "../lib/download-queue-context";
import { asJson, formatSecondsDuration, getTaskName, getTaskNodeName, taskStatusText, taskStatusTextEn } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { i18nText } from "../lib/i18n-text";
import { openMonitorDashboard } from "../lib/monitor-dashboard";
import { browserRuntime } from "../lib/runtime";
import {
  isTaskPinned,
  loadTaskPins,
  pruneTaskPins,
  saveTaskPins,
  sortTasksWithPins,
  toggleTaskPin,
} from "../lib/task-pins";
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
import { resolveTaskTerminalAction, willOpenAppSshSession } from "../lib/task-terminal";
import { invalidateTaskQueries, TASK_SNAPSHOT_QUERY_KEY } from "../lib/task-snapshot-query";
import type { SshConnectionRequest, Task } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

const columnHelper = createColumnHelper<Task>();
const CreateTaskDialog = lazy(() => import("../components/tasks/CreateTaskDialog").then((module) => ({ default: module.CreateTaskDialog })));
const TaskLogDialog = lazy(() => import("../components/tasks/TaskLogDialog").then((module) => ({ default: module.TaskLogDialog })));
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
const ACTION_GRID_CLASS = "grid grid-cols-[2rem_2rem_4rem_2rem] items-center gap-1";
const MENU_ITEM_CLASS =
  "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";
const CHECKBOX_HIT_CLASS =
  "inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
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
  if (!podName) throw new Error(i18nText("后端未返回 pod 标识，无法提交镜像。请刷新实例列表或查看原始 JSON。", "The backend did not return a pod identifier, so commit cannot continue. Refresh the instance list or inspect the raw JSON."));
  const user = getTaskCommitUser(task);
  if (!user) throw new Error(i18nText("后端未返回用户信息，无法提交镜像。请刷新实例列表或查看原始 JSON。", "The backend did not return user information, so commit cannot continue. Refresh the instance list or inspect the raw JSON."));
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
      <span>{text("终端/连接", "SSH")}</span>
      <span>{text("监控", "Mon.")}</span>
      <span>{text("释放/删除", "Release/Delete")}</span>
      <span>{text("更多", "More")}</span>
    </div>
  );
}

function autoRefreshIntervalLabel(intervalMs: number, locale: string) {
  const option = autoRefreshOptions.find((item) => item.value === intervalMs);
  if (!option) return `${Math.round(intervalMs / 1000)}s`;
  return locale === "en-US" ? option.en : option.zh;
}

function formatRelativeUpdatedAt(
  updatedAt: number,
  now: number,
  text: (zh: string, en: string) => string,
) {
  const deltaMs = Math.max(0, now - updatedAt);
  if (deltaMs < 5_000) return text("刚刚", "Just now");
  if (deltaMs < 60_000) {
    const seconds = Math.max(1, Math.floor(deltaMs / 1_000));
    return text(`${seconds} 秒前`, `${seconds}s ago`);
  }
  if (deltaMs < 3_600_000) {
    const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
    return text(`${minutes} 分钟前`, `${minutes}m ago`);
  }
  const hours = Math.max(1, Math.floor(deltaMs / 3_600_000));
  return text(`${hours} 小时前`, `${hours}h ago`);
}

async function loadColumnVisibility(): Promise<VisibilityState> {
  try {
    const raw = await browserRuntime.storage.get(COLUMN_VISIBILITY_KEY);
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

async function loadBooleanSetting(key: string, fallback = false) {
  try {
    const raw = await browserRuntime.storage.get(key);
    return raw === "true" || fallback;
  } catch {
    return fallback;
  }
}

async function loadNumberSetting(key: string, fallback: number) {
  try {
    const raw = await browserRuntime.storage.get(key);
    const value = Number(raw);
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
  isPinned,
  canEdit,
  promoteLog = false,
  showSshInfo = true,
  onLog,
  onClone,
  onSshInfo,
  onMonitor,
  onRaw,
  onDownload,
  onCommit,
  onEdit,
  onSaveTemplate,
  onTogglePin,
}: {
  task: Task;
  isPinned: boolean;
  canEdit: boolean;
  /** When true, logs are on the action strip; expose monitor in More instead. */
  promoteLog?: boolean;
  onLog: (task: Task) => void;
  onClone: (task: Task) => void;
  onSshInfo: (task: Task) => void;
  onMonitor?: (task: Task) => void;
  onRaw: (task: Task) => void;
  onDownload: (task: Task) => void;
  onCommit: (task: Task) => void;
  onEdit: (task: Task) => void;
  onSaveTemplate: (task: Task) => void;
  onTogglePin: (task: Task) => void;
  /** When false, hide connection info in More (already on the action strip). */
  showSshInfo?: boolean;
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

  const menuSections = useMemo(() => {
    type MenuItem = {
      key: string;
      label: string;
      icon: ReactNode;
      disabled?: boolean;
      title?: string;
      onSelect: () => void;
    };

    const running = isRunningTask(task);
    const logItem: MenuItem = {
      key: "log",
      label: text("日志", "Logs"),
      icon: <FileText className="h-4 w-4 text-app-muted" />,
      onSelect: () => onLog(task),
    };
    const monitorItem: MenuItem | null =
      promoteLog && onMonitor
        ? {
            key: "monitor",
            label: text("监控", "Monitor"),
            icon: <ActivitySquare className="h-4 w-4 text-app-muted" />,
            onSelect: () => onMonitor(task),
          }
        : null;
    const sshInfoItem: MenuItem | null = showSshInfo
      ? {
          key: "ssh-info",
          label: text("连接信息", "Connection info"),
          icon: <KeyRound className="h-4 w-4 text-app-muted" />,
          onSelect: () => onSshInfo(task),
        }
      : null;

    // Normal rows: monitor on the strip, logs in More. Failed/abnormal: logs on the strip, monitor in More.
    const connect: MenuItem[] = promoteLog
      ? [logItem, ...(monitorItem ? [monitorItem] : []), ...(sshInfoItem ? [sshInfoItem] : [])]
      : [logItem, ...(sshInfoItem ? [sshInfoItem] : [])];

    const lifecycle: MenuItem[] = [
      {
        key: "clone",
        label: text("克隆", "Clone"),
        icon: <CopyPlus className="h-4 w-4 text-app-muted" />,
        onSelect: () => onClone(task),
      },
    ];
    if (canEdit) {
      lifecycle.push({
        key: "edit",
        label: text("编辑", "Edit"),
        icon: <Pencil className="h-4 w-4 text-app-muted" />,
        onSelect: () => onEdit(task),
      });
    }
    lifecycle.push({
      key: "commit",
      label: text("提交镜像", "Commit image"),
      icon: <Upload className="h-4 w-4 text-app-muted" />,
      disabled: !running,
      title: running
        ? text("提交镜像", "Commit image")
        : text("仅运行中实例可提交镜像", "Only running instances can be committed"),
      onSelect: () => onCommit(task),
    });

    const local: MenuItem[] = [
      {
        key: "download",
        label: text("下载", "Download"),
        icon: <Download className="h-4 w-4 text-app-muted" />,
        onSelect: () => onDownload(task),
      },
      {
        key: "template",
        label: text("存为模板", "Save as template"),
        icon: <Save className="h-4 w-4 text-app-muted" />,
        onSelect: () => onSaveTemplate(task),
      },
      {
        key: "pin",
        label: isPinned ? text("取消置顶", "Unpin") : text("置顶", "Pin"),
        icon: isPinned ? <PinOff className="h-4 w-4 text-app-muted" /> : <Pin className="h-4 w-4 text-app-muted" />,
        onSelect: () => onTogglePin(task),
      },
      {
        key: "raw",
        label: text("原始 JSON", "Raw JSON"),
        icon: <Braces className="h-4 w-4 text-app-muted" />,
        onSelect: () => onRaw(task),
      },
    ];

    return [
      { id: "connect", items: connect },
      { id: "lifecycle", items: lifecycle },
      { id: "local", items: local },
    ] as const;
  }, [canEdit, isPinned, onClone, onCommit, onDownload, onEdit, onLog, onMonitor, onRaw, onSaveTemplate, onSshInfo, onTogglePin, promoteLog, showSshInfo, task, text]);

  const menuItems = useMemo(() => menuSections.flatMap((section) => section.items), [menuSections]);

  useEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const width = 176;
      const estimatedHeight = Math.min(320, 8 + menuItems.length * 32 + (menuSections.length - 1) * 9);
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
  }, [closeMenu, menuItems.length, menuSections.length, open]);

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
            className="fixed z-[100] max-h-[min(20rem,calc(100vh-1rem))] w-44 overflow-y-auto rounded-md border border-app-border bg-app-surface p-1 shadow-popover"
            role="menu"
            aria-label={text(`实例操作 ${getTaskName(task)}`, `Instance actions for ${getTaskName(task)}`)}
            style={{ left: menuPosition.left, top: menuPosition.top }}
            onKeyDown={handleMenuKeyDown}
          >
            {menuSections.map((section, sectionIndex) => (
              <div key={section.id}>
                {sectionIndex > 0 ? <div className="my-1 border-t border-app-border" role="separator" /> : null}
                {section.items.map((item) => {
                  const index = menuItems.findIndex((candidate) => candidate.key === item.key);
                  return (
                    <button
                      key={item.key}
                      ref={(element) => {
                        menuItemRefs.current[index] = element;
                      }}
                      className={MENU_ITEM_CLASS}
                      disabled={item.disabled}
                      role="menuitem"
                      tabIndex={-1}
                      title={item.title}
                      type="button"
                      onClick={() => {
                        if (item.disabled) return;
                        closeMenu();
                        item.onSelect();
                      }}
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

export function TasksPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const downloadQueue = useDownloadQueue();
  const commitQueue = useCommitQueue();
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = useMemo(() => parseTaskListQuery(searchParams), [searchParams]);
  const [keywordInput, setKeywordInput] = useState(queryState.keyword);
  const { confirm, confirmDialog } = useConfirmAction();
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneTask, setCloneTask] = useState<Task | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);
  const [sshInfoTask, setSshInfoTask] = useState<Task | null>(null);
  const [appSshRequest, setAppSshRequest] = useState<SshConnectionRequest | null>(null);
  const [rawTask, setRawTask] = useState<Task | null>(null);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(defaultColumnVisibility);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(DEFAULT_AUTO_REFRESH_INTERVAL);
  const [pinnedTaskIds, setPinnedTaskIds] = useState<string[]>([]);
  const [autoRefreshMenuOpen, setAutoRefreshMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const autoRefreshMenuId = useId();
  const autoRefreshMenuRef = useRef<HTMLDivElement>(null);
  const autoRefreshTriggerRef = useRef<HTMLButtonElement>(null);
  const autoRefreshMenuListRef = useRef<HTMLDivElement>(null);
  const autoRefreshItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const autoRefreshInitialFocusRef = useRef(0);

  const updateTaskQuery = useCallback((patch: Partial<TaskListQueryState>) => {
    const next = { ...queryState, ...patch };
    if (!("page" in patch)) next.page = 1;
    setSearchParams(serializeTaskListQuery(next), { replace: true });
  }, [queryState, setSearchParams]);

  // Debounce search input: write to URL 300ms after the last keystroke.
  useEffect(() => {
    if (keywordInput === queryState.keyword) return;
    const timer = window.setTimeout(() => {
      updateTaskQuery({ keyword: keywordInput });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [keywordInput, queryState.keyword, updateTaskQuery]);

  // Keep local input in sync when keyword changes externally (URL nav, clear).
  useEffect(() => {
    setKeywordInput(queryState.keyword);
  }, [queryState.keyword]);

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
      invalidateTaskQueries(queryClient);
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
      invalidateTaskQueries(queryClient);
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
      invalidateTaskQueries(queryClient);
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
      invalidateTaskQueries(queryClient);
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

  const batchPending = batchDeleteMutation.isPending || batchReleaseMutation.isPending;
  const autoRefreshPaused = batchPending || createOpen || Boolean(editTask) || Boolean(logTask) || Boolean(sshInfoTask) || Boolean(appSshRequest) || Boolean(rawTask) || columnSettingsOpen;
  const query = useQuery({
    queryKey: taskQueryKey(queryState),
    queryFn: () => instanceApi.tasks(toTaskApiQuery(queryState)),
    refetchInterval: autoRefresh && !autoRefreshPaused ? autoRefreshInterval : false,
    refetchIntervalInBackground: false,
  });

  // Sync fetched data into the TaskNotificationWatcher cache so it can compare
  // task status snapshots without polling the same endpoint in parallel.
  useEffect(() => {
    if (query.data) {
      queryClient.setQueryData(TASK_SNAPSHOT_QUERY_KEY, query.data);
    }
  }, [query.data, queryClient]);

  const filteredTasks = useMemo(() => {
    const tasks = query.data?.items ?? [];
    const matched = filterAndSortTasks(tasks.filter((task) => taskMatchesQuery(task, queryState)), queryState.keyword);
    return sortTasksWithPins(matched, pinnedTaskIds);
  }, [pinnedTaskIds, query.data?.items, queryState]);

  useEffect(() => {
    void loadTaskPins(browserRuntime.storage).then(setPinnedTaskIds);
  }, []);

  const prevCommitDoneRef = useRef(0);
  useEffect(() => {
    if (commitQueue.summary.completed > prevCommitDoneRef.current) {
      queryClient.invalidateQueries({ queryKey: ["images"] });
    }
    prevCommitDoneRef.current = commitQueue.summary.completed;
  }, [commitQueue.summary.completed, queryClient]);

  useEffect(() => {
    const tasks = query.data?.items;
    if (!tasks) return;
    setPinnedTaskIds((current) => {
      const next = pruneTaskPins(current, tasks);
      if (next.length === current.length && next.every((id, index) => id === current[index])) return current;
      void saveTaskPins(browserRuntime.storage, next);
      return next;
    });
  }, [query.data?.items]);

  const handleTogglePin = useCallback((task: Task) => {
    setPinnedTaskIds((current) => {
      const next = toggleTaskPin(current, task);
      void saveTaskPins(browserRuntime.storage, next);
      return next;
    });
  }, []);

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

  const openSshInfo = useCallback((task: Task) => {
    setSshInfoTask(task);
  }, []);

  const openTerminal = useCallback((task: Task) => {
    const action = resolveTaskTerminalAction(task, {
      loginUsername: auth.user?.username ?? "",
      supportsInAppSsh: browserRuntime.supportsInAppSsh,
    });
    if (action.type === "app-ssh") {
      setAppSshRequest(action.request);
      return;
    }
    setSshInfoTask(task);
  }, [auth.user?.username]);

  const closeCreateTask = () => {
    setCreateOpen(false);
    setCloneTask(null);
  };

  const openEditTask = (task: Task) => {
    setEditTask(task);
  };

  const closeEditTask = () => {
    setEditTask(null);
  };

  const confirmReleaseTask = useCallback((task: Task) => {
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
  }, [confirm, releaseMutation, text]);

  const confirmDeleteTask = useCallback((task: Task) => {
    confirm({
      title: text("确认删除实例", "Confirm Instance Deletion"),
      description: text(
        `将删除 ${getTaskName(task)}。删除用于已结束等不可释放实例，从列表中移除记录；与「释放」不同，不会先停止仍在运行的任务。此操作不可从 EasyConsole 撤销。`,
        `Delete ${getTaskName(task)}. Delete removes finished / non-releasable instances from the list. Unlike Release, it is not for stopping a still-running task. EasyConsole cannot undo this.`,
      ),
      confirmLabel: text("删除", "Delete"),
      tone: "danger",
      run: () => deleteMutation.mutateAsync(task),
    });
  }, [confirm, deleteMutation, text]);

  const confirmCommitTask = useCallback((task: Task) => {
    let payload: ReturnType<typeof buildTaskCommitPayload>;
    try {
      payload = buildTaskCommitPayload(task);
    } catch (error) {
      toast.error(text("提交镜像失败", "Commit image failed"), error instanceof Error ? error.message : text("请稍后重试", "Try again later"));
      return;
    }
    confirm({
      title: text("确认提交镜像", "Confirm Commit Image"),
      description: text(`将把 ${getTaskName(task)} 的当前运行环境提交为镜像。此操作可能需要一段时间，请确认实例内文件状态已经稳定。`, `Commit the current runtime environment of ${getTaskName(task)} as an image. This may take some time; confirm files inside the instance are stable.`),
      confirmLabel: text("提交镜像", "Commit image"),
      run: () => {
        commitQueue.enqueue({
          taskName: getTaskName(task),
          taskId: task.id,
          podName: getTaskCommitPodName(task),
          payload,
        });
      },
    });
  }, [commitQueue, confirm, text, toast]);

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
          <label className={CHECKBOX_HIT_CLASS}>
            <input
              aria-label={text("选择当前页实例", "Select current page instances")}
              className="h-4 w-4 accent-app-accent"
              type="checkbox"
              checked={table.getIsAllPageRowsSelected()}
              onChange={table.getToggleAllPageRowsSelectedHandler()}
            />
          </label>
        ),
        cell: ({ row }) => (
          <label className={CHECKBOX_HIT_CLASS}>
            <input
              aria-label={text(`选择实例 ${getTaskName(row.original)}`, `Select instance ${getTaskName(row.original)}`)}
              className="h-4 w-4 accent-app-accent"
              type="checkbox"
              checked={row.getIsSelected()}
              onChange={row.getToggleSelectedHandler()}
            />
          </label>
        ),
      }),
      columnHelper.accessor((row) => getTaskName(row), {
        id: "name",
        header: text("实例名称", "Instance name"),
        cell: ({ row, getValue }) => {
          const pinned = isTaskPinned(pinnedTaskIds, row.original);
          return (
            <div className="whitespace-nowrap">
              <div className="flex items-start gap-1.5">
                {pinned ? <Pin className="mt-1 h-3.5 w-3.5 shrink-0 text-app-accent" aria-label={text("已置顶", "Pinned")} /> : null}
                <div>
                  <TaskInstanceName name={getValue()} taskId={row.original.id} />
                  <div className="mt-0.5 text-xs text-app-muted">#{row.original.id}</div>
                </div>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor("status", {
        header: text("状态", "Status"),
        cell: (info) => <StatusBadge status={info.getValue()} />,
      }),
      columnHelper.accessor((row) => resourceText(row), {
        id: "resource",
        header: text("资源", "Resources"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => getTaskNodeName(row) || "-", {
        id: "node",
        header: text("节点", "Node"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => endpointText(row), {
        id: "endpoint",
        header: text("入口", "Endpoint"),
        cell: (info) => <span className="whitespace-nowrap font-mono text-xs text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => ownerText(row), {
        id: "owner",
        header: text("用户", "User"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => groupText(row), {
        id: "group",
        header: text("用户组", "User group"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.use_time, {
        id: "duration",
        header: text("时长", "Duration"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{formatSecondsDuration(info.getValue(), locale)}</span>,
      }),
      columnHelper.accessor((row) => row.create_time ?? row.created_at ?? "-", {
        id: "created",
        header: text("创建时间", "Created"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.releace_time ?? "-", {
        id: "release",
        header: text("释放时间", "Release time"),
        cell: (info) => <span className="whitespace-nowrap text-app-text">{info.getValue()}</span>,
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
          <span className={info.getValue() === text("已删除", "Deleted") ? "text-app-danger" : "text-app-text"}>{info.getValue()}</span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: () => <ActionHeader />,
        cell: ({ row }) => {
          const task = row.original;
          const release = isReleasableTask(task);
          const opensAppSsh = willOpenAppSshSession(task, {
            loginUsername: auth.user?.username ?? "",
            supportsInAppSsh: browserRuntime.supportsInAppSsh,
          });
          const terminalLabel = opensAppSsh ? text("终端", "Terminal") : text("连接信息", "Connection info");
          const promoteLog = needsLogAttention(task);
          return (
            <div className={ACTION_GRID_CLASS}>
              <Button
                aria-label={
                  opensAppSsh
                    ? text(`打开 ${getTaskName(task)} 的终端`, `Open terminal for ${getTaskName(task)}`)
                    : text(`查看 ${getTaskName(task)} 的连接信息`, `View connection info for ${getTaskName(task)}`)
                }
                className="h-8 w-8 px-0"
                variant="ghost"
                title={terminalLabel}
                onClick={() => openTerminal(task)}
              >
                {opensAppSsh ? <Terminal className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
              </Button>
              {promoteLog ? (
                <Button
                  aria-label={text(`打开 ${getTaskName(task)} 的日志`, `Open logs for ${getTaskName(task)}`)}
                  className="h-8 w-8 px-0 text-app-danger"
                  title={text("日志", "Logs")}
                  variant="ghost"
                  onClick={() => setLogTask(task)}
                >
                  <FileText className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  aria-label={text(`打开 ${getTaskName(task)} 的监控`, `Open monitor for ${getTaskName(task)}`)}
                  className={["h-8 w-8 px-0", isRunningTask(task) ? "text-app-accent" : ""].join(" ")}
                  title={
                    isRunningTask(task)
                      ? text("监控（运行中）", "Monitor (running)")
                      : text("监控", "Monitor")
                  }
                  variant="ghost"
                  onClick={() => openMonitorDashboard(task)}
                >
                  <ActivitySquare className="h-4 w-4" />
                </Button>
              )}
              {release ? (
                <Button
                  className="h-8 w-16 justify-center px-1.5 text-app-muted hover:text-app-warning"
                  disabled={releaseMutation.isPending}
                  title={text("释放：停止实例并回收资源", "Release: stop instance and reclaim resources")}
                  variant="ghost"
                  onClick={() => confirmReleaseTask(task)}
                >
                  <Power className="h-4 w-4" />
                  {text("释放", "Release")}
                </Button>
              ) : (
                <Button
                  className="h-8 w-16 justify-center px-1.5 text-app-muted hover:text-app-danger"
                  disabled={deleteMutation.isPending}
                  title={text("删除：移除不可释放实例", "Delete: remove a non-releasable instance")}
                  variant="ghost"
                  onClick={() => confirmDeleteTask(task)}
                >
                  <Trash2 className="h-4 w-4" />
                  {text("删除", "Delete")}
                </Button>
              )}
              <MoreActionsMenu
                canEdit={getTaskEditableState() !== false}
                isPinned={isTaskPinned(pinnedTaskIds, task)}
                promoteLog={promoteLog}
                showSshInfo={opensAppSsh}
                task={task}
                onClone={openCloneTask}
                onCommit={confirmCommitTask}
                onDownload={handleDownloadTask}
                onEdit={openEditTask}
                onLog={setLogTask}
                onMonitor={openMonitorDashboard}
                onRaw={setRawTask}
                onSaveTemplate={(selectedTask) => saveTemplateMutation.mutate(selectedTask)}
                onSshInfo={openSshInfo}
                onTogglePin={handleTogglePin}
              />
            </div>
          );
        },
      }),
    ],
    [auth.user?.username, confirmCommitTask, confirmDeleteTask, confirmReleaseTask, deleteMutation.isPending, handleDownloadTask, handleTogglePin, locale, openSshInfo, openTerminal, pinnedTaskIds, releaseMutation.isPending, saveTemplateMutation, text],
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

  const tableScrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end : 0;

  const settingsHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [savedVisibility, savedAutoRefresh, savedInterval] = await Promise.all([
        loadColumnVisibility(),
        loadBooleanSetting(AUTO_REFRESH_KEY),
        loadNumberSetting(AUTO_REFRESH_INTERVAL_KEY, DEFAULT_AUTO_REFRESH_INTERVAL),
      ]);
      if (cancelled) return;
      setColumnVisibility(savedVisibility);
      setAutoRefresh(savedAutoRefresh);
      setAutoRefreshInterval(savedInterval);
      settingsHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void browserRuntime.storage.set(COLUMN_VISIBILITY_KEY, JSON.stringify(columnVisibility));
  }, [columnVisibility]);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void browserRuntime.storage.set(AUTO_REFRESH_KEY, String(autoRefresh));
  }, [autoRefresh]);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void browserRuntime.storage.set(AUTO_REFRESH_INTERVAL_KEY, String(autoRefreshInterval));
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

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setActiveRowIndex((index) => {
      if (filteredTasks.length === 0) return 0;
      return Math.min(index, filteredTasks.length - 1);
    });
  }, [filteredTasks.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isTyping) return;
      if (
        createOpen ||
        Boolean(editTask) ||
        Boolean(logTask) ||
        Boolean(sshInfoTask) ||
        Boolean(appSshRequest) ||
        Boolean(rawTask) ||
        columnSettingsOpen ||
        autoRefreshMenuOpen
      ) {
        return;
      }
      if (filteredTasks.length === 0) return;

      const key = event.key.toLowerCase();
      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        setActiveRowIndex((index) => Math.min(index + 1, filteredTasks.length - 1));
        return;
      }
      if (key === "k" || key === "arrowup") {
        event.preventDefault();
        setActiveRowIndex((index) => Math.max(index - 1, 0));
        return;
      }

      const task = filteredTasks[activeRowIndex];
      if (!task) return;

      if (key === "enter") {
        event.preventDefault();
        navigate(`/tasks/${task.id}`);
        return;
      }
      if (key === "l") {
        event.preventDefault();
        setLogTask(task);
        return;
      }
      if (key === "t") {
        event.preventDefault();
        openTerminal(task);
        return;
      }
      if (key === "r" && isReleasableTask(task)) {
        event.preventDefault();
        confirmReleaseTask(task);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeRowIndex,
    appSshRequest,
    autoRefreshMenuOpen,
    columnSettingsOpen,
    confirmReleaseTask,
    createOpen,
    editTask,
    filteredTasks,
    logTask,
    navigate,
    openTerminal,
    rawTask,
    sshInfoTask,
  ]);

  const closeAutoRefreshMenu = useCallback((restoreFocus = false) => {
    setAutoRefreshMenuOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => autoRefreshTriggerRef.current?.focus(), 0);
    }
  }, []);

  const focusAutoRefreshMenuItem = useCallback((index: number) => {
    const items = autoRefreshItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    const nextIndex = ((index % items.length) + items.length) % items.length;
    items[nextIndex]?.focus();
  }, []);

  useEffect(() => {
    if (!autoRefreshMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!autoRefreshMenuRef.current?.contains(event.target as Node)) {
        closeAutoRefreshMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeAutoRefreshMenu(true);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [autoRefreshMenuOpen, closeAutoRefreshMenu]);

  useEffect(() => {
    if (!autoRefreshMenuOpen) return;
    window.setTimeout(() => focusAutoRefreshMenuItem(autoRefreshInitialFocusRef.current), 0);
  }, [autoRefreshMenuOpen, focusAutoRefreshMenuItem]);

  const handleAutoRefreshTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    autoRefreshInitialFocusRef.current = event.key === "ArrowUp" ? -1 : 0;
    setAutoRefreshMenuOpen(true);
  };

  const handleAutoRefreshMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = autoRefreshItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    const currentIndex = items.findIndex((item) => item === document.activeElement);

    if (event.key === "Escape") {
      event.preventDefault();
      closeAutoRefreshMenu(true);
      return;
    }

    if (event.key === "Tab") {
      closeAutoRefreshMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAutoRefreshMenuItem(currentIndex + 1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAutoRefreshMenuItem(currentIndex - 1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusAutoRefreshMenuItem(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusAutoRefreshMenuItem(items.length - 1);
    }
  };

  const listUpdatedLabel = query.isFetching
    ? text("刷新中", "Refreshing")
    : query.dataUpdatedAt
      ? formatRelativeUpdatedAt(query.dataUpdatedAt, nowMs, text)
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <div className="relative w-full sm:w-auto">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" aria-hidden="true" />
            <Input
              aria-label={text("搜索实例名称", "Search instance name")}
              className="w-full pl-9 sm:w-64"
              placeholder={text("搜索实例名称", "Search instance name")}
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
            />
          </div>
          <Select
            aria-label={text("按状态筛选", "Filter by status")}
            className="w-32"
            value={queryState.status}
            onChange={(event) => updateTaskQuery({ status: event.target.value })}
          >
            <option value="">{text("全部状态", "All statuses")}</option>
            {Object.entries(locale === "en-US" ? taskStatusTextEn : taskStatusText).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button disabled={query.isFetching} variant="secondary" onClick={() => void query.refetch()}>
            <RefreshCw className={["h-4 w-4", query.isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
            {text("刷新", "Refresh")}
          </Button>
          <div ref={autoRefreshMenuRef} className="relative flex items-center gap-2">
            <Button
              ref={autoRefreshTriggerRef}
              aria-controls={autoRefreshMenuOpen ? autoRefreshMenuId : undefined}
              aria-expanded={autoRefreshMenuOpen}
              aria-haspopup="menu"
              aria-pressed={autoRefresh}
              className={
                autoRefresh
                  ? autoRefreshPaused
                    ? "border-app-warning/40 text-app-warning hover:bg-app-warningSoft"
                    : "border-app-accent/40 text-app-accent hover:bg-app-accentSoft"
                  : undefined
              }
              title={
                autoRefresh
                  ? autoRefreshPaused
                    ? text("自动刷新已暂停（面板打开时）", "Auto refresh paused (panel open)")
                    : text(`每 ${autoRefreshIntervalLabel(autoRefreshInterval, locale)} 自动刷新`, `Auto refresh every ${autoRefreshIntervalLabel(autoRefreshInterval, locale)}`)
                  : text("自动刷新间隔", "Auto refresh interval")
              }
              type="button"
              variant="secondary"
              onClick={() => {
                autoRefreshInitialFocusRef.current = 0;
                setAutoRefreshMenuOpen((open) => !open);
              }}
              onKeyDown={handleAutoRefreshTriggerKeyDown}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {autoRefresh
                ? autoRefreshPaused
                  ? text(`已暂停 · ${autoRefreshIntervalLabel(autoRefreshInterval, locale)}`, `Paused · ${autoRefreshIntervalLabel(autoRefreshInterval, locale)}`)
                  : text(`自动 · ${autoRefreshIntervalLabel(autoRefreshInterval, locale)}`, `Auto · ${autoRefreshIntervalLabel(autoRefreshInterval, locale)}`)
                : text("自动刷新", "Auto refresh")}
            </Button>
            {listUpdatedLabel ? (
              <span className="hidden text-xs text-app-muted sm:inline" aria-live="polite">
                {listUpdatedLabel}
              </span>
            ) : null}
            {autoRefreshMenuOpen ? (
              <div
                id={autoRefreshMenuId}
                ref={autoRefreshMenuListRef}
                role="menu"
                aria-label={text("自动刷新间隔", "Auto refresh interval")}
                className="absolute left-0 top-full z-30 mt-1 w-40 rounded-lg border border-app-border bg-app-surface p-1 shadow-popover"
                onKeyDown={handleAutoRefreshMenuKeyDown}
              >
                <button
                  ref={(element) => {
                    autoRefreshItemRefs.current[0] = element;
                  }}
                  className={MENU_ITEM_CLASS}
                  role="menuitemradio"
                  aria-checked={!autoRefresh}
                  tabIndex={-1}
                  type="button"
                  onClick={() => {
                    setAutoRefresh(false);
                    closeAutoRefreshMenu();
                  }}
                >
                  {text("关闭", "Off")}
                </button>
                {autoRefreshOptions.map((option, optionIndex) => {
                  const selected = autoRefresh && autoRefreshInterval === option.value;
                  const itemIndex = optionIndex + 1;
                  return (
                    <button
                      key={option.value}
                      ref={(element) => {
                        autoRefreshItemRefs.current[itemIndex] = element;
                      }}
                      className={MENU_ITEM_CLASS}
                      role="menuitemradio"
                      aria-checked={selected}
                      tabIndex={-1}
                      type="button"
                      onClick={() => {
                        setAutoRefresh(true);
                        setAutoRefreshInterval(option.value);
                        closeAutoRefreshMenu();
                      }}
                    >
                      {locale === "en-US" ? option.en : option.zh}
                    </button>
                  );
                })}
              </div>
            ) : null}
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
          <div className="min-w-0 space-y-0.5 text-sm text-app-muted">
            <div>
              {text("已选", "Selected")} <span className="font-medium text-app-text">{selectedTasks.length}</span> {text("个实例", "instances")}
              {selectedReleasableTasks.length > 0 ? text(`，可释放 ${selectedReleasableTasks.length} 个`, `, releasable ${selectedReleasableTasks.length}`) : ""}
              {selectedNonReleasableTasks.length > 0 ? text(`，不可释放 ${selectedNonReleasableTasks.length} 个`, `, non-releasable ${selectedNonReleasableTasks.length}`) : ""}
            </div>
            <p className="text-xs text-app-muted">
              {text(
                "释放：停止并回收可释放实例。删除：移除不可释放（通常已结束）实例，不可撤销。",
                "Release: stop and reclaim releasable instances. Delete: remove non-releasable (usually finished) instances; cannot undo.",
              )}
            </p>
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
          <EmptyState icon={SearchXIcon} title={text("未找到匹配实例", "No matching instances")} action={<Button variant="secondary" onClick={() => updateTaskQuery({ keyword: "" })}>{text("清空搜索", "Clear search")}</Button>} />
        ) : table.getRowModel().rows.length === 0 ? (
          <EmptyState title={text("暂无任务实例", "No task instances")} action={<Button onClick={openCreateTask}>{text("新建任务", "New task")}</Button>} />
        ) : (
          <>
          {browserRuntime.isMobile ? (
          <div className="divide-y divide-app-border">
            {table.getRowModel().rows.map((row, rowIndex) => {
              const task = row.original;
              const release = isReleasableTask(task);
              const taskName = getTaskName(task);
              return (
                <article
                  key={row.id}
                  className={[
                    "space-y-3 px-3 py-3",
                    isRunningTask(task) ? "bg-app-infoSoft/40" : "",
                    activeRowIndex === rowIndex ? "bg-app-accentSoft/50 ring-1 ring-inset ring-app-accent/30" : "",
                  ].join(" ")}
                  aria-labelledby={`task-card-${row.id}`}
                >
                  <div className="flex items-start gap-3">
                    <label className={`${CHECKBOX_HIT_CLASS} mt-0.5 shrink-0`}>
                      <input
                        aria-label={text(`选择 ${taskName}`, `Select ${taskName}`)}
                        className="h-4 w-4 accent-app-accent"
                        type="checkbox"
                        checked={row.getIsSelected()}
                        onChange={row.getToggleSelectedHandler()}
                      />
                    </label>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 id={`task-card-${row.id}`} className="flex min-w-0 flex-1 items-center gap-1.5">
                          {isTaskPinned(pinnedTaskIds, task) ? <Pin className="h-3.5 w-3.5 shrink-0 text-app-accent" aria-label={text("已置顶", "Pinned")} /> : null}
                          <span className="min-w-0 flex-1"><TaskInstanceName compact name={taskName} taskId={task.id} /></span>
                        </h3>
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
                    {(() => {
                      const opensAppSsh = willOpenAppSshSession(task, {
                        loginUsername: auth.user?.username ?? "",
                        supportsInAppSsh: browserRuntime.supportsInAppSsh,
                      });
                      const terminalLabel = opensAppSsh ? text("终端", "Terminal") : text("连接信息", "Connection info");
                      const promoteLog = needsLogAttention(task);
                      return (
                        <>
                        <Button
                          aria-label={
                            opensAppSsh
                              ? text(`打开 ${taskName} 的终端`, `Open terminal for ${taskName}`)
                              : text(`查看 ${taskName} 的连接信息`, `View connection info for ${taskName}`)
                          }
                          className="h-9 px-2"
                          variant="ghost"
                          title={terminalLabel}
                          onClick={() => openTerminal(task)}
                        >
                          {opensAppSsh ? <Terminal className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                          {terminalLabel}
                        </Button>
                        {promoteLog ? (
                          <Button
                            className="h-9 px-2 text-app-danger"
                            title={text("日志", "Logs")}
                            variant="ghost"
                            onClick={() => setLogTask(task)}
                          >
                            <FileText className="h-4 w-4" />
                            {text("日志", "Logs")}
                          </Button>
                        ) : isRunningTask(task) ? (
                          <Button
                            className="h-9 px-2 text-app-accent"
                            title={text("监控", "Monitor")}
                            variant="ghost"
                            onClick={() => openMonitorDashboard(task)}
                          >
                            <ActivitySquare className="h-4 w-4" />
                            {text("监控", "Monitor")}
                          </Button>
                        ) : null}
                        {release ? (
                          <Button
                            className="h-9 px-2 text-app-muted hover:text-app-warning"
                            disabled={releaseMutation.isPending}
                            title={text("释放：停止实例并回收资源", "Release: stop instance and reclaim resources")}
                            variant="ghost"
                            onClick={() => confirmReleaseTask(task)}
                          >
                            <Power className="h-4 w-4" />
                            {text("释放", "Release")}
                          </Button>
                        ) : (
                          <Button
                            className="h-9 px-2 text-app-muted hover:text-app-danger"
                            disabled={deleteMutation.isPending}
                            title={text("删除：移除不可释放实例", "Delete: remove a non-releasable instance")}
                            variant="ghost"
                            onClick={() => confirmDeleteTask(task)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {text("删除", "Delete")}
                          </Button>
                        )}
                        <MoreActionsMenu
                          canEdit={getTaskEditableState() !== false}
                          isPinned={isTaskPinned(pinnedTaskIds, task)}
                          promoteLog={promoteLog}
                          showSshInfo={opensAppSsh}
                          task={task}
                          onClone={openCloneTask}
                          onCommit={confirmCommitTask}
                          onDownload={handleDownloadTask}
                          onEdit={openEditTask}
                          onLog={setLogTask}
                          onMonitor={openMonitorDashboard}
                          onRaw={setRawTask}
                          onSaveTemplate={(selectedTask) => saveTemplateMutation.mutate(selectedTask)}
                          onSshInfo={openSshInfo}
                          onTogglePin={handleTogglePin}
                        />
                        </>
                      );
                    })()}
                  </div>
                </article>
              );
            })}
          </div>
          ) : (
          <TableRegion ref={tableScrollRef} label={text("任务实例表格", "Task instances table")}>
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        scope="col"
                        className={[
                          "sticky top-0 z-10 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 font-medium",
                          isActionsColumn(header.column.id)
                            ? "sticky right-0 z-20 shadow-stickyColumn"
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
                {paddingTop > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={table.getVisibleLeafColumns().length} style={{ height: paddingTop, padding: 0, border: 0 }} />
                  </tr>
                ) : null}
                {virtualRows.map((virtualRow) => {
                  const row = tableRows[virtualRow.index];
                  return (
                    <tr
                      key={row.id}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      className={[
                        "relative border-b border-app-border last:border-0 hover:z-20",
                        activeRowIndex === virtualRow.index
                          ? "bg-app-accentSoft/50 ring-1 ring-inset ring-app-accent/25"
                          : isRunningTask(row.original)
                            ? "bg-app-infoSoft/40 hover:bg-app-panel/60"
                            : "hover:bg-app-panel/60",
                      ].join(" ")}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={[
                            "whitespace-nowrap px-3 py-2 align-middle",
                            isActionsColumn(cell.column.id)
                              ? [
                                  "sticky right-0 z-30 shadow-stickyColumn",
                                  activeRowIndex === virtualRow.index
                                    ? "bg-app-accentSoft/50"
                                    : isRunningTask(row.original)
                                      ? "bg-app-infoSoft/40"
                                      : "bg-app-surface",
                                ].join(" ")
                              : "",
                          ].join(" ")}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={table.getVisibleLeafColumns().length} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableRegion>
          )}
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

      <Suspense fallback={<LoadingState />}>
        <CreateTaskDialog initialTask={cloneTask} open={createOpen} onClose={closeCreateTask} />
        <CreateTaskDialog mode="edit" editTaskId={editTask?.id} initialTask={editTask} open={Boolean(editTask)} onClose={closeEditTask} />
        <TaskLogDialog task={logTask} onClose={() => setLogTask(null)} />
        <TerminalDialog
          task={sshInfoTask}
          onClose={() => setSshInfoTask(null)}
          onOpenAppSsh={(request) => {
            setSshInfoTask(null);
            setAppSshRequest(request);
          }}
        />
      </Suspense>
      <AppSshTerminalDialog request={appSshRequest} onClose={() => setAppSshRequest(null)} />
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
