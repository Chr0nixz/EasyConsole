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
  Search,
  Settings2,
  Terminal,
  Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { StatusBadge } from "../components/StatusBadge";
import { CreateTaskDialog } from "../components/tasks/CreateTaskDialog";
import { TaskLogDialog } from "../components/tasks/TaskLogDialog";
import { Button, Dialog, Input, Panel, Select } from "../components/ui";
import { instanceApi } from "../lib/api";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../lib/batch";
import { saveBlob } from "../lib/download";
import { asJson, formatSecondsDuration, getTaskName } from "../lib/format";
import { openMonitorDashboard } from "../lib/monitor-dashboard";
import type { Task } from "../lib/types";
import { useToast } from "../lib/use-toast";

const columnHelper = createColumnHelper<Task>();
const TerminalDialog = lazy(() => import("../components/tasks/TerminalDialog").then((module) => ({ default: module.TerminalDialog })));
const COLUMN_VISIBILITY_KEY = "easy-console.tasks.columnVisibility";
const AUTO_REFRESH_KEY = "easy-console.tasks.autoRefresh";
const AUTO_REFRESH_INTERVAL_KEY = "easy-console.tasks.autoRefreshInterval";
const DEFAULT_AUTO_REFRESH_INTERVAL = 10_000;
const TASK_LIST_PAGE_SIZE = 500;
const autoRefreshOptions = [
  { label: "5 秒", value: 5_000 },
  { label: "10 秒", value: 10_000 },
  { label: "30 秒", value: 30_000 },
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
const columnLabels: Record<string, string> = {
  name: "实例名称",
  status: "状态",
  resource: "资源",
  node: "节点",
  endpoint: "入口",
  owner: "用户",
  group: "用户组",
  duration: "时长",
  created: "创建时间",
  release: "释放时间",
  releaseCondition: "释放条件",
  deleted: "删除状态",
};
const ACTION_GRID_CLASS = "grid grid-cols-[2rem_2rem_2rem_2rem_5rem_2rem] items-center gap-1";

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

function taskSearchText(task: Task) {
  return [
    getTaskName(task),
    task.name,
    task.task_name,
    task.description,
    task.id,
    task.task_id,
    task.ip,
    task.node_name,
    ownerText(task),
    groupText(task),
  ]
    .map((value) => displayText(value).toLowerCase())
    .join(" ");
}

function taskRowId(task: Task) {
  return String(task.task_id ?? task.id);
}

function isRunningTask(task: Task) {
  return Number(task.status) === 2;
}

function isActionsColumn(id: string) {
  return id === "actions";
}

function ActionHeader() {
  return (
    <div className={`${ACTION_GRID_CLASS} text-center text-xs text-app-muted`}>
      <span>监控</span>
      <span>日志</span>
      <span>终端</span>
      <span>复制</span>
      <span>释放/删除</span>
      <span>更多</span>
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

function MoreActionsMenu({
  task,
  onRaw,
  onDownload,
}: {
  task: Task;
  onRaw: (task: Task) => void;
  onDownload: (task: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const width = 144;
      const estimatedHeight = 80;
      const margin = 8;
      const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
      const top =
        rect.bottom + estimatedHeight + margin > window.innerHeight ? rect.top - estimatedHeight - 4 : rect.bottom + 4;

      setMenuPosition({ left, top: Math.max(margin, top) });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleScroll = () => setOpen(false);

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
  }, [open]);

  return (
    <div ref={triggerRef} className="relative z-30">
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        className="h-8 w-8 px-0"
        title="更多"
        type="button"
        variant="ghost"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && menuPosition
        ? createPortal(
        <div
            ref={menuRef}
            className="fixed z-[100] w-36 rounded-md border border-app-border bg-app-surface p-1 shadow-popover"
          role="menu"
            style={{ left: menuPosition.left, top: menuPosition.top }}
        >
          <button
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel"
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              onDownload(task);
            }}
          >
            <Download className="h-4 w-4 text-app-muted" />
            下载
          </button>
          <button
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-app-text hover:bg-app-panel"
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              onRaw(task);
            }}
          >
            <Braces className="h-4 w-4 text-app-muted" />
            原始 JSON
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
  const [keyword, setKeyword] = useState("");
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

  const deleteMutation = useMutation({
    mutationFn: (task: Task) => instanceApi.deleteTask(task.id),
    onSuccess: (_data, task) => {
      toast.success("实例删除已提交", getTaskName(task));
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error, task) => {
      toast.error("实例删除失败", `${getTaskName(task)}：${error instanceof Error ? error.message : "请稍后重试"}`);
    },
  });

  const releaseMutation = useMutation({
    mutationFn: (task: Task) => instanceApi.operateTask(task.id),
    onSuccess: (_data, task) => {
      toast.success("实例释放已提交", getTaskName(task));
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error, task) => {
      toast.error("实例释放失败", `${getTaskName(task)}：${error instanceof Error ? error.message : "请稍后重试"}`);
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async (tasks: Task[]) => {
      await runSequentiallyWithDelay(tasks, (task) => instanceApi.deleteTask(task.id));
    },
    onSuccess: (_data, tasks) => {
      toast.success("批量删除已提交", `${tasks.length} 个非运行实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms`);
      setRowSelection({});
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      toast.error("批量删除失败", error instanceof Error ? error.message : "请稍后重试");
    },
  });

  const batchReleaseMutation = useMutation({
    mutationFn: async (tasks: Task[]) => {
      await runSequentiallyWithDelay(tasks, (task) => instanceApi.operateTask(task.id));
    },
    onSuccess: (_data, tasks) => {
      toast.success("批量释放已提交", `${tasks.length} 个运行中实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms`);
      setRowSelection({});
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      toast.error("批量释放失败", error instanceof Error ? error.message : "请稍后重试");
    },
  });

  const batchPending = batchDeleteMutation.isPending || batchReleaseMutation.isPending;
  const autoRefreshPaused = batchPending || createOpen || Boolean(logTask) || Boolean(terminalTask) || Boolean(rawTask) || columnSettingsOpen;
  const query = useQuery({
    queryKey: ["tasks"],
    queryFn: () => instanceApi.tasks({ page: 1, page_size: TASK_LIST_PAGE_SIZE }),
    refetchInterval: autoRefresh && !autoRefreshPaused ? autoRefreshInterval : false,
    refetchIntervalInBackground: false,
  });

  const filteredTasks = useMemo(() => {
    const tasks = query.data?.items ?? [];
    const normalizedKeyword = keyword.trim().toLowerCase();
    if (!normalizedKeyword) return tasks;
    return tasks.filter((task) => taskSearchText(task).includes(normalizedKeyword));
  }, [keyword, query.data?.items]);

  const handleDownloadTask = (task: Task) => {
    void instanceApi.downloadTask({ task_id: task.id }).then((blob) => saveBlob(blob, `${getTaskName(task)}.zip`));
  };

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

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "select",
        header: ({ table }) => (
          <input
            aria-label="选择当前页实例"
            className="h-4 w-4 accent-app-accent"
            type="checkbox"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            aria-label={`选择实例 ${getTaskName(row.original)}`}
            className="h-4 w-4 accent-app-accent"
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      }),
      columnHelper.accessor((row) => getTaskName(row), {
        id: "name",
        header: "实例名称",
        cell: ({ row, getValue }) => (
          <div className="whitespace-nowrap">
            <div className="font-medium">{getValue()}</div>
            <div className="mt-0.5 text-xs text-app-muted">#{row.original.id}</div>
          </div>
        ),
      }),
      columnHelper.accessor("status", {
        header: "状态",
        cell: (info) => <StatusBadge status={info.getValue()} />,
      }),
      columnHelper.accessor((row) => resourceText(row), {
        id: "resource",
        header: "资源",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.node_name || "-", {
        id: "node",
        header: "节点",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => endpointText(row), {
        id: "endpoint",
        header: "入口",
        cell: (info) => <span className="whitespace-nowrap font-mono text-xs text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => ownerText(row), {
        id: "owner",
        header: "用户",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => groupText(row), {
        id: "group",
        header: "用户组",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.use_time, {
        id: "duration",
        header: "时长",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{formatSecondsDuration(info.getValue())}</span>,
      }),
      columnHelper.accessor((row) => row.create_time ?? row.created_at ?? "-", {
        id: "created",
        header: "创建时间",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.releace_time ?? "-", {
        id: "release",
        header: "释放时间",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.releace_conditions ?? row.release_condition, {
        id: "releaseCondition",
        header: "释放条件",
        cell: (info) => <ReleaseConditionBadge condition={info.getValue()} />,
      }),
      columnHelper.accessor((row) => (row.is_delete ? "已删除" : "正常"), {
        id: "deleted",
        header: "删除状态",
        cell: (info) => (
          <span className={info.getValue() === "已删除" ? "text-app-danger" : "text-app-muted"}>{info.getValue()}</span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: () => <ActionHeader />,
        cell: ({ row }) => {
          const task = row.original;
          const release = isRunningTask(task);
          return (
            <div className={ACTION_GRID_CLASS}>
              <Button className="h-8 w-8 px-0" variant="ghost" title="监控" onClick={() => openMonitorDashboard(task)}>
                <ActivitySquare className="h-4 w-4" />
              </Button>
              <Button className="h-8 w-8 px-0" variant="ghost" title="日志" onClick={() => setLogTask(task)}>
                <FileText className="h-4 w-4" />
              </Button>
              <Button className="h-8 w-8 px-0" variant="ghost" title="终端" onClick={() => setTerminalTask(task)}>
                <Terminal className="h-4 w-4" />
              </Button>
              <Button className="h-8 w-8 px-0" variant="ghost" title="复制" onClick={() => openCloneTask(task)}>
                <Copy className="h-4 w-4" />
              </Button>
              {release ? (
                <Button
                  className="h-8 w-20 justify-center px-2 text-app-warning hover:text-app-warning"
                  disabled={releaseMutation.isPending}
                  title="释放"
                  variant="ghost"
                  onClick={() => releaseMutation.mutate(task)}
                >
                  <Power className="h-4 w-4" />
                  释放
                </Button>
              ) : (
                <Button
                  className="h-8 w-20 justify-center px-2 text-app-danger hover:text-app-danger"
                  disabled={deleteMutation.isPending}
                  title="删除"
                  variant="ghost"
                  onClick={() => deleteMutation.mutate(task)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除
                </Button>
              )}
              <MoreActionsMenu task={task} onDownload={handleDownloadTask} onRaw={setRawTask} />
            </div>
          );
        },
      }),
    ],
    [deleteMutation, releaseMutation],
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
  const selectedRunningTasks = selectedTasks.filter(isRunningTask);
  const selectedStoppedTasks = selectedTasks.filter((task) => !isRunningTask(task));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input className="w-72 pl-9" placeholder="搜索实例名称" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          </div>
          <Button variant="secondary" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <div className="flex h-9 items-center gap-2 rounded-md border border-app-border bg-app-surface px-3 text-sm">
            <label className="flex cursor-pointer items-center gap-2 text-app-text">
              <input
                type="checkbox"
                className="h-4 w-4 accent-app-accent"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              自动刷新
            </label>
            <Select
              className="h-7 border-0 bg-app-panel px-2 text-xs"
              disabled={!autoRefresh}
              value={String(autoRefreshInterval)}
              onChange={(event) => setAutoRefreshInterval(Number(event.target.value))}
            >
              {autoRefreshOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            {autoRefresh && autoRefreshPaused ? <span className="text-xs text-app-warning">已暂停</span> : null}
          </div>
          <Button variant="secondary" onClick={() => setColumnSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" />
            列设置
          </Button>
        </div>
        <Button onClick={openCreateTask}>
          <Plus className="h-4 w-4" />
          新建任务
        </Button>
      </div>

      {selectedTasks.length > 0 ? (
        <Panel className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div className="text-sm text-app-muted">
            已选 <span className="font-medium text-app-text">{selectedTasks.length}</span> 个实例
            {selectedRunningTasks.length > 0 ? `，运行中 ${selectedRunningTasks.length} 个` : ""}
            {selectedStoppedTasks.length > 0 ? `，非运行 ${selectedStoppedTasks.length} 个` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selectedRunningTasks.length > 0 ? (
              <Button
                disabled={batchPending}
                variant="secondary"
                onClick={() => batchReleaseMutation.mutate(selectedRunningTasks)}
              >
                <Power className="h-4 w-4 text-app-warning" />
                批量释放 {selectedRunningTasks.length}
              </Button>
            ) : null}
            {selectedStoppedTasks.length > 0 ? (
              <Button
                className="border-app-danger text-app-danger hover:text-app-danger"
                disabled={batchPending}
                variant="secondary"
                onClick={() => batchDeleteMutation.mutate(selectedStoppedTasks)}
              >
                <Trash2 className="h-4 w-4" />
                批量删除 {selectedStoppedTasks.length}
              </Button>
            ) : null}
            <Button disabled={batchPending} variant="ghost" onClick={() => setRowSelection({})}>
              取消选择
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} action={<Button variant="secondary" onClick={() => query.refetch()}>重试</Button>} />
        ) : table.getRowModel().rows.length === 0 && keyword.trim() ? (
          <EmptyState title="未找到匹配实例" action={<Button variant="secondary" onClick={() => setKeyword("")}>清空搜索</Button>} />
        ) : table.getRowModel().rows.length === 0 ? (
          <EmptyState title="暂无任务实例" action={<Button onClick={openCreateTask}>新建任务</Button>} />
        ) : (
          <div className="overflow-auto">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className={[
                          "whitespace-nowrap border-b border-app-border px-3 py-2 font-medium",
                          isActionsColumn(header.column.id)
                            ? "sticky right-0 z-20 bg-app-panel shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]"
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
                            ? "sticky right-0 z-30 bg-app-surface shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]"
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
          </div>
        )}
      </Panel>

      <CreateTaskDialog initialTask={cloneTask} open={createOpen} onClose={closeCreateTask} />
      <TaskLogDialog task={logTask} onClose={() => setLogTask(null)} />
      <Suspense fallback={null}>
        <TerminalDialog task={terminalTask} onClose={() => setTerminalTask(null)} />
      </Suspense>
      <Dialog open={Boolean(rawTask)} title={`实例原始 JSON ${rawTask ? getTaskName(rawTask) : ""}`} onClose={() => setRawTask(null)} width="max-w-4xl">
        <pre className="max-h-[70vh] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
          {asJson(rawTask)}
        </pre>
      </Dialog>
      <Dialog open={columnSettingsOpen} title="列设置" onClose={() => setColumnSettingsOpen(false)} width="max-w-md">
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2">
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
                <span>{columnLabels[column.id] ?? column.id}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 border-t border-app-border pt-3">
            <Button variant="secondary" onClick={() => setColumnVisibility(defaultColumnVisibility)}>
              恢复默认
            </Button>
            <Button onClick={() => setColumnSettingsOpen(false)}>完成</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
