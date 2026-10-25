import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ActivitySquare,
  ArrowDown,
  ArrowUp,
  Braces,
  CopyPlus,
  Download,
  FileText,
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
  TerminalSquare,
  Trash2,
  Upload,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { FAILURE_STATUSES, needsLogAttention } from "../lib/task-status-notifications";

import { EmptyState, ErrorState, LoadingState, SearchXIcon, TableSkeleton } from "../components/DataState";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { StatusBadge } from "../components/StatusBadge";
import { BatchReleaseImpact, ReleaseConfirmDescription } from "../components/tasks/ReleaseConfirmDescription";
import { TaskInstanceName } from "../components/tasks/TaskInstanceName";
import { Button, Dialog, Input, Panel, Select, TableRegion } from "../components/ui";
import { instanceApi } from "../lib/api";
import { getTaskEditableState } from "../lib/api-factory";
import { BatchPreviewDialog, type BatchPreviewItem } from "../components/batch/BatchPreviewDialog";
import { BatchHistoryPanel } from "../components/batch/BatchHistoryPanel";
import { BatchResultDialog } from "../components/batch/BatchResultDialog";
import { batchExportPayload } from "../components/batch/batch-export";
import { useBatchOperation } from "../components/batch/use-batch-operation";
import { RelativeUpdatedAt } from "../components/RelativeUpdatedAt";
import type { BatchRunResult } from "../lib/batch-runner";
import type { BatchOperationRecord } from "../lib/change-list";
import { saveBlob } from "../lib/download";
import { useCommitQueue } from "../lib/commit-queue-context";
import { useDownloadQueueActions } from "../lib/use-download-queue";
import { asJson, formatCost, formatSecondsDuration, getStatusText, getTaskName, getTaskNodeName, localizedText, taskStatusText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { useSshWorkspace } from "../lib/use-ssh-workspace";
import { i18nText } from "../lib/i18n-text";
import { openMonitorDashboard } from "../lib/monitor-dashboard";
import { browserRuntime } from "../lib/runtime";
import { getRuntimeSettings } from "../lib/app-settings";
import {
  isTaskPinned,
  loadTaskPins,
  pruneTaskPins,
  saveTaskPins,
  toggleTaskPin,
} from "../lib/task-pins";
import { createTaskTemplate, loadTaskTemplates, saveTaskTemplates, taskToEditableTaskTemplate } from "../lib/task-templates";
import { TASK_PAGE_SIZE_OPTIONS, type TaskListSortBy } from "../lib/task-list-query";
import { consumePendingCreateTaskRequest, subscribeCreateTaskRequests } from "../lib/task-create-request";
import { invalidateTaskQueries } from "../lib/task-snapshot-query";
import { queryKeys } from "../lib/query-keys";
import type { Task } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { getTaskAccess } from "../lib/task-terminal";
import { useCompactLayout } from "../lib/use-compact-layout";
import { useAuth } from "../lib/use-auth";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";
import { useMobileBackLayer } from "../lib/use-mobile-back-stack";
import { claimOverlayKey, hasOpenModalOverlay, useOverlay } from "../lib/overlay-stack";
import { cn } from "../lib/utils";
import { useTaskListController } from "./tasks/use-task-list-controller";

const columnHelper = createColumnHelper<Task>();
const CreateTaskDialog = lazy(() => import("../components/tasks/CreateTaskDialog").then((module) => ({ default: module.CreateTaskDialog })));
const TaskLogDialog = lazy(() => import("../components/tasks/TaskLogDialog").then((module) => ({ default: module.TaskLogDialog })));
const TerminalDialog = lazy(() => import("../components/tasks/TerminalDialog").then((module) => ({ default: module.TerminalDialog })));
const COLUMN_VISIBILITY_KEY = "easy-console.tasks.columnVisibility";
const ALWAYS_VISIBLE_COLUMNS = new Set(["select", "actions"]);
// Pages at or under this many phone cards render whole (the 20-per-page option always does).
const MOBILE_CARD_VIRTUALIZE_MIN = 30;
const defaultColumnVisibility: VisibilityState = {
  node: false,
  endpoint: false,
  owner: false,
  group: false,
  duration: false,
  billed: false,
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
  // Not "cost": that id once named the duration column and is migrated to it on load.
  billed: { zh: "费用", en: "Cost" },
  created: { zh: "创建时间", en: "Created" },
  release: { zh: "释放时间", en: "Release time" },
  releaseCondition: { zh: "释放条件", en: "Release condition" },
  deleted: { zh: "删除状态", en: "Delete status" },
};
const ACTION_GRID_CLASS = "grid grid-cols-[2rem_2rem_2rem_4rem_2rem] items-center gap-1";
const COMPACT_ACTION_GRID_CLASS = "grid grid-cols-[4rem_2rem] items-center gap-1";
/** Table regions narrower than this fold the row's terminal / log / clone buttons into More. */
const COMPACT_ACTIONS_MAX_WIDTH = 1040;
const MENU_ITEM_CLASS =
  "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";
const MENU_ITEM_DANGER_CLASS =
  "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-danger hover:bg-app-dangerSoft disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";
const CHECKBOX_HIT_CLASS =
  "inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
const commitPodFields = ["description", "pod_name", "podName", "pod", "k8s_pod_name", "k8sPodName"];

function resourceText(task: Task) {
  return `${task.cpu ?? "-"}C / ${task.gpu ?? "-"}GPU / ${task.memory ?? "-"}G`;
}

/**
 * Batch item summary: what the item costs and where its results live. No status here, since
 * the result dialog shows the item's outcome beside it and a pre-run status would read as stale.
 */
function batchItemMeta(task: Task, locale: "zh-CN" | "en-US", text: (zh: string, en: string) => string) {
  const parts = [resourceText(task)];
  const runtime = Number(task.use_time);
  if (Number.isFinite(runtime) && runtime > 0) parts.push(text(`运行 ${formatSecondsDuration(runtime, locale)}`, `ran ${formatSecondsDuration(runtime, locale)}`));
  const cost = Number(task.cost);
  if (Number.isFinite(cost) && cost > 0) parts.push(formatCost(cost, locale));
  const storagePath = typeof task.storage_path === "string" ? task.storage_path.trim() : "";
  if (storagePath) parts.push(storagePath);
  return parts.join(" · ");
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

function isTroubleTask(task: Task) {
  return FAILURE_STATUSES.has(Number(task.status));
}

function isActionsColumn(id: string) {
  return id === "actions";
}

// One visible "操作" label: each button names itself (aria-label + title), so the header
// does not need a row of icons that only tooltips can explain.
function ActionHeader() {
  const { text } = useI18n();
  return <div className="px-1 text-app-muted">{text("操作", "Actions")}</div>;
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
    // Columns added after the preference was saved start at their default (hidden) state.
    return { ...defaultColumnVisibility, ...parsed };
  } catch {
    return defaultColumnVisibility;
  }
}

type MoreMenuPosition = { left: number; top: number };

type TaskAction = (task: Task) => void;

/**
 * Per-render state the table cells read through `table.options.meta`. The column
 * definitions depend only on the language, so each cell function keeps one identity
 * and `flexRender` re-renders a row's controls instead of remounting them. Remounts
 * dropped keyboard focus and swallowed first clicks every time the page re-rendered.
 */
type TaskTableMeta = {
  pinnedTaskIds: string[];
  moreMenuTaskId: string | null;
  releasePending: boolean;
  compactActions: boolean;
  onTerminal: TaskAction;
  onLog: TaskAction;
  onClone: TaskAction;
  onRelease: TaskAction;
  onCommit: TaskAction;
  onDelete: TaskAction;
  onDownload: TaskAction;
  onEdit: TaskAction;
  onRaw: TaskAction;
  onSaveTemplate: TaskAction;
  onSshInfo: TaskAction;
  onTogglePin: TaskAction;
  onMoreMenuOpenChange: (taskId: string, open: boolean, position?: MoreMenuPosition, trigger?: HTMLElement | null) => void;
};

function taskTableMeta(table: { options: { meta?: unknown } }) {
  return table.options.meta as TaskTableMeta;
}

type MoreMenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  title?: string;
  /** Short visible reason, shown when the item is disabled (a title alone is unreachable by keyboard). */
  hint?: string;
  tone?: "danger";
  onSelect: () => void;
};

type MoreMenuSection = { id: string; items: MoreMenuItem[] };

function computeMoreMenuPosition(anchor: DOMRect, itemCount: number, sectionCount: number): MoreMenuPosition {
  const width = 176;
  const margin = 8;
  const estimatedHeight = Math.min(320, 8 + itemCount * 32 + Math.max(0, sectionCount - 1) * 9);
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const left = Math.min(Math.max(margin, anchor.right - width), Math.max(margin, viewportWidth - width - margin));
  const top =
    anchor.bottom + estimatedHeight + margin > viewportHeight ? anchor.top - estimatedHeight - 4 : anchor.bottom + 4;
  return { left, top: Math.max(margin, top) };
}

