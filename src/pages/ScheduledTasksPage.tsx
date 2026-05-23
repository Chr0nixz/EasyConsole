import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, FolderOpen, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { RemoteStoragePicker } from "../components/storage/RemoteStoragePicker";
import { Button, Input, Panel, Select, Textarea } from "../components/ui";
import { imageApi, instanceApi } from "../lib/api";
import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName, releaseConditionText } from "../lib/format";
import { normalizeStoragePath } from "../lib/remote-storage";
import { browserRuntime } from "../lib/runtime";
import {
  createScheduledTask,
  isScheduleDue,
  loadScheduledTasks,
  saveScheduledTasks,
  sortScheduledTasks,
  updateScheduledTask,
} from "../lib/scheduled-tasks";
import type { CreateTaskPayload, ImageItem, ScheduledTask, ScheduledTaskStatus } from "../lib/types";
import { useAuth } from "../lib/use-auth";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useToast } from "../lib/use-toast";

const DEFAULT_PRICE = 1;
const DEFAULT_CPU = "4";
const DEFAULT_GPU = "0";
const DEFAULT_MEMORY = "16";

type StoragePickerTarget = "storage" | "workDirectory" | "scriptPath";

const statusText: Record<ScheduledTaskStatus, string> = {
  pending: "等待中",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  paused: "已暂停",
};

function getImageOptionLabel(image: ImageItem) {
  const name = image.name ?? image.image_name ?? String(image.id);
  return image.tag ? `${name}:${image.tag}` : name;
}

