import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type VisibilityState } from "@tanstack/react-table";
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
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { ReleaseConditionBadge } from "../components/ReleaseConditionBadge";
import { StatusBadge } from "../components/StatusBadge";
import { CreateTaskDialog } from "../components/tasks/CreateTaskDialog";
import { TaskLogDialog } from "../components/tasks/TaskLogDialog";
import { TerminalDialog } from "../components/tasks/TerminalDialog";
import { Button, Dialog, Input, Panel } from "../components/ui";
import { instanceApi } from "../lib/api";
import { saveBlob } from "../lib/download";
import { asJson, formatCost, formatHours, getTaskName } from "../lib/format";
import { openMonitorDashboard } from "../lib/monitor-dashboard";
import type { Task } from "../lib/types";

const columnHelper = createColumnHelper<Task>();
const COLUMN_VISIBILITY_KEY = "easy-console.tasks.columnVisibility";
const ALWAYS_VISIBLE_COLUMNS = new Set(["actions"]);
const defaultColumnVisibility: VisibilityState = {};
const columnLabels: Record<string, string> = {
  name: "实例名称",
  status: "状态",
  resource: "资源",
  node: "节点",
  endpoint: "入口",
  owner: "用户",
  group: "用户组",
  cost: "费用/时长",
  created: "创建时间",
  release: "释放时间",
  releaseCondition: "释放条件",
  deleted: "删除状态",
};

function resourceText(task: Task) {
  return `${task.cpu ?? "-"}C / ${task.gpu ?? "-"}GPU / ${task.memory ?? "-"}G`;
}

function endpointText(task: Task) {
  return task.ip && task.ip !== "None" ? task.ip : "-";
}

function isRunningTask(task: Task) {
  return Number(task.status) === 2;
}

function loadColumnVisibility(): VisibilityState {
  try {
    const raw = window.localStorage.getItem(COLUMN_VISIBILITY_KEY);
    if (!raw) return defaultColumnVisibility;
    const parsed = JSON.parse(raw) as VisibilityState;
    delete parsed.actions;
    return parsed;
  } catch {
    return defaultColumnVisibility;
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

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
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
      {open ? (
        <div
          className="absolute right-0 top-9 z-20 w-36 rounded-md border border-app-border bg-app-surface p-1 shadow-popover"
          role="menu"
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
        </div>
      ) : null}
    </div>
  );
}

export function TasksPage() {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneTask, setCloneTask] = useState<Task | null>(null);
  const [logTask, setLogTask] = useState<Task | null>(null);
  const [terminalTask, setTerminalTask] = useState<Task | null>(null);
  const [rawTask, setRawTask] = useState<Task | null>(null);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => loadColumnVisibility());
  const query = useQuery({
    queryKey: ["tasks", keyword],
    queryFn: () => instanceApi.tasks({ page: 1, page_size: 50, keyword, name: keyword }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string | number) => instanceApi.deleteTask(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const releaseMutation = useMutation({
    mutationFn: (id: string | number) => instanceApi.operateTask(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

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
      columnHelper.accessor((row) => getTaskName(row), {
        id: "name",
        header: "实例名称",
        cell: ({ row, getValue }) => (
          <div className="min-w-44">
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
      columnHelper.accessor((row) => row.username ?? "-", {
        id: "owner",
        header: "用户",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.user_group ?? "-", {
        id: "group",
        header: "用户组",
        cell: (info) => <span className="whitespace-nowrap text-app-muted">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.cost, {
        id: "cost",
        header: "费用/时长",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-app-muted">
            {formatCost(row.original.cost)} / {formatHours(row.original.use_time)}
          </span>
        ),
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
        header: "操作",
        cell: ({ row }) => {
          const task = row.original;
          const release = isRunningTask(task);
          return (
            <div className="flex items-center gap-1">
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
                  className="h-8 px-2 text-app-warning hover:text-app-warning"
                  disabled={releaseMutation.isPending}
                  title="释放"
                  variant="ghost"
                  onClick={() => releaseMutation.mutate(task.id)}
                >
                  <Power className="h-4 w-4" />
                  释放
                </Button>
              ) : (
                <Button
                  className="h-8 px-2 text-app-danger hover:text-app-danger"
                  disabled={deleteMutation.isPending}
                  title="删除"
                  variant="ghost"
                  onClick={() => deleteMutation.mutate(task.id)}
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
    data: query.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnVisibility,
    },
    onColumnVisibilityChange: setColumnVisibility,
  });

  useEffect(() => {
    window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(columnVisibility));
  }, [columnVisibility]);

  const configurableColumns = table.getAllLeafColumns().filter((column) => !ALWAYS_VISIBLE_COLUMNS.has(column.id));

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

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} action={<Button variant="secondary" onClick={() => query.refetch()}>重试</Button>} />
        ) : table.getRowModel().rows.length === 0 ? (
          <EmptyState title="暂无任务实例" action={<Button onClick={openCreateTask}>新建任务</Button>} />
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[1500px] border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} className="border-b border-app-border px-3 py-2 font-medium">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-middle">
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
      <TerminalDialog task={terminalTask} onClose={() => setTerminalTask(null)} />
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