function buildMoreMenuSections({
  task,
  isPinned,
  canEdit,
  promoteLog,
  promoteClone,
  showSshInfo,
  text,
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
  onDelete,
}: {
  task: Task;
  isPinned: boolean;
  canEdit: boolean;
  promoteLog: boolean;
  promoteClone: boolean;
  showSshInfo: boolean;
  text: (zh: string, en: string) => string;
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
  onDelete?: (task: Task) => void;
}): MoreMenuSection[] {
  const running = isRunningTask(task);
  const access = getTaskAccess(task);
  const logItem: MoreMenuItem = {
    key: "log",
    label: text("日志", "Logs"),
    icon: <FileText className="h-4 w-4 text-app-muted" />,
    disabled: !access.log,
    title: access.logReason,
    hint: access.log ? undefined : text("未启动", "Not started"),
    onSelect: () => onLog(task),
  };
  const monitorItem: MoreMenuItem | null =
    promoteLog && onMonitor
      ? {
          key: "monitor",
          label: text("监控", "Monitor"),
          icon: <ActivitySquare className="h-4 w-4 text-app-muted" />,
          onSelect: () => onMonitor(task),
        }
      : null;
  const sshInfoItem: MoreMenuItem | null = showSshInfo
    ? {
        key: "ssh-info",
        label: text("终端", "Terminal"),
        icon: <TerminalSquare className="h-4 w-4 text-app-muted" />,
        disabled: !access.terminal,
        title: access.terminalReason,
        hint: access.terminal ? undefined : text("仅运行中", "Running only"),
        onSelect: () => onSshInfo(task),
      }
    : null;

  const connect: MoreMenuItem[] = promoteLog
    ? [...(monitorItem ? [monitorItem] : []), ...(sshInfoItem ? [sshInfoItem] : [])]
    : [logItem, ...(sshInfoItem ? [sshInfoItem] : [])];

  const lifecycle: MoreMenuItem[] = [];
  if (!promoteClone) {
    lifecycle.push({
      key: "clone",
      label: text("克隆", "Clone"),
      icon: <CopyPlus className="h-4 w-4 text-app-muted" />,
      onSelect: () => onClone(task),
    });
  }
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
    hint: running ? undefined : text("仅运行中", "Running only"),
    onSelect: () => onCommit(task),
  });

  const local: MoreMenuItem[] = [
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

  // Delete lives here, last and apart, rather than in the row slot release uses: the row
  // slot never changes meaning when a task changes state between refreshes.
  const danger: MoreMenuItem[] = onDelete && !isReleasableTask(task)
    ? [{
        key: "delete",
        label: text("删除实例", "Delete instance"),
        icon: <Trash2 className="h-4 w-4" />,
        tone: "danger",
        onSelect: () => onDelete(task),
      }]
    : [];

  return [
    { id: "connect", items: connect },
    { id: "lifecycle", items: lifecycle },
    { id: "local", items: local },
    ...(danger.length > 0 ? [{ id: "danger", items: danger }] : []),
  ];
}