function normalizeId(value: string) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function parsePositiveNumber(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseNonNegativeInteger(value: string) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function parsePositiveInteger(value: string) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function getDefaultReleaseTime(gpuValue: string) {
  const gpu = parseNonNegativeInteger(gpuValue);
  return formatDateTimeLocalInput(addHours(new Date(), 24 / (gpu && gpu > 0 ? gpu : 1))).slice(0, 16);
}

function statusClass(status: ScheduledTaskStatus) {
  if (status === "done") return "bg-app-successSoft text-app-success ring-app-successRing";
  if (status === "failed") return "bg-app-dangerSoft text-app-danger ring-app-dangerRing";
  if (status === "running") return "bg-app-warningSoft text-app-warning ring-app-warningRing";
  if (status === "paused") return "bg-app-panel text-app-muted ring-app-border";
  return "bg-app-accentSoft text-app-accent ring-app-accent/20";
}

function formatScheduleTime(value: string) {
  return value.replace("T", " ").slice(0, 16);
}

export function ScheduledTasksPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirmAction();
  const username = auth.user?.username ?? "";
  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [storagePickerTarget, setStoragePickerTarget] = useState<StoragePickerTarget | null>(null);
  const [name, setName] = useState(formatTaskDefaultName());
  const [description, setDescription] = useState("");
  const [scheduleTime, setScheduleTime] = useState(formatDateTimeLocalInput(addHours(new Date(), 1)).slice(0, 16));
  const [imageId, setImageId] = useState("");
  const [cpu, setCpu] = useState(DEFAULT_CPU);
  const [gpu, setGpu] = useState(DEFAULT_GPU);
  const [memory, setMemory] = useState(DEFAULT_MEMORY);
  const [releaseCondition, setReleaseCondition] = useState("1");
  const [releaseTime, setReleaseTime] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [workDirectory, setWorkDirectory] = useState("");
  const [scriptPath, setScriptPath] = useState("");

  const images = useQuery({ queryKey: ["images", "scheduled-task"], queryFn: () => imageApi.list({ page: 1, page_size: 100 }) });
  const systemImages = useQuery({ queryKey: ["images", "system", "scheduled-task"], queryFn: () => imageApi.system({}) });
  const imageOptions = useMemo(() => [...(images.data?.items ?? []), ...(systemImages.data?.items ?? [])], [images.data, systemImages.data]);

  useEffect(() => {
    void loadScheduledTasks(browserRuntime.storage)
      .then((loaded) => {
        setItems(sortScheduledTasks(loaded));
        setLoadError(null);
      })
      .catch((error) => setLoadError(error instanceof Error ? error : new Error("定时任务读取失败")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!imageId && imageOptions[0]) setImageId(String(imageOptions[0].id));
  }, [imageId, imageOptions]);

  useEffect(() => {
    if (!storagePath) setStoragePath(`/${username}`);
    if (!mountPath) setMountPath(`/home/ubuntu/${username}`);
  }, [mountPath, storagePath, username]);

  async function persist(nextItems: ScheduledTask[]) {
    const sorted = sortScheduledTasks(nextItems);
    setItems(sorted);
    await saveScheduledTasks(browserRuntime.storage, sorted);
  }

  function handleReleaseConditionChange(value: string) {
    setReleaseCondition(value);
    setReleaseTime(value === "2" ? getDefaultReleaseTime(gpu) : "");
  }

  function handleGpuChange(value: string) {
    setGpu(value);
    if (releaseCondition === "2") setReleaseTime(getDefaultReleaseTime(value));
  }

  function buildPayload(): CreateTaskPayload | null {
    const taskName = name.trim();
    if (!taskName) {
      setFormError("任务名称不能为空");
      return null;
    }
    if (!scheduleTime) {
      setFormError("请选择计划执行时间");
      return null;
    }
    if (!imageId) {
      setFormError("请选择镜像");
      return null;
    }
    const cpuValue = parsePositiveNumber(cpu);
    const gpuValue = parseNonNegativeInteger(gpu);
    const memoryValue = parsePositiveInteger(memory);
    if (cpuValue === null) {
      setFormError("CPU 必须大于 0");
      return null;
    }
    if (gpuValue === null) {
      setFormError("GPU 必须是非负整数");
      return null;
    }
    if (memoryValue === null) {
      setFormError("内存必须是正整数");
      return null;
    }
    const releaceConditions = Number(releaseCondition);
    if (releaceConditions === 2 && !releaseTime) {
      setFormError("请选择释放时间");
      return null;
    }
    if (releaceConditions === 3 && (!workDirectory.trim() || !scriptPath.trim())) {
      setFormError("请填写工作目录和脚本路径");
      return null;
    }

    return {
      price: DEFAULT_PRICE,
      name: taskName,
      cpu: cpuValue,
      gpu: gpuValue > 0 ? gpuValue : undefined,
      memory: memoryValue,
      img: normalizeId(imageId),
      storage_path: normalizeStoragePath(storagePath.trim() || `/${username}`),
      mount_path: mountPath.trim() || `/home/ubuntu/${username}`,
      releace_conditions: releaceConditions,
      releace_time: releaceConditions === 2 ? formatDateTimeForApi(releaseTime) : undefined,
      work_directory: releaceConditions === 3 ? workDirectory.trim() : undefined,
      script_path: releaceConditions === 3 ? scriptPath.trim() : undefined,
    };
  }

  const createMutation = useMutation({
    mutationFn: async (event: FormEvent) => {
      event.preventDefault();
      setFormError(null);
      const payload = buildPayload();
      if (!payload) return null;
      const scheduled = createScheduledTask({
        name: payload.name,
        description: description.trim() || undefined,
        scheduleTime,
        payload,
      });
      await persist([scheduled, ...items]);
      return scheduled;
    },
    onSuccess: (scheduled) => {
      if (!scheduled) return;
      toast.success("定时任务已保存", `${scheduled.name}，${formatScheduleTime(scheduled.scheduleTime)} 执行`);
      setName(formatTaskDefaultName());
      setDescription("");
      setScheduleTime(formatDateTimeLocalInput(addHours(new Date(), 1)).slice(0, 16));
    },
    onError: (error) => toast.error("定时任务保存失败", error instanceof Error ? error.message : "请稍后重试"),
  });

  async function executeTargets(targets: ScheduledTask[]) {
    if (targets.length === 0 || isExecuting) return;
    setIsExecuting(true);
    let next = items;
    try {
      for (const target of targets) {
        next = updateScheduledTask(next, { ...target, status: "running", lastError: undefined });
        await persist(next);
        try {
          await instanceApi.createTask(target.payload);
          next = updateScheduledTask(next, { ...target, status: "done", lastRunAt: new Date().toISOString(), lastError: undefined });
          await persist(next);
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          toast.success("定时任务已执行", target.name);
        } catch (error) {
          next = updateScheduledTask(next, {
            ...target,
            status: "failed",
            lastRunAt: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : "执行失败",
          });
          await persist(next);
          toast.error("定时任务执行失败", `${target.name}：${error instanceof Error ? error.message : "请稍后重试"}`);
        }
      }
    } finally {
      setIsExecuting(false);
    }
  }

  useEffect(() => {
    if (loading || isExecuting) return undefined;
    const timer = window.setInterval(() => {
      const due = items.filter((item) => isScheduleDue(item));
      if (due.length > 0) void executeTargets(due);
    }, 30_000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExecuting, items, loading]);

  useEffect(() => {
    if (loading || isExecuting) return;
    const due = items.filter((item) => isScheduleDue(item));
    if (due.length > 0) void executeTargets(due);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  function deleteItem(item: ScheduledTask) {
    confirm({
      title: "删除定时任务",
      description: `将删除 ${item.name}。已创建的实例不受影响。`,
      confirmLabel: "删除",
      tone: "danger",
      run: () => persist(items.filter((current) => current.id !== item.id)),
    });
  }

  function retryItem(item: ScheduledTask) {
    void executeTargets([{ ...item, status: "pending" }]);
  }

  const dueCount = items.filter((item) => isScheduleDue(item)).length;
  const pickerMode = storagePickerTarget === "scriptPath" ? "file" : "directory";
  const pickerInitialPath =
    storagePickerTarget === "scriptPath"
      ? workDirectory || storagePath || "/"
      : storagePickerTarget === "workDirectory"
        ? workDirectory || storagePath || "/"
        : storagePath || "/";

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">定时任务</h2>
          <p className="mt-1 text-sm text-app-muted">按计划提交实例创建请求。浏览器或桌面壳打开时会自动检查到期计划。</p>
        </div>
        <Button disabled={dueCount === 0 || isExecuting} variant="secondary" onClick={() => executeTargets(items.filter((item) => isScheduleDue(item)))}>
          <RefreshCw className="h-4 w-4" />
          执行到期 {dueCount > 0 ? dueCount : ""}
        </Button>
      </div>

      {loadError ? <ErrorState error={loadError} action={<Button variant="secondary" onClick={() => window.location.reload()}>重新加载</Button>} /> : null}
      {images.isError ? <ErrorState error={images.error} /> : null}
      {systemImages.isError ? <ErrorState error={systemImages.error} /> : null}

      <Panel>
        <form className="space-y-4 p-4" onSubmit={(event) => createMutation.mutate(event)}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4 text-app-accent" />
            新建计划
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">任务名称</span>
              <Input className="w-full" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">计划执行时间</span>
              <Input className="w-full" type="datetime-local" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">镜像</span>
              <Select className="w-full" value={imageId} onChange={(event) => setImageId(event.target.value)} required>
                <option value="">请选择镜像</option>
                {imageOptions.map((image) => (
                  <option key={String(image.id)} value={String(image.id)}>
                    {getImageOptionLabel(image)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">备注</span>
            <Textarea className="min-h-16 w-full" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">CPU</span>
              <Input className="w-full" min="0.1" step="0.1" type="number" value={cpu} onChange={(event) => setCpu(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">GPU</span>
              <Input className="w-full" min="0" step="1" type="number" value={gpu} onChange={(event) => handleGpuChange(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">内存 (GiB)</span>
              <Input className="w-full" min="1" step="1" type="number" value={memory} onChange={(event) => setMemory(event.target.value)} required />
            </label>
          </div>
          <div className="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <span className="mb-1 block text-app-muted">存储路径</span>
              <div className="flex gap-2">
                <Input className="w-full font-mono text-xs" value={storagePath} onChange={(event) => setStoragePath(event.target.value)} />
                <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("storage")}>
                  <FolderOpen className="h-4 w-4" />
                  选择
                </Button>
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-app-muted">挂载路径</span>
              <Input className="w-full font-mono text-xs" value={mountPath} onChange={(event) => setMountPath(event.target.value)} />
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">释放条件</span>
              <Select className="w-full" value={releaseCondition} onChange={(event) => handleReleaseConditionChange(event.target.value)}>
                {Object.entries(releaseConditionText).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            {releaseCondition === "2" ? (
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">释放时间</span>
                <Input className="w-full" type="datetime-local" value={releaseTime} onChange={(event) => setReleaseTime(event.target.value)} required />
              </label>
            ) : null}
          </div>
          {releaseCondition === "3" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="block text-sm">
                <span className="mb-1 block text-app-muted">工作目录</span>
                <div className="flex gap-2">
                  <Input className="w-full font-mono text-xs" value={workDirectory} onChange={(event) => setWorkDirectory(event.target.value)} required />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("workDirectory")}>
                    <FolderOpen className="h-4 w-4" />
                    选择
                  </Button>
                </div>
              </div>
              <div className="block text-sm">
                <span className="mb-1 block text-app-muted">脚本路径</span>
                <div className="flex gap-2">
                  <Input className="w-full font-mono text-xs" value={scriptPath} onChange={(event) => setScriptPath(event.target.value)} required />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                    <FolderOpen className="h-4 w-4" />
                    选择
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
          <div className="flex justify-end">
            <Button disabled={createMutation.isPending}>
              <Plus className="h-4 w-4" />
              保存定时任务
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState title="还没有定时任务。设置计划时间后，EasyConsole 会在到期时提交实例创建请求。" />
        ) : (
          <div className="overflow-auto">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">计划</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">执行时间</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">资源</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">状态</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">最近结果</th>
                  <th className="sticky right-0 z-20 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 text-center font-medium shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <div className="font-medium">{item.name}</div>
                      <div className="mt-0.5 max-w-72 truncate text-xs text-app-muted">{item.description || item.payload.storage_path || "-"}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{formatScheduleTime(item.scheduleTime)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">
                      {item.payload.cpu ?? "-"}C / {item.payload.gpu ?? 0}GPU / {item.payload.memory ?? "-"}G
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <span className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-medium ring-1 ${statusClass(item.status)}`}>
                        {statusText[item.status]}
                      </span>
                    </td>
                    <td className="max-w-96 px-3 py-2 align-middle text-app-muted">
                      {item.lastError ? <span className="text-app-danger">{item.lastError}</span> : item.lastRunAt ? formatScheduleTime(item.lastRunAt) : "-"}
                    </td>
                    <td className="sticky right-0 z-10 bg-app-surface px-3 py-2 align-middle shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]">
                      <div className="flex justify-end gap-1">
                        <Button
                          className="h-8 px-2"
                          disabled={isExecuting || item.status === "running"}
                          title="立即执行"
                          type="button"
                          variant="ghost"
                          onClick={() => retryItem(item)}
                        >
                          <Play className="h-4 w-4" />
                          执行
                        </Button>
                        <Button className="h-8 w-8 px-0 text-app-danger hover:text-app-danger" title="删除" type="button" variant="ghost" onClick={() => deleteItem(item)}>
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">删除</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <RemoteStoragePicker
        initialPath={pickerInitialPath}
        mode={pickerMode}
        open={storagePickerTarget !== null}
        title={storagePickerTarget === "storage" ? "选择存储目录" : storagePickerTarget === "workDirectory" ? "选择工作目录" : "选择脚本文件"}
        onClose={() => setStoragePickerTarget(null)}
        onSelect={(path) => {
          if (storagePickerTarget === "storage") setStoragePath(path);
          if (storagePickerTarget === "workDirectory") setWorkDirectory(path);
          if (storagePickerTarget === "scriptPath") setScriptPath(path);
          setStoragePickerTarget(null);
        }}
      />
      {confirmDialog}
    </div>
  );
}
