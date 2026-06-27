import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, FolderOpen, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { FieldError, fieldBorderClass, useFormFieldErrors } from "../components/form-fields";
import { RemoteStoragePicker } from "../components/storage/RemoteStoragePicker";
import { Button, Input, Panel, Select, TableRegion, Textarea } from "../components/ui";
import { imageApi, instanceApi } from "../lib/api";
import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName, releaseConditionText, releaseConditionTextEn } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { normalizeStoragePath } from "../lib/remote-storage";
import { browserRuntime } from "../lib/runtime";
import { cn } from "../lib/utils";
import {
  createScheduledTask,
  isScheduleDue,
  loadScheduledTasks,
  saveScheduledTasks,
  sortScheduledTasks,
  updateScheduledTask,
} from "../lib/scheduled-tasks";
import { describeRecurrence } from "../lib/task-recurrence";
import type { CreateTaskPayload, ImageItem, ScheduledTask, ScheduledTaskStatus, TaskRecurrence, TaskRecurrenceType } from "../lib/types";
import { useAuth } from "../lib/use-auth";
import { useConfirmAction } from "../lib/use-confirm-action";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

const DEFAULT_PRICE = 1;
const DEFAULT_CPU = "4";
const DEFAULT_GPU = "0";
const DEFAULT_MEMORY = "16";

type StoragePickerTarget = "storage" | "workDirectory" | "scriptPath";