function MoreActionsMenuPanel({
  task,
  position,
  menuId,
  initialFocusIndex,
  triggerRef,
  promoteLog,
  promoteClone,
  showSshInfo,
  isPinned,
  canEdit,
  onClose,
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
  onDelete,
}: {
  task: Task;
  position: MoreMenuPosition;
  menuId: string;
  initialFocusIndex: number;
  triggerRef: MutableRefObject<HTMLElement | null>;
  promoteLog: boolean;
  promoteClone: boolean;
  showSshInfo: boolean;
  isPinned: boolean;
  canEdit: boolean;
  onClose: (restoreFocus?: boolean) => void;
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
  onDelete?: (task: Task) => void;
}) {
  const { text } = useI18n();
  const compactLayout = useCompactLayout();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [menuPosition, setMenuPosition] = useState(position);
  const taskId = taskRowId(task);
  useMobileBackLayer(compactLayout, () => onClose());
  const layerRef = useOverlay(true, "popover");

  const menuSections = useMemo(
    () =>
      buildMoreMenuSections({
        task,
        isPinned,
        canEdit,
        promoteLog,
        promoteClone,
        showSshInfo,
        text,
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
        onDelete,
      }),
    [
      canEdit,
      isPinned,
      onClone,
      onCommit,
      onDelete,
      onDownload,
      onEdit,
      onLog,
      onMonitor,
      onRaw,
      onSaveTemplate,
      onSshInfo,
      onTogglePin,
      promoteClone,
      promoteLog,
      showSshInfo,
      task,
      text,
    ],
  );
  const menuItems = useMemo(() => menuSections.flatMap((section) => section.items), [menuSections]);

  const focusMenuItem = useCallback((index: number) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    const nextIndex = (index + items.length) % items.length;
    items[nextIndex].focus();
  }, []);

  const resolveTrigger = useCallback(() => {
    const current = triggerRef.current;
    if (current && document.contains(current)) return current;
    const rebound = document.querySelector<HTMLElement>(`[data-task-more-trigger="${taskId}"]`);
    if (rebound) {
      triggerRef.current = rebound;
      return rebound;
    }
    return null;
  }, [taskId, triggerRef]);

  useEffect(() => {
    setMenuPosition(position);
  }, [position]);

  useEffect(() => {
    window.setTimeout(() => focusMenuItem(initialFocusIndex), 0);
  }, [focusMenuItem, initialFocusIndex]);

  useEffect(() => {
    const updatePosition = () => {
      const trigger = resolveTrigger();
      if (!trigger) {
        onClose();
        return;
      }
      const rect = trigger.getBoundingClientRect();
      // Keep the menu open through transient zero-rect layout passes (virtualized rows / jsdom).
      if (rect.width <= 0 && rect.height <= 0) return;
      setMenuPosition(computeMoreMenuPosition(rect, menuItems.length, menuSections.length));
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const trigger = resolveTrigger();
      if (trigger?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && claimOverlayKey(layerRef.current, event)) {
        event.stopPropagation();
        onClose(true);
      }
    };
    const handleScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      updatePosition();
    };
    const handleWheel = (event: WheelEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) return;
      event.stopPropagation();
      const menu = menuRef.current;
      if (menu.scrollHeight <= menu.clientHeight) event.preventDefault();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("wheel", handleWheel, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [layerRef, menuItems.length, menuSections.length, onClose, resolveTrigger]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    const currentIndex = items.findIndex((item) => item === document.activeElement);

    if (event.key === "Escape") {
      event.preventDefault();
      if (claimOverlayKey(layerRef.current, event.nativeEvent)) onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose();
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

  return createPortal(
    <div
      className={cn(compactLayout ? "app-scrim fixed inset-0 z-[100] flex items-end" : "contents")}
      onMouseDown={(event) => {
        if (compactLayout && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id={menuId}
        ref={menuRef}
        className={cn(
          compactLayout
            ? "app-mobile-action-sheet max-h-[80dvh] w-full overflow-y-auto overscroll-contain rounded-t-lg border border-b-0 border-app-border bg-app-elevated p-2 shadow-popover"
            : "app-pop-enter fixed z-[100] max-h-[min(20rem,calc(100vh-1rem))] w-44 origin-top-right overflow-y-auto overscroll-contain rounded-lg border border-app-border bg-app-elevated p-1 shadow-popover",
        )}
        role="menu"
        aria-label={text(`实例操作 ${getTaskName(task)}`, `Instance actions for ${getTaskName(task)}`)}
        style={compactLayout ? { paddingBottom: "env(safe-area-inset-bottom, 0px)" } : { left: menuPosition.left, top: menuPosition.top }}
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
                className={item.tone === "danger" ? MENU_ITEM_DANGER_CLASS : MENU_ITEM_CLASS}
                disabled={item.disabled}
                role="menuitem"
                tabIndex={-1}
                title={item.title}
                type="button"
                onClick={() => {
                  if (item.disabled) return;
                  onClose();
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
                {item.disabled && item.hint ? <span className="ml-auto pl-2 text-xs text-app-muted">{item.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
      </div>
    </div>,
    document.body,
  );
}

export function MoreActionsMenu({
  task,
  isPinned,
  canEdit,
  promoteLog = false,
  promoteClone = false,
  showSshInfo = true,
  open: openControlled,
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
  onDelete,
  onOpenChange,
}: {
  task: Task;
  isPinned: boolean;
  canEdit: boolean;
  /** When true, logs are on the primary action strip; expose monitor in More instead (and omit Logs there). */
  promoteLog?: boolean;
  /** When true, clone is on the primary action strip; omit Clone from More. */
  promoteClone?: boolean;
  /** Controlled open state. When set, the parent owns open/close (needed for virtualized rows). */
  open?: boolean;
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
  /** Offered (as the last, danger item) only for tasks that can no longer be released. */
  onDelete?: (task: Task) => void;
  /** When false, hide connection info in More (already on the action strip). */
  showSshInfo?: boolean;
  /** Notify parent when the menu opens/closes. Position is included so the parent can host the portal. */
  onOpenChange?: (taskId: string, open: boolean, position?: MoreMenuPosition, trigger?: HTMLElement | null) => void;
}) {
  const { text } = useI18n();
  const menuId = useId();
  const [openUncontrolled, setOpenUncontrolled] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MoreMenuPosition | null>(null);
  const [initialFocusIndex, setInitialFocusIndex] = useState(0);
  const triggerRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const taskId = taskRowId(task);
  const controlled = openControlled !== undefined;
  const open = controlled ? openControlled : openUncontrolled;

  const menuItemCount = useMemo(() => {
    const sections = buildMoreMenuSections({
      task,
      isPinned,
      canEdit,
      promoteLog,
      promoteClone,
      showSshInfo,
      text,
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
      onDelete,
    });
    return {
      items: sections.reduce((sum, section) => sum + section.items.length, 0),
      sections: sections.length,
    };
  }, [
    canEdit,
    isPinned,
    onClone,
    onCommit,
    onDelete,
    onDownload,
    onEdit,
    onLog,
    onMonitor,
    onRaw,
    onSaveTemplate,
    onSshInfo,
    onTogglePin,
    promoteClone,
    promoteLog,
    showSshInfo,
    task,
    text,
  ]);

  const closeMenu = useCallback(
    (restoreFocus = false) => {
      if (!controlled) {
        setOpenUncontrolled(false);
        setMenuPosition(null);
      }
      onOpenChange?.(taskId, false);
      if (restoreFocus) window.setTimeout(() => triggerButtonRef.current?.focus(), 0);
    },
    [controlled, onOpenChange, taskId],
  );

  const openMenu = useCallback(
    (focusIndex: number) => {
      const rect = triggerRef.current?.getBoundingClientRect() ?? triggerButtonRef.current?.getBoundingClientRect();
      const position = rect
        ? computeMoreMenuPosition(rect, menuItemCount.items, menuItemCount.sections)
        : { left: 8, top: 8 };
      setInitialFocusIndex(focusIndex);
      if (!controlled) {
        setMenuPosition(position);
        setOpenUncontrolled(true);
      }
      onOpenChange?.(taskId, true, position, triggerRef.current);
    },
    [controlled, menuItemCount.items, menuItemCount.sections, onOpenChange, taskId],
  );

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (open) return;
    openMenu(event.key === "ArrowUp" ? -1 : 0);
  };

  return (
    <div ref={triggerRef} className="relative z-30" data-task-more-trigger={taskId}>
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
          if (open) {
            closeMenu();
            return;
          }
          openMenu(0);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {!controlled && open && menuPosition ? (
        <MoreActionsMenuPanel
          task={task}
          position={menuPosition}
          menuId={menuId}
          initialFocusIndex={initialFocusIndex}
          triggerRef={triggerRef}
          promoteLog={promoteLog}
          promoteClone={promoteClone}
          showSshInfo={showSshInfo}
          isPinned={isPinned}
          canEdit={canEdit}
          onClose={closeMenu}
          onLog={onLog}
          onClone={onClone}
          onSshInfo={onSshInfo}
          onMonitor={onMonitor}
          onRaw={onRaw}
          onDownload={onDownload}
          onCommit={onCommit}
          onEdit={onEdit}
          onSaveTemplate={onSaveTemplate}
          onTogglePin={onTogglePin}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );
}

export function TasksPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const downloadQueue = useDownloadQueueActions();
  const commitQueue = useCommitQueue();
  const auth = useAuth();
  const { confirm, confirmDialog } = useConfirmAction();
  const compactLayout = useCompactLayout();
  const [createOpen, setCreateOpen] = useState(consumePendingCreateTaskRequest);
  const [cloneTask, setCloneTask] = useState<Task | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);
  const [sshInfoTask, setSshInfoTask] = useState<Task | null>(null);
  // The global in-app SSH workspace replaces the page-local dialog state: the
  // workspace lives above every route, so switching pages keeps sessions.
  const sshWorkspace = useSshWorkspace();
  const sshWorkspaceOpen = sshWorkspace.tabs.length > 0;
  const [rawTask, setRawTask] = useState<Task | null>(null);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(defaultColumnVisibility);
  const [pinnedTaskIds, setPinnedTaskIds] = useState<string[]>([]);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<null | {
    taskId: string;
    left: number;
    top: number;
  }>(null);
  const [pageJumpInput, setPageJumpInput] = useState("");
  const viewMenuId = useId();
  const moreActionsMenuId = useId();
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const mobileCardsRef = useRef<HTMLDivElement>(null);
  // Phone cards scroll with the page (<main>), not in a box of their own, so their virtualizer
  // measures against <main> and offsets by where the list starts inside it. The offset moves
  // when anything above the list changes size, so it is re-read on every resize.
  const [cardScroll, setCardScroll] = useState<{ element: HTMLElement; margin: number } | null>(null);
  // When the table region itself is narrow (the 1024px minimum window, a wide sidebar, browser
  // zoom), the sticky action column folds terminal, log and clone into More, so status and
  // resources stay in view instead of sliding under a 232px action strip.
  const [compactActions, setCompactActions] = useState(false);
  const tableRegionCallbackRef = useCallback((node: HTMLDivElement | null) => {
    tableScrollRef.current = node;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    // The first callback fires as observation starts, so the initial width is covered too.
    const observer = new ResizeObserver(([entry]) => setCompactActions(entry.contentRect.width < COMPACT_ACTIONS_MAX_WIDTH));
    observer.observe(node);
    return () => {
      observer.disconnect();
      tableScrollRef.current = null;
    };
  }, []);
  const mobileCardsCallbackRef = useCallback((node: HTMLDivElement | null) => {
    mobileCardsRef.current = node;
    const scroller = node?.closest<HTMLElement>("#main-content");
    if (!node || !scroller) return undefined;
    const measure = () => {
      const margin = Math.round(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
      setCardScroll((current) => (current?.element === scroller && current.margin === margin ? current : { element: scroller, margin }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const moreMenuTriggerRef = useRef<HTMLElement | null>(null);
  const moreMenuOpen = moreMenu !== null;

  const handleMoreMenuOpenChange = useCallback((
    taskId: string,
    open: boolean,
    position?: MoreMenuPosition,
    trigger?: HTMLElement | null,
  ) => {
    if (!open) {
      setMoreMenu((prev) => (prev?.taskId === taskId ? null : prev));
      if (moreMenuTriggerRef.current && (!trigger || moreMenuTriggerRef.current === trigger)) {
        moreMenuTriggerRef.current = null;
      }
      return;
    }
    if (!position) return;
    moreMenuTriggerRef.current = trigger ?? null;
    setMoreMenu({ taskId, left: position.left, top: position.top });
  }, []);

  const closeMoreMenu = useCallback((restoreFocus = false) => {
    const trigger = moreMenuTriggerRef.current;
    moreMenuTriggerRef.current = null;
    setMoreMenu(null);
    if (restoreFocus) window.setTimeout(() => trigger?.querySelector("button")?.focus(), 0);
  }, []);

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

  // Destructured so callbacks can depend on the stable `mutate` / `mutateAsync`
  // functions instead of the per-render mutation result objects.
  const { mutate: saveTemplateMutate } = saveTemplateMutation;
  const { mutateAsync: releaseTaskAsync } = releaseMutation;
  const { mutateAsync: deleteTaskAsync } = deleteMutation;

  // Batch delete/release (review 6.3): the confirm step is the BatchPreviewDialog
  // impact list; the run itself goes through the shared batch engine so one
  // failed request never cancels the rest, and every finished run lands a
  // change-list record for later review and retries.
  const [batchPreview, setBatchPreview] = useState<{ action: "release" | "delete"; tasks: Task[]; retryOf?: string } | null>(null);
  const { state: batchState, start: startBatch, retryFailed: retryBatchFailed, clear: clearBatch, stop: stopBatch } = useBatchOperation();
  // "后台运行" hides the result dialog without stopping the run; how the run ends
  // decides whether the dialog comes back (failures) or a toast reports it (clean run).
  const [batchBackgrounded, setBatchBackgroundedState] = useState(false);
  const batchBackgroundedRef = useRef(false);
  const setBatchBackgrounded = useCallback((value: boolean) => {
    batchBackgroundedRef.current = value;
    setBatchBackgroundedState(value);
  }, []);
  const pageMountedRef = useRef(false);
  useEffect(() => {
    pageMountedRef.current = true;
    return () => {
      pageMountedRef.current = false;
    };
  }, []);

  const batchPending = Boolean(batchPreview) || Boolean(batchState?.pending);
  const taskAutoRefresh = getRuntimeSettings().taskAutoRefresh;
  const taskAutoRefreshIntervalMs = getRuntimeSettings().taskAutoRefreshIntervalMs;
  const autoRefreshPaused =
    batchPending ||
    createOpen ||
    Boolean(editTask) ||
    Boolean(logTask) ||
    Boolean(sshInfoTask) ||
    sshWorkspaceOpen ||
    Boolean(rawTask) ||
    columnSettingsOpen ||
    moreMenuOpen;
  const {
    queryState,
    keywordInput,
    setKeywordInput,
    updateTaskQuery,
    query,
    filteredTasks,
    activeRowIndex,
    setActiveRowIndex,
    rowSelection,
    setRowSelection,
    total,
    hasKnownTotal,
    totalPages,
    hasNextPage,
  } = useTaskListController({
    pinnedTaskIds,
    autoRefresh: taskAutoRefresh,
    autoRefreshInterval: taskAutoRefreshIntervalMs,
    autoRefreshPaused,
  });

  const batchPreviewItems = useCallback(
    (action: "release" | "delete", tasks: Task[]): BatchPreviewItem[] =>
      tasks.map((task) => ({
        key: String(task.id),
        name: getTaskName(task),
        meta: batchItemMeta(task, locale, text),
        // Release destroys container-local data and delete removes the record: neither comes back.
        irreversible: true,
      })),
    [locale, text],
  );

  const handleBatchSettled = useCallback(
    (result: BatchRunResult<BatchPreviewItem>, record: BatchOperationRecord) => {
      const deleteFlow = record.action === "delete";
      const failed = result.summary.failed > 0;
      const title = deleteFlow
        ? text("批量删除完成", "Batch deletion finished")
        : text("批量释放完成", "Batch release finished");
      // The open result dialog already reports the outcome; only a run the user sent to the
      // background (or left the page during) needs a toast.
      const mounted = pageMountedRef.current;
      if (!mounted || batchBackgroundedRef.current) {
        if (failed && mounted) {
          setBatchBackgrounded(false);
        } else if (failed) {
          toast.error(
            text("批量操作部分失败", "Batch operation partially failed"),
            text(
              `${result.summary.succeeded}/${result.summary.total} 成功，${result.summary.failed} 失败；可在任务实例页的「最近批量操作」中查看。`,
              `${result.summary.succeeded}/${result.summary.total} succeeded, ${result.summary.failed} failed; see Recent batch operations on the task list.`,
            ),
          );
        } else {
          toast.success(title, text(`${result.summary.succeeded} 个实例`, `${result.summary.succeeded} instances`));
          if (mounted) {
            clearBatch();
            setBatchBackgrounded(false);
          }
        }
      }
      void runLogger.log({
        source: "task",
        level: failed ? "error" : "info",
        action: deleteFlow ? "task.batchDelete" : "task.batchRelease",
        result: failed ? "failure" : "success",
        title,
        metadata: {
          count: result.summary.total,
          succeeded: result.summary.succeeded,
          failed: result.summary.failed,
          skipped: result.summary.skipped,
          recordId: record.id,
          retryOf: record.retryOf,
        },
      });
      setRowSelection({});
      invalidateTaskQueries(queryClient);
    },
    [clearBatch, queryClient, runLogger, setBatchBackgrounded, setRowSelection, text, toast],
  );

  const runTaskBatch = useCallback(
    (action: "release" | "delete", tasks: Task[], retryOf?: string) => {
      setBatchBackgrounded(false);
      void startBatch({
        action,
        items: batchPreviewItems(action, tasks),
        remoteTaskIdFromItem: (item) => item.key,
        retryOf,
        run: (item) => (action === "delete" ? instanceApi.deleteTask(item.key) : instanceApi.operateTask(item.key)),
        onSettled: handleBatchSettled,
      });
    },
    [batchPreviewItems, handleBatchSettled, setBatchBackgrounded, startBatch],
  );

  const moreMenuTask = useMemo(() => {
    if (!moreMenu) return null;
    return filteredTasks.find((task) => taskRowId(task) === moreMenu.taskId) ?? null;
  }, [filteredTasks, moreMenu]);

  useEffect(() => {
    if (moreMenu && !moreMenuTask) closeMoreMenu();
  }, [closeMoreMenu, moreMenu, moreMenuTask]);

  useEffect(() => {
    setPageJumpInput(String(queryState.page));
  }, [queryState.page]);

  useEffect(() => {
    void loadTaskPins(browserRuntime.storage).then(setPinnedTaskIds);
  }, []);

  const prevCommitDoneRef = useRef(0);
  useEffect(() => {
    if (commitQueue.summary.completed > prevCommitDoneRef.current) {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
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
    setEditTask(null);
    setCreateOpen(true);
  };

  // "新建任务" from the command palette while this page is already open.
  useEffect(() => subscribeCreateTaskRequests(() => {
    setCloneTask(null);
    setEditTask(null);
    setCreateOpen(true);
  }), []);

  const openCloneTask = (task: Task) => {
    setCloneTask(task);
    setEditTask(null);
    setCreateOpen(true);
  };

  const openSshInfo = useCallback((task: Task) => {
    setSshInfoTask(task);
  }, []);

  /** Always open the SSH connection-info drawer first; connect actions live inside it. */
  const openTerminal = useCallback((task: Task) => {
    setSshInfoTask(task);
  }, []);

  const closeCreateTask = () => {
    setCreateOpen(false);
    setCloneTask(null);
  };

  const openEditTask = (task: Task) => {
    // The two forms render exclusively (each registers a router blocker while
    // open), so opening one must clear the other's pending state.
    setCreateOpen(false);
    setCloneTask(null);
    setEditTask(task);
  };

  const closeEditTask = () => {
    setEditTask(null);
  };

  const confirmReleaseTask = useCallback((task: Task) => {
    confirm({
      title: text("确认释放实例", "Confirm Instance Release"),
      description: <ReleaseConfirmDescription task={task} />,
      confirmLabel: text("释放", "Release"),
      tone: "danger",
      run: () => releaseTaskAsync(task),
    });
  }, [confirm, releaseTaskAsync, text]);

  const confirmDeleteTask = useCallback((task: Task) => {
    confirm({
      title: text("确认删除实例", "Confirm Instance Deletion"),
      description: text(
        `将删除 ${getTaskName(task)}。删除用于已结束等不可释放实例，从列表中移除记录；与「释放」不同，不会先停止仍在运行的任务。此操作不可从 EasyConsole 撤销。`,
        `Delete ${getTaskName(task)}. Delete removes finished / non-releasable instances from the list. Unlike Release, it is not for stopping a still-running task. EasyConsole cannot undo this.`,
      ),
      confirmLabel: text("删除", "Delete"),
      tone: "danger",
      run: () => deleteTaskAsync(task),
    });
  }, [confirm, deleteTaskAsync, text]);

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
      description: text(`将把 ${getTaskName(task)} 的当前运行环境提交为自定义镜像。此操作可能需要一段时间，请确认实例内文件操作已经完成。`, `Commit the container runtime of ${getTaskName(task)} into a custom image. This process may take several minutes; ensure container file operations are settled.`),
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
    setBatchPreview({ action: "release", tasks });
  }, []);

  const confirmBatchDelete = useCallback((tasks: Task[]) => {
    setBatchPreview({ action: "delete", tasks });
  }, []);

  /** History "retry failed": rebuild the subset from the loaded list, then confirm like any batch. */
  const retryHistoryRecord = useCallback((record: BatchOperationRecord) => {
    if (record.action !== "release" && record.action !== "delete") return;
    const failedIds = new Set(record.items.filter((item) => item.status === "failed").map((item) => item.remoteTaskId ?? item.key));
    const loaded = (query.data?.items ?? []).filter((task) => failedIds.has(String(task.id)));
    // A failed release may have gone through since; only still-releasable tasks are offered again.
    const tasks = record.action === "release" ? loaded.filter(isReleasableTask) : loaded.filter((task) => !isReleasableTask(task));
    if (tasks.length === 0) {
      toast.info(
        text("没有可重试的实例", "Nothing to retry"),
        text(
          "失败的实例不在当前列表页，或状态已变化。切换页码或刷新后再试。",
          "The failed instances are not on the current page or their status changed. Change page or refresh, then try again.",
        ),
      );
      return;
    }
    setBatchPreview({ action: record.action, tasks, retryOf: record.id });
  }, [query.data?.items, text, toast]);

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
        cell: ({ row, getValue, table }) => {
          const pinned = isTaskPinned(taskTableMeta(table).pinnedTaskIds, row.original);
          return (
            // 18rem keeps one long experiment name from pushing status under the action column;
            // the name wraps (at any character if it has to) instead of widening the table.
            <div className="w-max min-w-40 max-w-72 whitespace-normal [overflow-wrap:anywhere]">
              <div className="flex items-start gap-1.5">
                {pinned ? <Pin className="mt-1 h-3.5 w-3.5 shrink-0 text-app-accent" aria-label={text("已置顶", "Pinned")} /> : null}
                <div className="min-w-0">
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
        cell: (info) => <span className="app-numeric whitespace-nowrap text-app-text">{formatSecondsDuration(info.getValue(), locale)}</span>,
      }),
      columnHelper.accessor((row) => row.cost, {
        id: "billed",
        header: text("费用", "Cost"),
        cell: (info) => (
          <span className="app-numeric whitespace-nowrap text-app-text">{Number(info.getValue()) > 0 ? formatCost(info.getValue(), locale) : "—"}</span>
        ),
      }),
      columnHelper.accessor((row) => row.create_time ?? row.created_at ?? "-", {
        id: "created",
        header: text("创建时间", "Created"),
        cell: (info) => <span className="app-numeric whitespace-nowrap text-app-text">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.releace_time ?? "-", {
        id: "release",
        header: text("释放时间", "Release time"),
        cell: (info) => <span className="app-numeric whitespace-nowrap text-app-text">{info.getValue()}</span>,
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
        cell: ({ row, table }) => {
          const task = row.original;
          const meta = taskTableMeta(table);
          const release = isReleasableTask(task);
          const access = getTaskAccess(task);
          // Narrow regions keep only the release slot and More; terminal, log and clone move
          // into the menu (its connect and lifecycle sections) rather than off the screen.
          const compact = meta.compactActions;
          return (
            <div className={compact ? COMPACT_ACTION_GRID_CLASS : ACTION_GRID_CLASS}>
              {compact ? null : (
                <>
                  <Button
                    aria-label={text(`打开 ${getTaskName(task)} 的终端`, `Open terminal for ${getTaskName(task)}`)}
                    className="h-8 w-8 px-0"
                    disabled={!access.terminal}
                    disabledReason={access.terminalReason}
                    variant="ghost"
                    title={text("终端", "Terminal")}
                    onClick={() => meta.onTerminal(task)}
                  >
                    <TerminalSquare className="h-4 w-4" />
                  </Button>
                  <Button
                    aria-label={text(`打开 ${getTaskName(task)} 的日志`, `Open logs for ${getTaskName(task)}`)}
                    className="h-8 w-8 px-0"
                    disabled={!access.log}
                    disabledReason={access.logReason}
                    title={text("日志", "Logs")}
                    variant="ghost"
                    onClick={() => meta.onLog(task)}
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                  <Button
                    aria-label={text(`克隆实例 ${getTaskName(task)}`, `Clone instance ${getTaskName(task)}`)}
                    className="h-8 w-8 px-0"
                    title={text("克隆实例", "Clone instance")}
                    variant="ghost"
                    onClick={() => meta.onClone(task)}
                  >
                    <CopyPlus className="h-4 w-4" />
                  </Button>
                </>
              )}
              {/* This slot only ever means release; deleting an ended task's record is in More. */}
              <Button
                aria-label={text(`释放实例 ${getTaskName(task)}`, `Release instance ${getTaskName(task)}`)}
                className="h-8 w-16 justify-center px-1.5 hover:bg-app-warningSoft hover:text-app-warningText focus-visible:text-app-warningText aria-disabled:hover:bg-transparent aria-disabled:hover:text-app-muted"
                disabled={!release || meta.releasePending}
                disabledReason={release
                  ? undefined
                  : Number(task.status) === 3
                    ? text("已暂停的实例不可释放", "Paused instances cannot be released")
                    : text("已结束，无需释放；删除记录在「更多」中", "Ended, nothing to release; delete the record from More")}
                title={text("释放：停止实例并回收资源", "Release: stop instance and reclaim resources")}
                variant="ghost"
                onClick={() => meta.onRelease(task)}
              >
                <Power className="h-4 w-4" />
                {text("释放", "Release")}
              </Button>
              <MoreActionsMenu
                canEdit={getTaskEditableState() !== false}
                isPinned={isTaskPinned(meta.pinnedTaskIds, task)}
                open={meta.moreMenuTaskId === taskRowId(task)}
                promoteClone={!compact}
                promoteLog={!compact}
                showSshInfo={compact}
                task={task}
                onClone={meta.onClone}
                onCommit={meta.onCommit}
                onDelete={meta.onDelete}
                onDownload={meta.onDownload}
                onEdit={meta.onEdit}
                onLog={meta.onLog}
                onMonitor={openMonitorDashboard}
                onOpenChange={meta.onMoreMenuOpenChange}
                onRaw={meta.onRaw}
                onSaveTemplate={meta.onSaveTemplate}
                onSshInfo={meta.onSshInfo}
                onTogglePin={meta.onTogglePin}
              />
            </div>
          );
        },
      }),
    ],
    [locale, text],
  );

  const tableMeta: TaskTableMeta = {
    pinnedTaskIds,
    moreMenuTaskId: moreMenu?.taskId ?? null,
    releasePending: releaseMutation.isPending,
    compactActions,
    onTerminal: openTerminal,
    onLog: setLogTask,
    onClone: openCloneTask,
    onRelease: confirmReleaseTask,
    onCommit: confirmCommitTask,
    onDelete: confirmDeleteTask,
    onDownload: handleDownloadTask,
    onEdit: openEditTask,
    onRaw: setRawTask,
    onSaveTemplate: saveTemplateMutate,
    onSshInfo: openSshInfo,
    onTogglePin: handleTogglePin,
    onMoreMenuOpenChange: handleMoreMenuOpenChange,
  };

  const table = useReactTable({
    data: filteredTasks,
    columns,
    meta: tableMeta,
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

  // A short page renders whole; virtualizing cards only pays off past a few dozen.
  const virtualizeCards = compactLayout && cardScroll !== null && tableRows.length > MOBILE_CARD_VIRTUALIZE_MIN;
  const cardVirtualizer = useVirtualizer({
    count: virtualizeCards ? tableRows.length : 0,
    getScrollElement: () => cardScroll?.element ?? null,
    estimateSize: () => 260,
    overscan: 4,
    scrollMargin: cardScroll?.margin ?? 0,
  });
  const virtualCards = virtualizeCards ? cardVirtualizer.getVirtualItems() : null;
  const cardRowIndexes = virtualCards ? virtualCards.map((item) => item.index) : tableRows.map((_, index) => index);
  const cardScrollMargin = cardScroll?.margin ?? 0;
  const cardPaddingTop = virtualCards?.length ? virtualCards[0].start - cardScrollMargin : 0;
  const cardPaddingBottom = virtualCards?.length
    ? cardVirtualizer.getTotalSize() - (virtualCards[virtualCards.length - 1].end - cardScrollMargin)
    : 0;

  const settingsHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const savedVisibility = await loadColumnVisibility();
      if (cancelled) return;
      setColumnVisibility(savedVisibility);
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

  const configurableColumns = table.getAllLeafColumns().filter((column) => !ALWAYS_VISIBLE_COLUMNS.has(column.id));
  const selectedTasks = table.getSelectedRowModel().flatRows.map((row) => row.original);
  const selectedReleasableTasks = selectedTasks.filter(isReleasableTask);
  const selectedNonReleasableTasks = selectedTasks.filter((task) => !isReleasableTask(task));

  const isListNavigationTarget = useCallback(() => {
    const active = document.activeElement;
    if (!active) return false;
    const tableEl = tableScrollRef.current;
    if (tableEl && (tableEl === active || tableEl.contains(active))) return true;
    const cardsEl = mobileCardsRef.current;
    return Boolean(cardsEl && (cardsEl === active || cardsEl.contains(active)));
  }, []);

  useEffect(() => {
    const container = compactLayout ? mobileCardsRef.current : tableScrollRef.current;
    if (!container || activeRowIndex < 0) return;
    const rowElement = container.querySelector(`[data-task-row-index="${activeRowIndex}"]`);
    if (rowElement) rowElement.scrollIntoView({ block: "nearest" });
    else (compactLayout ? cardVirtualizer : rowVirtualizer).scrollToIndex(activeRowIndex, { align: "auto" });
  }, [activeRowIndex, cardVirtualizer, compactLayout, rowVirtualizer]);

  useEffect(() => {
    // Do not toggle overflow on the virtualized table — that remounts rows and kills the menu.
    // Block wheel/touch scrolling on the list instead so the trigger row stays mounted.
    const scrollRoots = [tableScrollRef.current, mobileCardsRef.current].filter(
      (el): el is HTMLDivElement => Boolean(el),
    );
    if (!moreMenuOpen || scrollRoots.length === 0) return undefined;

    const preventScroll = (event: Event) => {
      event.preventDefault();
    };

    for (const el of scrollRoots) {
      el.addEventListener("wheel", preventScroll, { passive: false });
      el.addEventListener("touchmove", preventScroll, { passive: false });
    }
    return () => {
      for (const el of scrollRoots) {
        el.removeEventListener("wheel", preventScroll);
        el.removeEventListener("touchmove", preventScroll);
      }
    };
  }, [moreMenuOpen]);

  // Row moves are spoken through a polite live region: the table is a scroll region, not a
  // composite widget, so aria-activedescendant on it would never be announced.
  const [rowAnnouncement, setRowAnnouncement] = useState("");
  const lastChordKeyAtRef = useRef(0);

  // Roving tab stops: only the current row's controls are in the Tab order (row 0 before a
  // row is chosen), so Tab crosses the list in one row instead of seven stops per task.
  // Rows set no tabIndex of their own, so writing it here never fights a render.
  useLayoutEffect(() => {
    const container = compactLayout ? mobileCardsRef.current : tableScrollRef.current;
    if (!container) return;
    const entryRow = activeRowIndex >= 0 ? activeRowIndex : 0;
    for (const rowElement of container.querySelectorAll<HTMLElement>("[data-task-row-index]")) {
      const tabbable = Number(rowElement.dataset.taskRowIndex) === entryRow;
      for (const control of rowElement.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea")) {
        if (tabbable) control.removeAttribute("tabindex");
        else control.tabIndex = -1;
      }
    }
  });

  useEffect(() => {
    const moveActiveRow = (next: number) => {
      setActiveRowIndex(next);
      const task = filteredTasks[next];
      if (!task) return;
      setRowAnnouncement(
        text(
          `第 ${next + 1} / ${filteredTasks.length} 行：${getTaskName(task)}，${getStatusText(task.status, locale)}`,
          `Row ${next + 1} of ${filteredTasks.length}: ${getTaskName(task)}, ${getStatusText(task.status, locale)}`,
        ),
      );
    };
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

      const key = event.key.toLowerCase();
      // "g" opens the shell's page-jump chord (g t, g d …); its second key is not a row command.
      if (key === "g") {
        lastChordKeyAtRef.current = Date.now();
        return;
      }
      if (Date.now() - lastChordKeyAtRef.current < 800) return;

      if (
        createOpen ||
        Boolean(editTask) ||
        Boolean(logTask) ||
        Boolean(sshInfoTask) ||
        sshWorkspaceOpen ||
        Boolean(rawTask) ||
        columnSettingsOpen ||
        viewMenuOpen ||
        moreMenuOpen ||
        hasOpenModalOverlay()
      ) {
        return;
      }
      if (filteredTasks.length === 0) return;

      if (!isListNavigationTarget()) {
        // j / k from anywhere on the page enter the list, including from a toolbar button a
        // closed dialog handed focus back to, as the shortcuts dialog promises. Text fields
        // returned above; other keys (and arrows, which scroll the page) stay untouched.
        if (key !== "j" && key !== "k") return;
        event.preventDefault();
        (compactLayout ? mobileCardsRef.current : tableScrollRef.current)?.focus();
        moveActiveRow(Math.min(Math.max(activeRowIndex, 0), filteredTasks.length - 1));
        return;
      }

      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        moveActiveRow(Math.min(activeRowIndex + 1, filteredTasks.length - 1));
        return;
      }
      if (key === "k" || key === "arrowup") {
        event.preventDefault();
        moveActiveRow(Math.max(activeRowIndex - 1, 0));
        return;
      }

      const task = filteredTasks[activeRowIndex];
      if (!task) return;

      if (key === "enter") {
        event.preventDefault();
        navigate(`/tasks/${task.id}`);
        return;
      }
      if (key === "l" && getTaskAccess(task).log) {
        event.preventDefault();
        setLogTask(task);
        return;
      }
      if (key === "t" && getTaskAccess(task).terminal) {
        event.preventDefault();
        openTerminal(task);
        return;
      }
      if (key === "x") {
        event.preventDefault();
        const id = taskRowId(task);
        const wasSelected = Boolean(rowSelection[id]);
        setRowSelection((current) => {
          const next = { ...current };
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
        setRowAnnouncement(
          wasSelected
            ? text(`已取消选择 ${getTaskName(task)}`, `Deselected ${getTaskName(task)}`)
            : text(`已选择 ${getTaskName(task)}`, `Selected ${getTaskName(task)}`),
        );
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
    compactLayout,
    sshWorkspaceOpen,
    columnSettingsOpen,
    confirmReleaseTask,
    createOpen,
    editTask,
    filteredTasks,
    isListNavigationTarget,
    locale,
    logTask,
    moreMenuOpen,
    navigate,
    openTerminal,
    rawTask,
    rowSelection,
    setActiveRowIndex,
    setRowSelection,
    sshInfoTask,
    text,
    viewMenuOpen,
  ]);

  const closeViewMenu = useCallback((restoreFocus = false) => {
    setViewMenuOpen(false);
    if (restoreFocus) window.setTimeout(() => viewTriggerRef.current?.focus(), 0);
  }, []);

  useMobileBackLayer(viewMenuOpen, () => closeViewMenu());
  const viewMenuLayerRef = useOverlay(viewMenuOpen, "popover");

  useEffect(() => {
    if (!viewMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!viewMenuRef.current?.contains(event.target as Node)) closeViewMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !claimOverlayKey(viewMenuLayerRef.current, event)) return;
      event.stopPropagation();
      closeViewMenu(true);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeViewMenu, viewMenuLayerRef, viewMenuOpen]);

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
            {Object.entries(taskStatusText).map(([value, label]) => (
              <option key={value} value={value}>
                {localizedText(label, locale)}
              </option>
            ))}
          </Select>
          <div ref={viewMenuRef} className="relative flex items-center gap-2">
            <Button
              ref={viewTriggerRef}
              aria-controls={viewMenuOpen ? viewMenuId : undefined}
              aria-expanded={viewMenuOpen}
              aria-haspopup="menu"
              aria-label={text("视图", "View")}
              title={text("视图", "View")}
              type="button"
              variant="secondary"
              onClick={() => setViewMenuOpen((open) => !open)}
            >
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              {text("视图", "View")}
            </Button>
            <Button
              aria-label={text("刷新列表", "Refresh list")}
              className="h-9 w-9 px-0"
              disabled={query.isFetching}
              title={text("刷新列表", "Refresh list")}
              type="button"
              variant="ghost"
              onClick={() => void query.refetch()}
            >
              <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} aria-hidden="true" />
            </Button>
            {/* Not a live region: it ticks every 5 s and would be announced forever. */}
            {query.isFetching ? (
              <span className="hidden text-xs text-app-muted sm:inline">{text("刷新中", "Refreshing")}</span>
            ) : query.dataUpdatedAt ? (
              <span className="hidden text-xs text-app-muted sm:inline">
                {text("更新于 ", "Updated ")}
                <RelativeUpdatedAt updatedAt={query.dataUpdatedAt} />
              </span>
            ) : null}
            {viewMenuOpen ? (
              <div
                id={viewMenuId}
                className={cn(
                  compactLayout
                    ? "app-mobile-action-sheet fixed inset-x-0 bottom-0 z-50 w-full rounded-t-lg border border-b-0 border-app-border bg-app-elevated p-3 shadow-popover"
                    : "app-pop-enter absolute left-0 top-full z-30 mt-1 w-64 origin-top-left rounded-lg border border-app-border bg-app-elevated p-2 shadow-popover",
                )}
              >
                <div className="space-y-2 p-1">
                  <label className="block text-xs text-app-muted">
                    {text("排序", "Sort")}
                    <Select
                      aria-label={text("排序字段", "Sort by")}
                      className="mt-1 w-full"
                      value={queryState.sortBy}
                      onChange={(event) => updateTaskQuery({ sortBy: event.target.value as TaskListSortBy })}
                    >
                      <option value="">{text("默认排序", "Default")}</option>
                      <option value="name">{text("名称", "Name")}</option>
                      <option value="status">{text("状态", "Status")}</option>
                      <option value="created">{text("创建时间", "Created")}</option>
                      <option value="updated">{text("更新时间", "Updated")}</option>
                      <option value="duration">{text("运行时长", "Runtime")}</option>
                      <option value="cost">{text("费用", "Cost")}</option>
                    </Select>
                  </label>
                  <Button
                    aria-label={text("切换排序方向", "Toggle sort direction")}
                    className="w-full justify-start"
                    disabled={!queryState.sortBy}
                    title={queryState.sortDir === "asc" ? text("升序", "Ascending") : text("降序", "Descending")}
                    type="button"
                    variant="secondary"
                    onClick={() => updateTaskQuery({ sortDir: queryState.sortDir === "asc" ? "desc" : "asc" })}
                  >
                    {queryState.sortDir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    {queryState.sortDir === "asc" ? text("升序", "Ascending") : text("降序", "Descending")}
                  </Button>
                </div>
                <div className="border-t border-app-border p-1">
                  <button
                    className={MENU_ITEM_CLASS}
                    type="button"
                    onClick={() => {
                      setColumnSettingsOpen(true);
                      closeViewMenu();
                    }}
                  >
                    <Settings2 className="h-4 w-4" />
                    {text("列设置", "Columns")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <Button className="w-full sm:w-auto" onClick={openCreateTask}>
          <Plus className="h-4 w-4" />
          {text("新建任务", "New task")}
        </Button>
      </div>

      <Panel className="overflow-hidden">
        {!query.data && query.isLoading ? (
          <TableSkeleton columns={7} />
        ) : query.isError ? (
          <ErrorState error={query.error} action={<Button variant="secondary" onClick={() => query.refetch()}>{text("重试", "Retry")}</Button>} />
        ) : table.getRowModel().rows.length === 0 && queryState.keyword.trim() ? (
          <EmptyState icon={SearchXIcon} title={text("未找到匹配实例", "No matching instances")} action={<Button variant="secondary" onClick={() => updateTaskQuery({ keyword: "" })}>{text("清空搜索", "Clear search")}</Button>} />
        ) : table.getRowModel().rows.length === 0 ? (
          <EmptyState title={text("暂无任务实例", "No task instances")} action={<Button onClick={openCreateTask}>{text("新建任务", "New task")}</Button>} />
        ) : (
          <>
          <h2 id="task-list-heading" className="sr-only">
            {text("任务实例列表", "Task instance list")}
          </h2>
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {rowAnnouncement}
          </p>
          {compactLayout ? (
          <div
            ref={mobileCardsCallbackRef}
            aria-labelledby="task-list-heading"
            className="divide-y divide-app-border"
            role="region"
            style={virtualCards ? { paddingTop: cardPaddingTop, paddingBottom: cardPaddingBottom } : undefined}
            tabIndex={0}
          >
            {cardRowIndexes.map((rowIndex) => {
              const row = tableRows[rowIndex];
              const task = row.original;
              const release = isReleasableTask(task);
              const taskName = getTaskName(task);
              return (
                <article
                  key={row.id}
                  ref={virtualCards ? cardVirtualizer.measureElement : undefined}
                  id={`task-row-${rowIndex}`}
                  // data-index is what the virtualizer's measureElement reads; the other is ours.
                  data-index={rowIndex}
                  data-task-row-index={rowIndex}
                  className={cn(
                    "space-y-3 px-3 py-3",
                    // Only trouble gets a fill; the keyboard cursor is a solid accent frame.
                    isTroubleTask(task) && "bg-app-rowDanger",
                    activeRowIndex === rowIndex && "app-card-active",
                  )}
                  onFocusCapture={() => setActiveRowIndex(rowIndex)}
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
                    {/* Only running instances have an endpoint; the others show their duration in that slot. */}
                    {endpointText(task) !== "-" ? (
                      <div>
                        <dt className="text-app-muted">{text("入口", "Endpoint")}</dt>
                        <dd className="mt-0.5 truncate font-mono text-app-text">{endpointText(task)}</dd>
                      </div>
                    ) : null}
                    <div className={endpointText(task) !== "-" ? "hidden sm:block" : undefined}>
                      <dt className="text-app-muted">{text("时长", "Duration")}</dt>
                      <dd className="app-numeric mt-0.5 text-app-text">{formatSecondsDuration(task.use_time, locale)}</dd>
                    </div>
                    <div className="hidden sm:block">
                      <dt className="text-app-muted">{text("用户", "User")}</dt>
                      <dd className="mt-0.5 truncate text-app-text">{ownerText(task)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-app-muted">{text("释放条件", "Release condition")}</dt>
                      <dd className="mt-1"><ReleaseConditionBadge condition={task.releace_conditions ?? task.release_condition} /></dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-1.5">
                    {(() => {
                      const terminalLabel = text("终端", "Terminal");
                      const logAttention = needsLogAttention(task);
                      const access = getTaskAccess(task);
                      return (
                        <>
                        <Button
                          aria-label={text(`打开 ${taskName} 的终端`, `Open terminal for ${taskName}`)}
                          className={cn("h-9 px-2", logAttention && "hidden sm:inline-flex")}
                          disabled={!access.terminal}
                          disabledReason={access.terminalReason}
                          variant="ghost"
                          title={terminalLabel}
                          onClick={() => openTerminal(task)}
                        >
                          <TerminalSquare className="h-4 w-4" />
                          {terminalLabel}
                        </Button>
                        <Button
                          className={cn("h-9 px-2", !logAttention && "hidden sm:inline-flex")}
                          disabled={!access.log}
                          disabledReason={access.logReason}
                          title={text("日志", "Logs")}
                          variant="ghost"
                          onClick={() => setLogTask(task)}
                        >
                          <FileText className="h-4 w-4" />
                          {text("日志", "Logs")}
                        </Button>
                        <Button
                          className="hidden h-9 px-2 sm:inline-flex"
                          title={text("克隆实例", "Clone instance")}
                          variant="ghost"
                          onClick={() => openCloneTask(task)}
                        >
                          <CopyPlus className="h-4 w-4" />
                          {text("克隆", "Clone")}
                        </Button>
                        {release ? (
                          <Button
                            aria-label={text(`释放实例 ${taskName}`, `Release instance ${taskName}`)}
                            className="h-9 px-2 hover:bg-app-warningSoft hover:text-app-warningText focus-visible:text-app-warningText"
                            disabled={releaseMutation.isPending}
                            title={text("释放：停止实例并回收资源", "Release: stop instance and reclaim resources")}
                            variant="ghost"
                            onClick={() => confirmReleaseTask(task)}
                          >
                            <Power className="h-4 w-4" />
                            {text("释放", "Release")}
                          </Button>
                        ) : null}
                        <MoreActionsMenu
                          canEdit={getTaskEditableState() !== false}
                          isPinned={isTaskPinned(pinnedTaskIds, task)}
                          open={moreMenu?.taskId === taskRowId(task)}
                          promoteLog={logAttention}
                          showSshInfo={logAttention}
                          task={task}
                          onClone={openCloneTask}
                          onCommit={confirmCommitTask}
                          onDelete={confirmDeleteTask}
                          onDownload={handleDownloadTask}
                          onEdit={openEditTask}
                          onLog={setLogTask}
                          onMonitor={openMonitorDashboard}
                          onOpenChange={handleMoreMenuOpenChange}
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
          <TableRegion
            ref={tableRegionCallbackRef}
            label={text("任务实例表格", "Task instances table")}
          >
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
                      id={`task-row-${virtualRow.index}`}
                      // data-index is what the virtualizer's measureElement reads; the other is ours.
                      data-index={virtualRow.index}
                      data-task-row-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      className={cn(
                        "group relative border-b border-app-border last:border-0 hover:z-20",
                        // Running is the normal state and stays plain; only failed/abnormal rows get a fill.
                        isTroubleTask(row.original) ? "bg-app-rowDanger hover:bg-app-rowDangerHover" : "hover:bg-app-rowHover",
                        activeRowIndex === virtualRow.index && "app-row-active",
                      )}
                      onFocusCapture={() => setActiveRowIndex(virtualRow.index)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={[
                            "whitespace-nowrap px-3 py-2 align-middle",
                            isActionsColumn(cell.column.id)
                              ? [
                                  "sticky right-0 z-30 shadow-stickyColumn",
                                  // Row fills are opaque tokens, so the sticky cell repeats its row's fill exactly.
                                  isTroubleTask(row.original)
                                    ? "bg-app-rowDanger group-hover:bg-app-rowDangerHover"
                                    : "bg-app-surface group-hover:bg-app-rowHover",
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

      <div className="app-task-pagination flex flex-wrap items-center justify-between gap-3 text-sm text-app-muted">
        <div>
          {hasKnownTotal
            ? text(`共 ${total} 个实例，第 ${queryState.page} / ${totalPages} 页`, `${total} instances, page ${queryState.page} / ${totalPages}`)
            : text(`第 ${queryState.page} 页，当前返回 ${query.data?.items.length ?? 0} 个实例`, `Page ${queryState.page}, ${query.data?.items.length ?? 0} instances returned`)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span>{text("每页", "Per page")}</span>
          <Select
            aria-label={text("每页实例数", "Instances per page")}
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
          {hasKnownTotal && totalPages ? (
            <>
              <Input
                aria-label={text("跳转到页码", "Jump to page")}
                className="w-16 text-center"
                inputMode="numeric"
                min={1}
                max={totalPages}
                value={pageJumpInput}
                onChange={(event) => setPageJumpInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const page = Number(pageJumpInput);
                  if (Number.isInteger(page) && page >= 1 && page <= totalPages) {
                    updateTaskQuery({ page });
                  }
                }}
              />
              <Button
                disabled={query.isFetching}
                type="button"
                variant="secondary"
                onClick={() => {
                  const page = Number(pageJumpInput);
                  if (Number.isInteger(page) && page >= 1 && page <= totalPages) {
                    updateTaskQuery({ page });
                  }
                }}
              >
                {text("跳转", "Jump")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Below the list, so selecting rows never shifts the table under the pointer.
          It floats over the bottom edge on desktop and above the tab bar on phones;
          z-40 keeps it above the table's sticky action cells (z-30). */}
      {selectedTasks.length > 0 || (batchBackgrounded && batchState?.pending) ? (
        <Panel className="app-mobile-batch-bar flex flex-wrap items-center justify-between gap-3 px-3 py-2 md:sticky md:bottom-3 md:z-40 md:bg-app-elevated md:shadow-popover">
          {batchBackgrounded && batchState?.pending ? (
            <div className="flex min-w-0 items-center gap-2 text-sm text-app-muted" role="status">
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="app-numeric">
                {batchState.action === "delete"
                  ? text(`后台删除中 ${batchState.result.outcomes.length}/${batchState.result.summary.total}`, `Deleting in background ${batchState.result.outcomes.length}/${batchState.result.summary.total}`)
                  : text(`后台释放中 ${batchState.result.outcomes.length}/${batchState.result.summary.total}`, `Releasing in background ${batchState.result.outcomes.length}/${batchState.result.summary.total}`)}
              </span>
              <Button className="h-8" variant="ghost" onClick={() => setBatchBackgrounded(false)}>
                {text("查看进度", "Show progress")}
              </Button>
            </div>
          ) : null}
          {selectedTasks.length > 0 ? (
          <>
          <p className="min-w-0 text-sm text-app-muted">
            {text("已选", "Selected")} <span className="app-numeric font-medium text-app-text">{selectedTasks.length}</span> {text("个实例", "instances")}
            {selectedReleasableTasks.length > 0 ? text(` · 运行中可释放 ${selectedReleasableTasks.length}`, ` · ${selectedReleasableTasks.length} releasable`) : ""}
            {selectedNonReleasableTasks.length > 0 ? text(` · 已结束 ${selectedNonReleasableTasks.length}`, ` · ${selectedNonReleasableTasks.length} ended`) : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {selectedReleasableTasks.length > 0 ? (
              <Button
                className="hover:bg-app-warningSoft hover:text-app-warningText focus-visible:text-app-warningText"
                disabled={batchPending}
                title={text("停止这些实例并回收资源", "Stop these instances and reclaim their resources")}
                variant="secondary"
                onClick={() => confirmBatchRelease(selectedReleasableTasks)}
              >
                <Power className="h-4 w-4" aria-hidden="true" />
                {text(`释放 ${selectedReleasableTasks.length} 个`, `Release ${selectedReleasableTasks.length}`)}
              </Button>
            ) : null}
            {selectedNonReleasableTasks.length > 0 ? (
              <Button
                className="hover:bg-app-dangerSoft hover:text-app-danger focus-visible:text-app-danger"
                disabled={batchPending}
                title={text("从列表移除已结束实例的记录，不可撤销", "Remove the records of ended instances; cannot be undone")}
                variant="secondary"
                onClick={() => confirmBatchDelete(selectedNonReleasableTasks)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {text(`删除 ${selectedNonReleasableTasks.length} 条记录`, `Delete ${selectedNonReleasableTasks.length} records`)}
              </Button>
            ) : null}
            <Button disabled={batchPending} variant="ghost" onClick={() => setRowSelection({})}>
              {text("取消选择", "Clear selection")}
            </Button>
          </div>
          </>
          ) : null}
        </Panel>
      ) : null}

      <Suspense fallback={<LoadingState />}>
        {/* Only the active form is mounted: CreateTaskDialog registers a router
            blocker while open, and a router supports only one blocker — two
            mounted forms would disable one form's unsaved-changes guard. */}
        {createOpen ? (
          <CreateTaskDialog initialTask={cloneTask} open onClose={closeCreateTask} />
        ) : editTask ? (
          <CreateTaskDialog mode="edit" editTaskId={editTask.id} initialTask={editTask} open onClose={closeEditTask} />
        ) : null}
        <TaskLogDialog task={logTask} onClose={() => setLogTask(null)} />
        <TerminalDialog
          task={sshInfoTask}
          onClose={() => setSshInfoTask(null)}
          onOpenAppSsh={(request) => {
            setSshInfoTask(null);
            sshWorkspace.openTarget(request);
          }}
        />
      </Suspense>
      {moreMenu && moreMenuTask ? (
        <MoreActionsMenuPanel
          task={moreMenuTask}
          position={{ left: moreMenu.left, top: moreMenu.top }}
          menuId={moreActionsMenuId}
          initialFocusIndex={0}
          triggerRef={moreMenuTriggerRef}
          // One panel serves every row, so it carries what that row's surface leaves out:
          // the narrow table moves terminal, log and clone in here; a phone card keeps only
          // the log (failed tasks) or the terminal (the rest) as a button.
          promoteLog={compactLayout ? needsLogAttention(moreMenuTask) : !compactActions}
          promoteClone={!compactLayout && !compactActions}
          showSshInfo={compactLayout ? needsLogAttention(moreMenuTask) : compactActions}
          isPinned={isTaskPinned(pinnedTaskIds, moreMenuTask)}
          canEdit={getTaskEditableState() !== false}
          onClose={closeMoreMenu}
          onLog={setLogTask}
          onClone={openCloneTask}
          onSshInfo={openSshInfo}
          onMonitor={openMonitorDashboard}
          onRaw={setRawTask}
          onDownload={handleDownloadTask}
          onCommit={confirmCommitTask}
          onEdit={openEditTask}
          onSaveTemplate={(selectedTask) => saveTemplateMutation.mutate(selectedTask)}
          onTogglePin={handleTogglePin}
          onDelete={confirmDeleteTask}
        />
      ) : null}
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
      {/* Recent batch operations (review 6.3); refreshes when a batch lands its record. */}
      <BatchHistoryPanel refreshSignal={batchState?.record?.id} retryableActions={["release", "delete"]} onRetryFailed={retryHistoryRecord} />
      {batchPreview ? (
        <BatchPreviewDialog
          open
          title={batchPreview.action === "delete" ? text("确认批量删除", "Confirm Batch Deletion") : text("确认批量释放", "Confirm Batch Release")}
          tone="danger"
          items={batchPreviewItems(batchPreview.action, batchPreview.tasks)}
          account={{ displayName: auth.user?.username ?? "" }}
          summary={batchPreview.action === "release" ? <BatchReleaseImpact tasks={batchPreview.tasks} /> : undefined}
          confirmLabel={batchPreview.action === "delete"
            ? text(`删除 ${batchPreview.tasks.length} 条记录`, `Delete ${batchPreview.tasks.length} records`)
            : text(`释放 ${batchPreview.tasks.length} 个实例`, `Release ${batchPreview.tasks.length} instances`)}
          onConfirm={() => {
            const { action, tasks, retryOf } = batchPreview;
            setBatchPreview(null);
            runTaskBatch(action, tasks, retryOf);
          }}
          onClose={() => setBatchPreview(null)}
        />
      ) : null}
      {batchState && !batchBackgrounded ? (
        <BatchResultDialog
          open
          title={batchState.action === "delete" ? text("批量删除结果", "Batch deletion results") : text("批量释放结果", "Batch release results")}
          result={batchState.result}
          pending={batchState.pending}
          onStop={stopBatch}
          onRetryFailed={batchState.pending ? undefined : () => retryBatchFailed({ onSettled: handleBatchSettled })}
          onExport={(format) => {
            const records = batchState.records;
            if (records.length === 0) return;
            const payload = batchExportPayload(records, format);
            void saveBlob(new Blob([payload.content], { type: payload.type }), payload.filename);
          }}
          onClose={() => {
            if (batchState.pending) {
              setBatchBackgrounded(true);
              return;
            }
            clearBatch();
            // The batch bar that opened the run is gone once its selection clears; land on the list.
            window.setTimeout(() => {
              if (document.activeElement === document.body) (compactLayout ? mobileCardsRef.current : tableScrollRef.current)?.focus();
            }, 0);
          }}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}