const statusText: Record<ScheduledTaskStatus, { zh: string; en: string }> = {
  pending: { zh: "等待中", en: "Pending" },
  running: { zh: "执行中", en: "Running" },
  done: { zh: "已完成", en: "Done" },
  failed: { zh: "失败", en: "Failed" },
  paused: { zh: "已暂停", en: "Paused" },
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
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirmAction();
  const username = auth.user?.username ?? "";
  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const { touchedFields, markTouched, touchAll, resetTouched } = useFormFieldErrors();
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
  const [recurrenceType, setRecurrenceType] = useState<TaskRecurrenceType>("once");
  const [recurrenceIntervalSec, setRecurrenceIntervalSec] = useState("3600");
  const [recurrenceCron, setRecurrenceCron] = useState("");

  const images = useQuery({ queryKey: ["images", "scheduled-task"], queryFn: () => imageApi.list({ page: 1, page_size: 100 }) });
  const systemImages = useQuery({ queryKey: ["images", "system", "scheduled-task"], queryFn: () => imageApi.system({}) });
  const imageOptions = useMemo(() => [...(images.data?.items ?? []), ...(systemImages.data?.items ?? [])], [images.data, systemImages.data]);

  const fieldErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = text("任务名称不能为空", "Task name is required");
    if (!scheduleTime) errors.scheduleTime = text("请选择计划执行时间", "Select a scheduled execution time");
    if (!imageId) errors.image = text("请选择镜像", "Select an image");
    if (parsePositiveNumber(cpu) === null) errors.cpu = text("CPU 必须大于 0", "CPU must be greater than 0");
    if (parseNonNegativeInteger(gpu) === null) errors.gpu = text("GPU 必须是非负整数", "GPU must be a non-negative integer");
    if (parsePositiveInteger(memory) === null) errors.memory = text("内存必须是正整数", "Memory must be a positive integer");
    const cond = Number(releaseCondition);
    if (cond === 2 && !releaseTime) errors.releaseTime = text("请选择释放时间", "Select a release time");
    if (cond === 3 && !workDirectory.trim()) errors.workDirectory = text("请填写工作目录", "Enter the working directory");
    if (cond === 3 && !scriptPath.trim()) errors.scriptPath = text("请填写脚本路径", "Enter the script path");
    return errors;
  }, [cpu, gpu, imageId, memory, name, releaseCondition, releaseTime, scheduleTime, scriptPath, text, workDirectory]);

  useEffect(() => {
    void loadScheduledTasks(browserRuntime.storage)
      .then((loaded) => {
        setItems(sortScheduledTasks(loaded));
        setLoadError(null);
      })
      .catch((error) => setLoadError(error instanceof Error ? error : new Error(text("定时任务读取失败", "Failed to read scheduled tasks"))))
      .finally(() => setLoading(false));
  }, [text]);

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
    touchAll(["name", "scheduleTime", "image", "cpu", "gpu", "memory", "releaseTime", "workDirectory", "scriptPath"]);
    const taskName = name.trim();
    if (!taskName) {
      setFormError(text("任务名称不能为空", "Task name is required"));
      return null;
    }
    if (!scheduleTime) {
      setFormError(text("请选择计划执行时间", "Select a scheduled execution time"));
      return null;
    }
    const scheduledTime = Date.parse(scheduleTime);
    if (Number.isFinite(scheduledTime) && scheduledTime < Date.now()) {
      setFormError(text("计划执行时间不能早于当前时间", "Scheduled time cannot be in the past"));
      return null;
    }
    if (!imageId) {
      setFormError(text("请选择镜像", "Select an image"));
      return null;
    }
    const cpuValue = parsePositiveNumber(cpu);
    const gpuValue = parseNonNegativeInteger(gpu);
    const memoryValue = parsePositiveInteger(memory);
    if (cpuValue === null) {
      setFormError(text("CPU 必须大于 0", "CPU must be greater than 0"));
      return null;
    }
    if (gpuValue === null) {
      setFormError(text("GPU 必须是非负整数", "GPU must be a non-negative integer"));
      return null;
    }
    if (memoryValue === null) {
      setFormError(text("内存必须是正整数", "Memory must be a positive integer"));
      return null;
    }
    const releaceConditions = Number(releaseCondition);
    if (releaceConditions === 2 && !releaseTime) {
      setFormError(text("请选择释放时间", "Select a release time"));
      return null;
    }
    if (releaceConditions === 3 && (!workDirectory.trim() || !scriptPath.trim())) {
      setFormError(text("请填写工作目录和脚本路径", "Enter the working directory and script path"));
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
      let recurrence: TaskRecurrence | undefined;
      if (recurrenceType === "interval") {
        const sec = parseInt(recurrenceIntervalSec, 10);
        if (Number.isFinite(sec) && sec > 0) recurrence = { type: "interval", intervalSec: sec };
      } else if (recurrenceType === "cron") {
        if (recurrenceCron.trim()) recurrence = { type: "cron", cron: recurrenceCron.trim() };
      } else if (recurrenceType !== "once") {
        recurrence = { type: recurrenceType };
      }
      const scheduled = createScheduledTask({
        name: payload.name,
        description: description.trim() || undefined,
        scheduleTime,
        payload,
        recurrence,
      });
      await persist([scheduled, ...items]);
      return scheduled;
    },
    onSuccess: (scheduled) => {
      if (!scheduled) return;
      toast.success(text("定时任务已保存", "Scheduled task saved"), text(`${scheduled.name}，${formatScheduleTime(scheduled.scheduleTime)} 执行`, `${scheduled.name}, runs at ${formatScheduleTime(scheduled.scheduleTime)}`));
      void runLogger.log({
        source: "scheduled-task",
        level: "info",
        action: "scheduledTask.save",
        result: "success",
        title: text("定时任务已保存", "Scheduled task saved"),
        targetName: scheduled.name,
        targetId: scheduled.id,
        metadata: { scheduleTime: scheduled.scheduleTime },
      });
      setName(formatTaskDefaultName());
      setDescription("");
      setScheduleTime(formatDateTimeLocalInput(addHours(new Date(), 1)).slice(0, 16));
      setRecurrenceType("once");
      setRecurrenceIntervalSec("3600");
      setRecurrenceCron("");
      resetTouched();
    },
    onError: (error) => {
      toast.error(text("定时任务保存失败", "Failed to save scheduled task"), error instanceof Error ? error.message : text("请稍后重试", "Try again later"));
      void runLogger.log({
        source: "scheduled-task",
        level: "error",
        action: "scheduledTask.save",
        result: "failure",
        title: text("定时任务保存失败", "Failed to save scheduled task"),
        targetName: name.trim(),
        error: errorMessage(error, text("定时任务保存失败", "Failed to save scheduled task")),
      });
    },
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
          toast.success(text("定时任务已执行", "Scheduled task executed"), target.name);
          void runLogger.log({
            source: "scheduled-task",
            level: "info",
            action: "scheduledTask.execute",
            result: "success",
            title: text("定时任务已执行", "Scheduled task executed"),
            targetName: target.name,
            targetId: target.id,
          });
        } catch (error) {
          next = updateScheduledTask(next, {
            ...target,
            status: "failed",
            lastRunAt: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : text("执行失败", "Execution failed"),
          });
          await persist(next);
          toast.error(text("定时任务执行失败", "Scheduled task execution failed"), `${target.name}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
          void runLogger.log({
            source: "scheduled-task",
            level: "error",
            action: "scheduledTask.execute",
            result: "failure",
            title: text("定时任务执行失败", "Scheduled task execution failed"),
            targetName: target.name,
            targetId: target.id,
            error: errorMessage(error, text("定时任务执行失败", "Scheduled task execution failed")),
          });
        }
      }
    } finally {
      setIsExecuting(false);
    }
  }

  function deleteItem(item: ScheduledTask) {
    confirm({
      title: text("删除定时任务", "Delete Scheduled Task"),
      description: text(`将删除 ${item.name}。已创建的实例不受影响。`, `Delete ${item.name}. Created instances are not affected.`),
      confirmLabel: text("删除", "Delete"),
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
          <h2 className="text-base font-semibold">{text("定时任务", "Scheduled Tasks")}</h2>
          <p className="mt-1 text-sm text-app-muted">{text("按计划提交实例创建请求。浏览器或桌面壳打开时会自动检查到期计划。", "Submit instance creation requests on a schedule. The browser or desktop shell checks due plans while open.")}</p>
        </div>
        <Button disabled={dueCount === 0 || isExecuting} variant="secondary" onClick={() => executeTargets(items.filter((item) => isScheduleDue(item)))}>
          <RefreshCw className="h-4 w-4" />
          {text("执行到期", "Run due")} {dueCount > 0 ? dueCount : ""}
        </Button>
      </div>

      {loadError ? <ErrorState error={loadError} action={<Button variant="secondary" onClick={() => window.location.reload()}>{text("重新加载", "Reload")}</Button>} /> : null}
      {images.isError ? <ErrorState error={images.error} /> : null}
      {systemImages.isError ? <ErrorState error={systemImages.error} /> : null}

      <Panel>
        <form className="space-y-4 p-4" onSubmit={(event) => createMutation.mutate(event)}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4 text-app-accent" />
            {text("新建计划", "New Plan")}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("任务名称", "Task name")}</span>
              <Input className={cn("w-full", fieldBorderClass(touchedFields.has("name") && Boolean(fieldErrors.name)))} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => markTouched("name")} required />
              <FieldError message={touchedFields.has("name") ? fieldErrors.name : undefined} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("计划执行时间", "Scheduled time")}</span>
              <Input className={cn("w-full", fieldBorderClass(touchedFields.has("scheduleTime") && Boolean(fieldErrors.scheduleTime)))} type="datetime-local" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} onBlur={() => markTouched("scheduleTime")} required />
              <FieldError message={touchedFields.has("scheduleTime") ? fieldErrors.scheduleTime : undefined} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("重复", "Repeat")}</span>
              <Select className="w-full" value={recurrenceType} onChange={(event) => setRecurrenceType(event.target.value as TaskRecurrenceType)}>
                <option value="once">{text("单次", "Once")}</option>
                <option value="daily">{text("每天", "Daily")}</option>
                <option value="weekly">{text("每周", "Weekly")}</option>
                <option value="interval">{text("间隔", "Interval")}</option>
                <option value="cron">{text("Cron 表达式", "Cron expression")}</option>
              </Select>
            </label>
            {recurrenceType === "interval" && (
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("间隔秒数", "Interval (seconds)")}</span>
                <Input className="w-full" type="number" min="60" value={recurrenceIntervalSec} onChange={(event) => setRecurrenceIntervalSec(event.target.value)} />
              </label>
            )}
            {recurrenceType === "cron" && (
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("Cron 表达式", "Cron expression")}</span>
                <Input className="w-full" placeholder="*/30 * * * *（仅支持 *、数字、逗号、连字符）" value={recurrenceCron} onChange={(event) => setRecurrenceCron(event.target.value)} />
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("镜像", "Image")}</span>
              <Select className={cn("w-full", fieldBorderClass(touchedFields.has("image") && Boolean(fieldErrors.image)))} value={imageId} onChange={(event) => setImageId(event.target.value)} onBlur={() => markTouched("image")} required>
                <option value="">{text("请选择镜像", "Select an image")}</option>
                {imageOptions.map((image) => (
                  <option key={String(image.id)} value={String(image.id)}>
                    {getImageOptionLabel(image)}
                  </option>
                ))}
              </Select>
              <FieldError message={touchedFields.has("image") ? fieldErrors.image : undefined} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("备注", "Notes")}</span>
            <Textarea className="min-h-16 w-full" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">CPU</span>
              <Input className={cn("w-full", fieldBorderClass(touchedFields.has("cpu") && Boolean(fieldErrors.cpu)))} min="0.1" step="0.1" type="number" value={cpu} onChange={(event) => setCpu(event.target.value)} onBlur={() => markTouched("cpu")} required />
              <FieldError message={touchedFields.has("cpu") ? fieldErrors.cpu : undefined} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">GPU</span>
              <Input className={cn("w-full", fieldBorderClass(touchedFields.has("gpu") && Boolean(fieldErrors.gpu)))} min="0" step="1" type="number" value={gpu} onChange={(event) => handleGpuChange(event.target.value)} onBlur={() => markTouched("gpu")} required />
              <FieldError message={touchedFields.has("gpu") ? fieldErrors.gpu : undefined} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("内存 (GiB)", "Memory (GiB)")}</span>
              <Input className={cn("w-full", fieldBorderClass(touchedFields.has("memory") && Boolean(fieldErrors.memory)))} min="1" step="1" type="number" value={memory} onChange={(event) => setMemory(event.target.value)} onBlur={() => markTouched("memory")} required />
              <FieldError message={touchedFields.has("memory") ? fieldErrors.memory : undefined} />
            </label>
          </div>
          <div className="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <span className="mb-1 block text-app-muted">{text("存储路径", "Storage path")}</span>
              <div className="flex gap-2">
                <Input className="w-full font-mono text-xs" value={storagePath} onChange={(event) => setStoragePath(event.target.value)} />
                <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("storage")}>
                  <FolderOpen className="h-4 w-4" />
                  {text("选择", "Select")}
                </Button>
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-app-muted">{text("挂载路径", "Mount path")}</span>
              <Input className="w-full font-mono text-xs" value={mountPath} onChange={(event) => setMountPath(event.target.value)} />
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("释放条件", "Release condition")}</span>
              <Select className="w-full" value={releaseCondition} onChange={(event) => handleReleaseConditionChange(event.target.value)}>
                {Object.entries(locale === "en-US" ? releaseConditionTextEn : releaseConditionText).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            {releaseCondition === "2" ? (
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("释放时间", "Release time")}</span>
                <Input className={cn("w-full", fieldBorderClass(touchedFields.has("releaseTime") && Boolean(fieldErrors.releaseTime)))} type="datetime-local" value={releaseTime} onChange={(event) => setReleaseTime(event.target.value)} onBlur={() => markTouched("releaseTime")} required />
                <FieldError message={touchedFields.has("releaseTime") ? fieldErrors.releaseTime : undefined} />
              </label>
            ) : null}
          </div>
          {releaseCondition === "3" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("工作目录", "Working directory")}</span>
                <div className="flex gap-2">
                  <Input className={cn("w-full font-mono text-xs", fieldBorderClass(touchedFields.has("workDirectory") && Boolean(fieldErrors.workDirectory)))} value={workDirectory} onChange={(event) => setWorkDirectory(event.target.value)} onBlur={() => markTouched("workDirectory")} required />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("workDirectory")}>
                    <FolderOpen className="h-4 w-4" />
                    {text("选择", "Select")}
                  </Button>
                </div>
                <FieldError message={touchedFields.has("workDirectory") ? fieldErrors.workDirectory : undefined} />
              </div>
              <div className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("脚本路径", "Script path")}</span>
                <div className="flex gap-2">
                  <Input className={cn("w-full font-mono text-xs", fieldBorderClass(touchedFields.has("scriptPath") && Boolean(fieldErrors.scriptPath)))} value={scriptPath} onChange={(event) => setScriptPath(event.target.value)} onBlur={() => markTouched("scriptPath")} required />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                    <FolderOpen className="h-4 w-4" />
                    {text("选择", "Select")}
                  </Button>
                </div>
                <FieldError message={touchedFields.has("scriptPath") ? fieldErrors.scriptPath : undefined} />
              </div>
            </div>
          ) : null}
          {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
          <div className="flex justify-end">
            <Button disabled={createMutation.isPending}>
              <Plus className="h-4 w-4" />
              {text("保存定时任务", "Save scheduled task")}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState title={text("还没有定时任务。设置计划时间后，EasyConsole 会在到期时提交实例创建请求。", "No scheduled tasks yet. After you set a schedule, EasyConsole submits the instance creation request when it is due.")} />
        ) : (
          <>
              {/* Mobile card view */}
              <div className="divide-y divide-app-border sm:hidden">
                {items.map((item) => (
                  <article key={item.id} className="space-y-3 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{item.name}</div>
                        <div className="mt-0.5 truncate text-xs text-app-muted">{item.description || item.payload.storage_path || "-"}</div>
                      </div>
                      <span className={`inline-flex h-6 shrink-0 items-center rounded-md px-2 text-xs font-medium ring-1 ${statusClass(item.status)}`}>
                        {locale === "en-US" ? statusText[item.status].en : statusText[item.status].zh}
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <div>
                        <dt className="text-app-muted">{text("执行时间", "Run time")}</dt>
                        <dd>{formatScheduleTime(item.scheduleTime)}</dd>
                      </div>
                      <div>
                        <dt className="text-app-muted">{text("重复", "Repeat")}</dt>
                        <dd>{item.recurrence ? describeRecurrence(item.recurrence) : text("单次", "Once")}</dd>
                      </div>
                      <div>
                        <dt className="text-app-muted">{text("资源", "Resources")}</dt>
                        <dd>{item.payload.cpu ?? "-"}C / {item.payload.gpu ?? 0}GPU / {item.payload.memory ?? "-"}G</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-app-muted">{text("最近结果", "Latest result")}</dt>
                        <dd>
                          {item.lastError ? <span className="text-app-danger">{item.lastError}</span> : item.lastRunAt ? formatScheduleTime(item.lastRunAt) : "-"}
                        </dd>
                      </div>
                    </dl>
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        className="h-8 px-2"
                        disabled={isExecuting || item.status === "running"}
                        title={text("立即执行", "Run now")}
                        type="button"
                        variant="ghost"
                        onClick={() => retryItem(item)}
                      >
                        <Play className="h-4 w-4" />
                        {text("执行", "Run")}
                      </Button>
                      <Button
                        aria-label={text(`删除定时任务 ${item.name}`, `Delete scheduled task ${item.name}`)}
                        className="h-8 w-8 px-0 text-app-danger hover:text-app-danger"
                        title={text("删除", "Delete")}
                        type="button"
                        variant="ghost"
                        onClick={() => deleteItem(item)}
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only">{text("删除", "Delete")}</span>
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              {/* Desktop table view */}
              <TableRegion className="hidden sm:block" label={text("定时任务表格", "Scheduled tasks table")}>
                <table className="w-max min-w-full table-auto border-collapse text-sm">
                  <thead className="bg-app-panel text-left text-xs text-app-muted">
                    <tr>
                      <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("计划", "Plan")}</th>
                      <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("执行时间", "Run time")}</th>
                      <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("资源", "Resources")}</th>
                      <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("状态", "Status")}</th>
                      <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium" scope="col">{text("最近结果", "Latest result")}</th>
                      <th className="sticky right-0 z-20 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 text-center font-medium shadow-stickyColumn" scope="col">
                        {text("操作", "Actions")}
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
                            {locale === "en-US" ? statusText[item.status].en : statusText[item.status].zh}
                          </span>
                        </td>
                        <td className="max-w-96 px-3 py-2 align-middle text-app-muted">
                          {item.lastError ? <span className="text-app-danger">{item.lastError}</span> : item.lastRunAt ? formatScheduleTime(item.lastRunAt) : "-"}
                        </td>
                        <td className="sticky right-0 z-10 bg-app-surface px-3 py-2 align-middle shadow-stickyColumn">
                          <div className="flex justify-end gap-1">
                            <Button
                              className="h-8 px-2"
                              disabled={isExecuting || item.status === "running"}
                              title={text("立即执行", "Run now")}
                              type="button"
                              variant="ghost"
                              onClick={() => retryItem(item)}
                            >
                              <Play className="h-4 w-4" />
                              {text("执行", "Run")}
                            </Button>
                            <Button
                              aria-label={text(`删除定时任务 ${item.name}`, `Delete scheduled task ${item.name}`)}
                              className="h-8 w-8 px-0 text-app-danger hover:text-app-danger"
                              title={text("删除", "Delete")}
                              type="button"
                              variant="ghost"
                              onClick={() => deleteItem(item)}
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">{text("删除", "Delete")}</span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableRegion>
            </>
        )}
      </Panel>
      <RemoteStoragePicker
        initialPath={pickerInitialPath}
        mode={pickerMode}
        open={storagePickerTarget !== null}
        title={storagePickerTarget === "storage" ? text("选择存储目录", "Select storage directory") : storagePickerTarget === "workDirectory" ? text("选择工作目录", "Select working directory") : text("选择脚本文件", "Select script file")}
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
