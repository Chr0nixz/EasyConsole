import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, CalendarClock, FolderOpen, Pause, Pencil, Play, Plus, SkipForward, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { BatchPreviewDialog } from "../components/batch/BatchPreviewDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { FieldError, FormSection, fieldBorderClass, useFormFieldErrors } from "../components/form-fields";
import { MobileLongText } from "../components/MobileLongText";
import { RemoteStoragePicker } from "../components/storage/RemoteStoragePicker";
import { CreateImpactSummary } from "../components/tasks/CreateImpactSummary";
import { ResourcePresetPicker } from "../components/tasks/ResourcePresetPicker";
import { ResourcePriceFields } from "../components/tasks/ResourcePriceFields";
import { ScriptEnvFields } from "../components/tasks/ScriptEnvFields";
import { ExecutionLedgerPanel } from "../components/scheduled/ExecutionLedgerPanel";
import { WorkspaceAccountBanner } from "../components/scheduled/WorkspaceAccountBanner";
import { Button, Input, Panel, SegmentedControl, Select, StatePill, TableRegion, Textarea, type StateTone } from "../components/ui";
import { imageApi, instanceApi } from "../lib/api";
import { getActiveAccountScope } from "../lib/account-scope";
import { getRuntimeSettings } from "../lib/app-settings";
import { runBatch } from "../lib/batch-runner";
import { queryKeys } from "../lib/query-keys";
import { addHours, formatDateTimeLocalInput, formatTaskDefaultName, localizedText, releaseConditionText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { i18nText } from "../lib/i18n-text";
import { parsePositivePrice } from "../lib/resource-price";
import { normalizeStoragePath } from "../lib/remote-storage";
import { browserRuntime } from "../lib/runtime";
import { useExecutionReviewCount } from "../lib/use-execution-review";
import { formatPayloadResources, formatResourcePresetSummary, parseResourcePresetValues } from "../lib/resource-presets";
import { useResourcePresets } from "../lib/use-resource-presets";
import { applyScheduledReleasePolicy, getScheduledReleaseTime } from "../lib/scheduled-release";
import {
  applyEnvToScriptCommand,
  findScriptEnvVarErrors,
  parseScriptCommandEnv,
  type ScriptEnvVar,
} from "../lib/script-command-env";
import { cn } from "../lib/utils";
import {
  createScheduledTask,
  isMissedScheduleRun,
  isScheduleDue,
  loadScheduledTasks,
  mutateScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  skipMissedScheduleInList,
  sortScheduledTasks,
} from "../lib/scheduled-tasks";
import { executeScheduledTask } from "../lib/schedule-execution";
import { describeRecurrence, previewNextRuns, RecurrenceValidationError, validateRecurrence } from "../lib/task-recurrence";
import { maybeAllocateUniqueCreateTaskNames } from "../lib/task-name-unique";
import { invalidateTaskQueries } from "../lib/task-snapshot-query";
import type { CreateTaskPayload, ImageItem, ScheduledTask, ScheduledTaskStatus, TaskRecurrence, TaskRecurrenceType } from "../lib/types";
import { useAuth } from "../lib/use-auth";
import { useConfirmAction } from "../lib/use-confirm-action";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

const DEFAULT_PRICE = "1";
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
  needs_review: { zh: "待重新确认", en: "Needs Review" },
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

function statusTone(status: ScheduledTaskStatus): StateTone {
  if (status === "done") return "success";
  if (status === "failed") return "danger";
  if (status === "needs_review") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

function buildFormRecurrence(type: TaskRecurrenceType, intervalMinutes: string, cron: string, weekdays: number[]): TaskRecurrence | undefined {
  if (type === "interval") {
    const minutes = Number(intervalMinutes);
    return Number.isFinite(minutes) && minutes > 0 ? { type: "interval", intervalSec: Math.round(minutes * 60) } : undefined;
  }
  if (type === "cron") return cron.trim() ? { type: "cron", cron: cron.trim() } : undefined;
  if (type === "weekly") return { type: "weekly", weekdays: [...weekdays].sort() };
  if (type === "daily") return { type: "daily" };
  return undefined;
}

const PREVIEW_RUN_COUNT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a recurring rule will actually do: the next runs and how many instances a day
 * that adds up to. Every run creates a GPU instance, so the rate matters more than the syntax.
 */
function RecurrencePreview({ scheduleTime, recurrence }: { scheduleTime: string; recurrence: TaskRecurrence | undefined }) {
  const { locale, text } = useI18n();
  const preview = useMemo(() => {
    if (!recurrence) return null;
    const first = new Date(scheduleTime);
    if (Number.isNaN(first.getTime())) return null;
    try {
      validateRecurrence(recurrence);
      const seed = { scheduleTime: first.toISOString(), lastRunAt: first.toISOString(), recurrence } as ScheduledTask;
      const runs = [first, ...previewNextRuns(seed, PREVIEW_RUN_COUNT - 1, first)];
      // Runs inside the first 24 hours, capped so a per-minute cron stays cheap to count.
      const dayRuns = [first, ...previewNextRuns(seed, 300, first)].filter((run) => run.getTime() - first.getTime() < DAY_MS).length;
      return { runs, dayRuns };
    } catch (error) {
      return { error: error instanceof Error ? error.message : text("重复规则无效", "Invalid recurrence rule") };
    }
  }, [recurrence, scheduleTime, text]);

  if (!preview) return null;
  const formatRun = (date: Date) => date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="text-xs md:col-span-3" role="status">
      {"error" in preview ? (
        <span className="text-app-danger">{preview.error}</span>
      ) : (
        <span className="text-app-muted">
          {text("接下来：", "Next runs: ")}
          <span className="app-numeric text-app-text">{preview.runs.map(formatRun).join(" · ")}</span>
          {text(
            ` · 首日约 ${preview.dayRuns >= 300 ? "300+" : preview.dayRuns} 次，每次创建 1 个实例`,
            ` · about ${preview.dayRuns >= 300 ? "300+" : preview.dayRuns} in the first day, each creating one instance`,
          )}
        </span>
      )}
    </div>
  );
}

function formatScheduleTime(value: string) {
  return toDateTimeLocalInput(value).replace("T", " ") || value;
}

function toDateTimeLocalInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? "" : formatDateTimeLocalInput(date).slice(0, 16);
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
  // Every manual run creates billable instances, so it opens the same impact preview as a
  // batch create before anything is submitted. `force` runs a plan that is not due yet.
  const [runPreview, setRunPreview] = useState<{ targets: ScheduledTask[]; force: boolean } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The list leads; the 14-field form opens on demand (new plan, edit, or the empty state).
  const [formOpen, setFormOpen] = useState(false);
  // `?view=ledger` (from review toasts, the nav badge, the dashboard) opens the ledger directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const view: "plans" | "ledger" = searchParams.get("view") === "ledger" ? "ledger" : "plans";
  const setView = (next: "plans" | "ledger") => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "ledger") params.set("view", "ledger");
      else params.delete("view");
      return params;
    }, { replace: true });
  };
  const executionReviewCount = useExecutionReviewCount();
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const { touchedFields, markTouched, touchAll, resetTouched } = useFormFieldErrors();
  const [storagePickerTarget, setStoragePickerTarget] = useState<StoragePickerTarget | null>(null);
  const [name, setName] = useState(formatTaskDefaultName());
  const [description, setDescription] = useState("");
  const [scheduleTime, setScheduleTime] = useState(formatDateTimeLocalInput(addHours(new Date(), 1)).slice(0, 16));
  const [imageId, setImageId] = useState("");
  const [price, setPrice] = useState("");
  const [cpu, setCpu] = useState(DEFAULT_CPU);
  const [gpu, setGpu] = useState(DEFAULT_GPU);
  const [memory, setMemory] = useState(DEFAULT_MEMORY);
  // Same local presets as the create dialog and templates, so one saved shape works everywhere.
  const { presets: resourcePresets, savePreset, deletePreset } = useResourcePresets(browserRuntime.storage, formOpen);
  const currentResourcePresetValues = parseResourcePresetValues(cpu, gpu, memory);
  const resourcePresetSummary = currentResourcePresetValues ? formatResourcePresetSummary(currentResourcePresetValues) : undefined;
  const [releaseCondition, setReleaseCondition] = useState("1");
  const [storagePath, setStoragePath] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [workDirectory, setWorkDirectory] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [scriptEnv, setScriptEnv] = useState<ScriptEnvVar[]>([]);
  const [recurrenceType, setRecurrenceType] = useState<TaskRecurrenceType>("once");
  // Entered in minutes (stored as seconds): nobody schedules GPU jobs by the second.
  const [recurrenceIntervalMin, setRecurrenceIntervalMin] = useState("60");
  const [recurrenceCron, setRecurrenceCron] = useState("");
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<number[]>([1]);
  const releaseTime = useMemo(() => getScheduledReleaseTime(scheduleTime), [scheduleTime]);

  /**
   * Jump from the workspace banner to a task row without changing execution
   * state: scroll the visible (desktop row or mobile card) element into view
   * and mark it with the neutral row-hover fill for a moment.
   */
  const focusScheduledTask = useCallback((id: string) => {
    const row = document.getElementById(`scheduled-task-row-${id}`);
    const card = document.getElementById(`scheduled-task-card-${id}`);
    const target = [row, card].find((el) => el && el.offsetParent !== null) ?? row ?? card;
    target?.scrollIntoView({ block: "center" });
    setFocusedTaskId(id);
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => setFocusedTaskId(null), 2400);
  }, []);

  useEffect(
    () => () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    },
    [],
  );

  const images = useQuery({
    queryKey: queryKeys.images.list(),
    queryFn: ({ signal }) => imageApi.list({ page: 1, page_size: 100 }, { signal }),
  });
  const systemImages = useQuery({
    queryKey: queryKeys.images.system(),
    queryFn: ({ signal }) => imageApi.system({}, { signal }),
  });
  const imageOptions = useMemo(() => [...(images.data?.items ?? []), ...(systemImages.data?.items ?? [])], [images.data, systemImages.data]);

  const fieldErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = text("任务名称不能为空", "Task name is required");
    if (!scheduleTime) errors.scheduleTime = text("请选择计划执行时间", "Select a scheduled execution time");
    if (!imageId) errors.image = text("请选择镜像", "Select an image");
    if (parsePositivePrice(price) === null) errors.price = text("价格必须大于 0", "Price must be greater than 0");
    if (parsePositiveNumber(cpu) === null) errors.cpu = text("CPU 必须大于 0", "CPU must be greater than 0");
    if (parseNonNegativeInteger(gpu) === null) errors.gpu = text("GPU 必须是非负整数", "GPU must be a non-negative integer");
    if (parsePositiveInteger(memory) === null) errors.memory = text("内存必须是正整数", "Memory must be a positive integer");
    const cond = Number(releaseCondition);
    if (cond === 2 && !releaseTime) errors.releaseTime = text("请选择释放时间", "Select a release time");
    if (cond === 3 && !workDirectory.trim()) errors.workDirectory = text("请填写工作目录", "Enter the working directory");
    if (cond === 3 && !scriptPath.trim()) errors.scriptPath = text("请填写脚本路径", "Enter the script path");
    if (cond === 3) {
      const envError = findScriptEnvVarErrors(scriptEnv);
      if (envError) errors.scriptEnv = text(envError.messageZh, envError.messageEn);
    }
    return errors;
  }, [cpu, gpu, imageId, memory, name, price, releaseCondition, releaseTime, scheduleTime, scriptEnv, scriptPath, text, workDirectory]);

  const reload = useCallback(
    () =>
      loadScheduledTasks(browserRuntime.storage)
        .then((loaded) => {
          setItems(sortScheduledTasks(loaded));
          setLoadError(null);
        })
        .catch((error) =>
          setLoadError(error instanceof Error ? error : new Error(i18nText("定时任务读取失败", "Failed to read scheduled tasks"))),
        )
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void reload();
    // The background runner writes the same storage key, so re-read on focus
    // instead of holding the mount-time snapshot for the whole session.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  useEffect(() => {
    if (!imageId && imageOptions[0]) setImageId(String(imageOptions[0].id));
  }, [imageId, imageOptions]);

  useEffect(() => {
    if (!storagePath) setStoragePath(`/${username}`);
    if (!mountPath) setMountPath(`/home/ubuntu/${username}`);
  }, [mountPath, storagePath, username]);

  /**
   * All writes go through an atomic load→modify→save so a concurrent background
   * runner update (lease fields, lastRemoteTaskId) is never clobbered by a stale
   * page snapshot. Losing lastRemoteTaskId would defeat the idempotency check and
   * let the same schedule create a second billable instance.
   */
  async function persistWith(updater: (current: ScheduledTask[]) => ScheduledTask[]) {
    const merged = await mutateScheduledTasks(browserRuntime.storage, (current) => sortScheduledTasks(updater(current)));
    setItems(merged);
    return merged;
  }

  async function persistOne(id: string, updater: (latest: ScheduledTask) => ScheduledTask) {
    await persistWith((current) => {
      if (!current.some((item) => item.id === id)) throw new Error(text("定时任务不存在", "Scheduled task not found"));
      return current.map((latest) => latest.id === id ? updater(latest) : latest);
    });
  }

  async function persistAdd(task: ScheduledTask) {
    await persistWith((current) => [task, ...current]);
  }

  async function persistRemove(id: string) {
    await persistWith((current) => current.filter((item) => item.id !== id));
  }

  function handleReleaseConditionChange(value: string) {
    setReleaseCondition(value);
  }

  function handleGpuChange(value: string) {
    setGpu(value);
  }

  function resetForm() {
    setEditingId(null);
    setFormOpen(false);
    setName(formatTaskDefaultName());
    setDescription("");
    setScheduleTime(formatDateTimeLocalInput(addHours(new Date(), 1)).slice(0, 16));
    setPrice("");
    setCpu(DEFAULT_CPU);
    setGpu(DEFAULT_GPU);
    setMemory(DEFAULT_MEMORY);
    setReleaseCondition("1");
    setStoragePath(`/${username}`);
    setMountPath(`/home/ubuntu/${username}`);
    setWorkDirectory("");
    setScriptPath("");
    setScriptEnv([]);
    setRecurrenceType("once");
    setRecurrenceIntervalMin("60");
    setRecurrenceCron("");
    setRecurrenceWeekdays([1]);
    setFormError(null);
    setStoragePickerTarget(null);
    resetTouched();
    if (imageOptions[0]) setImageId(String(imageOptions[0].id));
  }

  function beginEdit(item: ScheduledTask) {
    const payload = item.payload;
    setEditingId(item.id);
    setFormOpen(true);
    // The form sits above the list; bring it into view when editing from further down.
    window.requestAnimationFrame(() => document.getElementById("scheduled-task-form")?.scrollIntoView({ block: "start" }));
    setName(item.name);
    setDescription(item.description ?? "");
    setScheduleTime(toDateTimeLocalInput(item.scheduleTime));
    setImageId(String(payload.img ?? ""));
    setPrice(String(payload.price ?? DEFAULT_PRICE));
    setCpu(String(payload.cpu ?? DEFAULT_CPU));
    setGpu(String(payload.gpu ?? DEFAULT_GPU));
    setMemory(String(payload.memory ?? DEFAULT_MEMORY));
    setReleaseCondition(String(payload.releace_conditions ?? "1"));
    setStoragePath(String(payload.storage_path ?? `/${username}`));
    setMountPath(String(payload.mount_path ?? `/home/ubuntu/${username}`));
    const parsedScript = parseScriptCommandEnv(String(payload.script_path ?? ""));
    setWorkDirectory(String(payload.work_directory ?? ""));
    setScriptPath(parsedScript.command);
    setScriptEnv(parsedScript.env);
    const recurrence = item.recurrence;
    setRecurrenceType(recurrence?.type ?? "once");
    setRecurrenceIntervalMin(String(Math.max(1, Math.round((recurrence?.intervalSec ?? 3600) / 60))));
    setRecurrenceCron(recurrence?.cron ?? "");
    setRecurrenceWeekdays(recurrence?.weekdays?.length ? [...recurrence.weekdays] : [1]);
    setFormError(null);
    setStoragePickerTarget(null);
    resetTouched();
  }

  function buildPayload(): CreateTaskPayload | null {
    touchAll(["name", "scheduleTime", "image", "price", "cpu", "gpu", "memory", "releaseTime", "workDirectory", "scriptPath", "scriptEnv"]);
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
    const priceValue = parsePositivePrice(price);
    const cpuValue = parsePositiveNumber(cpu);
    const gpuValue = parseNonNegativeInteger(gpu);
    const memoryValue = parsePositiveInteger(memory);
    if (priceValue === null) {
      setFormError(text("价格必须大于 0", "Price must be greater than 0"));
      return null;
    }
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
    if (releaceConditions === 3) {
      const envError = findScriptEnvVarErrors(scriptEnv);
      if (envError) {
        setFormError(text(envError.messageZh, envError.messageEn));
        return null;
      }
    }

    return applyScheduledReleasePolicy({
      price: priceValue,
      name: taskName,
      cpu: cpuValue,
      gpu: gpuValue > 0 ? gpuValue : undefined,
      memory: memoryValue,
      img: normalizeId(imageId),
      storage_path: normalizeStoragePath(storagePath.trim() || `/${username}`),
      mount_path: mountPath.trim() || `/home/ubuntu/${username}`,
      releace_conditions: releaceConditions,
      work_directory: releaceConditions === 3 ? workDirectory.trim() : undefined,
      script_path: releaceConditions === 3 ? applyEnvToScriptCommand(scriptPath.trim(), scriptEnv) : undefined,
    }, scheduleTime);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      const payload = buildPayload();
      if (!payload) return null;
      if (recurrenceType === "cron" && !recurrenceCron.trim()) {
        setFormError(text("请填写 Cron 表达式", "Enter a cron expression"));
        return null;
      }
      const recurrence = buildFormRecurrence(recurrenceType, recurrenceIntervalMin, recurrenceCron, recurrenceWeekdays);

      try {
        validateRecurrence(recurrence);
      } catch (error) {
        const message =
          error instanceof RecurrenceValidationError
            ? error.message
            : text("重复规则无效", "Invalid recurrence rule");
        setFormError(message);
        return null;
      }

      if (editingId) {
        const existing = items.find((item) => item.id === editingId);
        if (!existing) throw new Error(text("定时任务不存在", "Scheduled task not found"));
        const nextStatus: ScheduledTaskStatus =
          existing.status === "done" || existing.status === "failed" ? "pending" : existing.status === "running" ? "pending" : existing.status;
        const updated: ScheduledTask = {
          ...existing,
          name: payload.name,
          description: description.trim() || undefined,
          scheduleTime,
          payload,
          recurrence,
          status: nextStatus,
          lastError: nextStatus === "pending" ? undefined : existing.lastError,
          updatedAt: new Date().toISOString(),
        };
        await persistOne(updated.id, (latest) => {
          if (latest.status === "running" || latest.status !== existing.status || latest.updatedAt !== existing.updatedAt) {
            throw new Error(text("计划已在其他窗口更新，请刷新后重新编辑。", "The plan changed in another window. Refresh before editing again."));
          }
          return { ...latest, ...updated };
        });
        return updated;
      }

      const scheduled = createScheduledTask({
        name: payload.name,
        description: description.trim() || undefined,
        scheduleTime,
        payload,
        recurrence,
      });
      await persistAdd(scheduled);
      return scheduled;
    },
    onSuccess: (scheduled) => {
      if (!scheduled) return;
      const title = editingId ? text("定时任务已更新", "Scheduled task updated") : text("定时任务已保存", "Scheduled task saved");
      toast.success(title, text(`${scheduled.name}，${formatScheduleTime(scheduled.scheduleTime)} 执行`, `${scheduled.name}, runs at ${formatScheduleTime(scheduled.scheduleTime)}`));
      void runLogger.log({
        source: "scheduled-task",
        level: "info",
        action: editingId ? "scheduledTask.update" : "scheduledTask.save",
        result: "success",
        title,
        targetName: scheduled.name,
        targetId: scheduled.id,
        metadata: { scheduleTime: scheduled.scheduleTime },
      });
      resetForm();
    },
    onError: (error) => {
      toast.error(
        editingId ? text("定时任务更新失败", "Failed to update scheduled task") : text("定时任务保存失败", "Failed to save scheduled task"),
        error instanceof Error ? error.message : text("请稍后重试", "Try again later"),
      );
      void runLogger.log({
        source: "scheduled-task",
        level: "error",
        action: editingId ? "scheduledTask.update" : "scheduledTask.save",
        result: "failure",
        title: editingId ? text("定时任务更新失败", "Failed to update scheduled task") : text("定时任务保存失败", "Failed to save scheduled task"),
        targetName: name.trim(),
        error: errorMessage(error, text("定时任务保存失败", "Failed to save scheduled task")),
      });
    },
  });

  async function executeTargets(targets: ScheduledTask[], force = true) {
    if (targets.length === 0 || isExecuting) return;
    setIsExecuting(true);
    try {
      // The original loop ran targets back-to-back, so no inter-item delay is added.
      await runBatch(targets, {
        delayMs: 0,
        run: async (target) => {
          try {
            const result = await executeScheduledTask(browserRuntime.storage, target.id, {
              createTask: (payload) => instanceApi.createTask(payload),
              preparePayload: async (payload) => {
                const [next] = await maybeAllocateUniqueCreateTaskNames([payload], {
                  enabled: getRuntimeSettings().autoNumberDuplicateTaskNames,
                  checkTaskName: (name) => instanceApi.checkTaskName(name),
                });
                return next!;
              },
              trigger: "manual",
              force,
              getAccountScope: getActiveAccountScope,
            });
            await reload();
            if (result.skipped) {
              if (result.reason === "in-flight") {
                toast.info(text("定时任务正在执行", "Scheduled task is already running"), target.name);
              } else if (result.task.lastError) {
                toast.info(text("定时任务待确认", "Scheduled task needs review"), result.task.lastError);
              }
              return result;
            }
            invalidateTaskQueries(queryClient);
            toast.success(text("定时任务已执行", "Scheduled task executed"), target.name);
            void runLogger.log({
              source: "scheduled-task",
              level: "info",
              action: "scheduledTask.execute",
              result: "success",
              title: text("定时任务已执行", "Scheduled task executed"),
              targetName: target.name,
              targetId: target.id,
              metadata: { remoteTaskId: result.remoteTaskId },
            });
            return result;
          } catch (error) {
            await reload();
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
            // Already toasted and logged; rethrow so runBatch records the item as failed.
            throw error;
          }
        },
      });
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
      run: async () => {
        if (editingId === item.id) resetForm();
        await persistRemove(item.id);
        logPlanChange(item, "scheduledTask.delete", text("定时任务已删除", "Scheduled task deleted"));
      },
    });
  }

  /** Delete, pause and resume change what will run later, so they belong in the audit trail with save and run. */
  function logPlanChange(item: ScheduledTask, action: string, title: string) {
    void runLogger.log({
      source: "scheduled-task",
      level: "info",
      action,
      result: "success",
      title,
      targetName: item.name,
      targetId: item.id,
    });
  }

  function retryItem(item: ScheduledTask) {
    setRunPreview({ targets: [item], force: true });
  }

  function runPreviewMeta(item: ScheduledTask) {
    const repeat = item.recurrence ? describeRecurrence(item.recurrence, locale) : text("单次", "Once");
    return `${formatPayloadResources(item.payload)} · ${repeat}`;
  }

  async function pauseItem(item: ScheduledTask) {
    let changed = false;
    await persistOne(item.id, (latest) => {
      const next = pauseScheduledTask(latest);
      changed = next !== latest;
      return next;
    });
    if (!changed) return;
    toast.success(text("定时任务已暂停", "Scheduled task paused"), item.name);
    logPlanChange(item, "scheduledTask.pause", text("定时任务已暂停", "Scheduled task paused"));
  }

  async function resumeItem(item: ScheduledTask) {
    let changed = false;
    await persistOne(item.id, (latest) => {
      const next = resumeScheduledTask(latest);
      changed = next !== latest;
      return next;
    });
    if (!changed) return;
    toast.success(text("定时任务已恢复", "Scheduled task resumed"), item.name);
    logPlanChange(item, "scheduledTask.resume", text("定时任务已恢复", "Scheduled task resumed"));
  }

  /** Skipping ends a one-shot plan for good, so it asks first; recurring plans just advance. */
  function skipMissedItem(item: ScheduledTask) {
    confirm({
      title: text("跳过错过的执行", "Skip Missed Run"),
      description: text(
        `将跳过 ${item.name} 错过的这次执行（原定 ${formatScheduleTime(item.scheduleTime)}）。单次计划会标记为已完成，重复计划从下一次继续。`,
        `Skip the missed run of ${item.name} (scheduled ${formatScheduleTime(item.scheduleTime)}). One-shot plans are marked done; recurring plans continue with the next occurrence.`,
      ),
      confirmLabel: text("跳过", "Skip"),
      run: async () => {
        // The re-check inside the storage lock discards the skip when another
        // window executed or rescheduled the row since this page loaded it —
        // overwriting that would lose lastRemoteTaskId and the idempotency key.
        await persistWith((current) =>
          skipMissedScheduleInList(current, item.id, new Date(), missedGraceMs).items,
        );
        logPlanChange(item, "scheduledTask.skipMissed", text("已跳过错过的执行", "Missed run skipped"));
      },
    });
  }

  function renderItemActions(item: ScheduledTask) {
    return (
      <>
        <Button
          className="h-8 px-2"
          disabled={item.status === "running"}
          title={text("编辑", "Edit")}
          type="button"
          variant="ghost"
          onClick={() => beginEdit(item)}
        >
          <Pencil className="h-4 w-4" />
          {text("编辑", "Edit")}
        </Button>
        {item.status === "pending" ? (
          <Button
            className="h-8 px-2"
            title={text("暂停", "Pause")}
            type="button"
            variant="ghost"
            onClick={() => void pauseItem(item)}
          >
            <Pause className="h-4 w-4" />
            {text("暂停", "Pause")}
          </Button>
        ) : null}
        {item.status === "paused" || item.status === "failed" || item.status === "needs_review" ? (
          <Button
            className="h-8 px-2"
            title={text("恢复", "Resume")}
            type="button"
            variant="ghost"
            onClick={() => void resumeItem(item)}
          >
            <Play className="h-4 w-4" />
            {text("恢复", "Resume")}
          </Button>
        ) : null}
        <Button
          className="h-8 px-2"
          disabled={isExecuting || item.status === "running"}
          title={text("立即执行", "Run now")}
          type="button"
          variant="ghost"
          onClick={() => retryItem(item)}
        >
          <Zap className="h-4 w-4" />
          {text("执行", "Run")}
        </Button>
        {isMissedRow(item) ? (
          <Button
            className="h-8 px-2"
            title={text("跳过这次错过的执行时间", "Skip this missed run")}
            type="button"
            variant="ghost"
            onClick={() => skipMissedItem(item)}
          >
            <SkipForward className="h-4 w-4" />
            {text("跳过本次", "Skip this run")}
          </Button>
        ) : null}
        <Button
          aria-label={text(`删除定时任务 ${item.name}`, `Delete scheduled task ${item.name}`)}
          // Neutral at rest like every row action; danger color only on hover or focus.
          className="h-8 w-8 px-0 hover:bg-app-dangerSoft hover:text-app-danger focus-visible:text-app-danger"
          title={text("删除", "Delete")}
          type="button"
          variant="ghost"
          onClick={() => deleteItem(item)}
        >
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">{text("删除", "Delete")}</span>
        </Button>
      </>
    );
  }

  const dueCount = items.filter((item) => isScheduleDue(item)).length;
  // Missed-run marker/action follow the grace window from settings; re-read per
  // render so a settings save is reflected on the next page focus. The marker
  // refreshes with the list (focus/reload), not on a timer — the background
  // runner remains the authority for what actually runs.
  const missedGraceMs = getRuntimeSettings().missedScheduleGraceMs;
  const isMissedRow = (item: ScheduledTask) =>
    item.status === "pending" && isMissedScheduleRun(item, new Date(), missedGraceMs);
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
        {/* The shell header already says plans run locally; this lead only adds what that means for missed runs. */}
        <div className="min-w-0 max-w-2xl">
          <p className="text-sm leading-6 text-app-muted">{text("客户端关闭或休眠期间错过的计划，恢复后按设置处理：默认等待确认，也可改为自动补跑或跳过（可在设置中调整）。", "Runs missed while the app was closed or asleep follow your settings: ask by default, or catch up / skip automatically (configurable in Settings).")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={dueCount === 0 || isExecuting} variant="secondary" onClick={() => setRunPreview({ targets: items.filter((item) => isScheduleDue(item)), force: false })}>
            <CalendarCheck className="h-4 w-4" />
            {text("执行到期", "Run due")} {dueCount > 0 ? dueCount : ""}
          </Button>
          {formOpen ? null : (
            <Button onClick={() => setFormOpen(true)}>
              <Plus className="h-4 w-4" />
              {text("新建计划", "New plan")}
            </Button>
          )}
        </div>
      </div>

      <WorkspaceAccountBanner tasks={items} onFocusTask={focusScheduledTask} />

      <SegmentedControl
        label={text("定时任务视图", "Scheduled tasks view")}
        options={[
          { value: "plans", label: text("计划列表", "Plans") },
          {
            value: "ledger",
            label: executionReviewCount > 0
              ? text(`执行台账 · ${executionReviewCount} 待核对`, `Execution ledger · ${executionReviewCount} to review`)
              : text("执行台账", "Execution ledger"),
          },
        ]}
        value={view}
        onChange={(next) => setView(next)}
      />

      {view === "plans" ? (
        <>
      {loadError ? <ErrorState error={loadError} action={<Button variant="secondary" onClick={() => window.location.reload()}>{text("重新加载", "Reload")}</Button>} /> : null}
      {images.isError ? <ErrorState error={images.error} /> : null}
      {systemImages.isError ? <ErrorState error={systemImages.error} /> : null}

      {formOpen ? (
      <Panel>
        <form id="scheduled-task-form" className="scroll-mt-16 space-y-4 p-4" onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-app-muted" aria-hidden="true" />
              {editingId ? text("编辑计划", "Edit Plan") : text("新建计划", "New Plan")}
            </div>
            <Button type="button" variant="ghost" onClick={resetForm}>
              <X className="h-4 w-4" />
              {editingId ? text("取消编辑", "Cancel edit") : text("收起", "Close")}
            </Button>
          </div>
          <FormSection title={text("基础", "Basic")}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("任务名称", "Task name")}</span>
                <Input className={cn("w-full", fieldBorderClass(touchedFields.has("name") && Boolean(fieldErrors.name)))} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => markTouched("name")} required />
                <FieldError message={touchedFields.has("name") ? fieldErrors.name : undefined} />
              </label>
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
          </FormSection>
          <FormSection divided title={text("计划", "Schedule")}>
            <div className="grid gap-4 md:grid-cols-3">
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
              {recurrenceType === "weekly" && (
                <div className="block text-sm md:col-span-3">
                  <span className="mb-1 block text-app-muted">{text("重复星期", "Weekdays")}</span>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        [0, text("日", "Sun")],
                        [1, text("一", "Mon")],
                        [2, text("二", "Tue")],
                        [3, text("三", "Wed")],
                        [4, text("四", "Thu")],
                        [5, text("五", "Fri")],
                        [6, text("六", "Sat")],
                      ] as const
                    ).map(([day, label]) => {
                      const checked = recurrenceWeekdays.includes(day);
                      return (
                        <label key={day} className="inline-flex items-center gap-1.5 rounded-md border border-app-border bg-app-panel px-2.5 py-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setRecurrenceWeekdays((current) =>
                                checked ? current.filter((value) => value !== day) : [...current, day].sort(),
                              );
                            }}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {recurrenceType === "interval" && (
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{text("间隔（分钟）", "Interval (minutes)")}</span>
                  <Input className="w-full" type="number" min="1" step="1" value={recurrenceIntervalMin} onChange={(event) => setRecurrenceIntervalMin(event.target.value)} />
                </label>
              )}
              {recurrenceType === "cron" && (
                <label className="block text-sm md:col-span-2">
                  <span className="mb-1 block text-app-muted">{text("Cron 表达式", "Cron expression")}</span>
                  <Input className="w-full font-mono" placeholder="*/30 * * * *" value={recurrenceCron} onChange={(event) => setRecurrenceCron(event.target.value)} />
                  <span className="mt-1 block text-xs text-app-muted">{text("分 时 日 月 周，支持步长、范围和列表，例如 */30 * * * * 表示每 30 分钟", "minute hour day month weekday; steps, ranges and lists, e.g. */30 * * * * runs every 30 minutes")}</span>
                </label>
              )}
              {recurrenceType !== "once" ? (
                <RecurrencePreview
                  scheduleTime={scheduleTime}
                  recurrence={buildFormRecurrence(recurrenceType, recurrenceIntervalMin, recurrenceCron, recurrenceWeekdays)}
                />
              ) : null}
            </div>
          </FormSection>
          <FormSection divided title={text("资源配置", "Resources")}>
            <ResourcePresetPicker
              activeSummary={resourcePresetSummary}
              defaultName={resourcePresetSummary ?? ""}
              onDelete={(id) => void deletePreset(id)}
              onSaveCurrent={(presetName) => {
                if (currentResourcePresetValues) void savePreset({ ...currentResourcePresetValues, name: presetName });
              }}
              onApply={({ cpu: nextCpu, gpu: nextGpu, memory: nextMemory }) => {
                setCpu(nextCpu);
                handleGpuChange(nextGpu);
                setMemory(nextMemory);
              }}
              presets={resourcePresets}
              saveDisabled={!currentResourcePresetValues}
              saveDisabledReason={text("请先填写有效的 CPU/GPU/内存", "Enter valid CPU/GPU/memory values first")}
            />
            <ResourcePriceFields
              allowDefaultPrice={!editingId && !touchedFields.has("price")}
              price={price}
              resources={{ cpu, gpu, memory }}
              priceError={fieldErrors.price}
              priceTouched={touchedFields.has("price")}
              onPriceBlur={() => markTouched("price")}
              onPriceChange={(next) => { markTouched("price"); setPrice(next); }}
              onDefaultPriceChange={setPrice}
              onApplySpec={({ cpu: nextCpu, gpu: nextGpu, memory: nextMemory }) => {
                setCpu(nextCpu);
                handleGpuChange(nextGpu);
                setMemory(nextMemory);
              }}
            />
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
          </FormSection>
          <FormSection divided title={text("存储", "Storage")}>
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
          </FormSection>
          <FormSection divided title={text("释放策略", "Release")}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("释放条件", "Release condition")}</span>
                <Select className="w-full" value={releaseCondition} onChange={(event) => handleReleaseConditionChange(event.target.value)}>
                  {Object.entries(releaseConditionText).map(([value, label]) => (
                    <option key={value} value={value}>
                      {localizedText(label, locale)}
                    </option>
                  ))}
                </Select>
              </label>
              {releaseCondition === "2" ? (
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{text("释放时间（执行后 24 小时）", "Release time (24 hours after execution)")}</span>
                  <Input className={cn("w-full bg-app-panel text-app-muted", fieldBorderClass(Boolean(fieldErrors.releaseTime)))} type="datetime-local" value={releaseTime} readOnly aria-readonly="true" required />
                  <FieldError message={touchedFields.has("releaseTime") ? fieldErrors.releaseTime : undefined} />
                </label>
              ) : null}
            </div>
            {releaseCondition === "3" ? (
              <div className="space-y-4">
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
                <ScriptEnvFields
                  envVars={scriptEnv}
                  scriptPath={scriptPath}
                  onChange={setScriptEnv}
                  error={touchedFields.has("scriptEnv") ? fieldErrors.scriptEnv : undefined}
                />
              </div>
            ) : null}
          </FormSection>
          {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={resetForm}>
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={saveMutation.isPending}>
              {editingId ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {editingId ? text("保存修改", "Save changes") : text("保存定时任务", "Save scheduled task")}
            </Button>
          </div>
        </form>
      </Panel>
      ) : null}

      {/* With the form open on an empty list, the form is the next step; the empty state would repeat it. */}
      {items.length === 0 && formOpen ? null : (
      <Panel className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            title={text("还没有定时任务", "No scheduled tasks yet")}
            description={text("设置计划时间后，EasyConsole 会在到期时提交实例创建请求。", "After you set a schedule, EasyConsole submits the instance creation request when it is due.")}
            action={formOpen ? undefined : (
              <Button onClick={() => setFormOpen(true)}>
                <Plus className="h-4 w-4" />
                {text("新建计划", "New plan")}
              </Button>
            )}
          />
        ) : (
          <>
              {/* Mobile card view */}
              <div className="divide-y divide-app-border sm:hidden">
                {items.map((item) => (
                  <article key={item.id} id={`scheduled-task-card-${item.id}`} className={`space-y-3 px-3 py-3 ${focusedTaskId === item.id ? "bg-app-panel" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{item.name}</div>
                        <MobileLongText className="mt-0.5 text-xs" tone="muted" value={item.description || "-"} />
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isMissedRow(item) ? <StatePill tone="warning">{text("已错过", "Missed")}</StatePill> : null}
                        <StatePill tone={statusTone(item.status)}>
                          {locale === "en-US" ? statusText[item.status].en : statusText[item.status].zh}
                        </StatePill>
                      </div>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <div>
                        <dt className="text-app-muted">{text("执行时间", "Run time")}</dt>
                        <dd>{formatScheduleTime(item.scheduleTime)}</dd>
                      </div>
                      <div>
                        <dt className="text-app-muted">{text("重复", "Repeat")}</dt>
                        <dd>{item.recurrence ? describeRecurrence(item.recurrence, locale) : text("单次", "Once")}</dd>
                      </div>
                      <div>
                        <dt className="text-app-muted">{text("资源", "Resources")}</dt>
                        <dd>{item.payload.cpu ?? "-"}C / {item.payload.gpu ?? 0}GPU / {item.payload.memory ?? "-"}G</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-app-muted">{text("最近结果", "Latest result")}</dt>
                        <dd>
                          {item.lastError ? <MobileLongText tone="danger" value={item.lastError} /> : item.lastRunAt ? formatScheduleTime(item.lastRunAt) : "-"}
                        </dd>
                      </div>
                      {item.payload.storage_path ? (
                        <div className="col-span-2">
                          <dt className="text-app-muted">{text("存储路径", "Storage path")}</dt>
                          <dd className="mt-0.5"><MobileLongText value={item.payload.storage_path} copyable mono /></dd>
                        </div>
                      ) : null}
                    </dl>
                    <div className="flex flex-wrap gap-1.5">
                      {renderItemActions(item)}
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
                      <tr key={item.id} id={`scheduled-task-row-${item.id}`} className={`border-b border-app-border last:border-0 hover:bg-app-panel/60 ${focusedTaskId === item.id ? "bg-app-panel" : ""}`}>
                        <td className="whitespace-nowrap px-3 py-2 align-middle">
                          <div className="font-medium">{item.name}</div>
                          <div className="mt-0.5 max-w-72 truncate text-xs text-app-muted">{item.description || item.payload.storage_path || "-"}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{formatScheduleTime(item.scheduleTime)}</td>
                        <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">
                          {item.payload.cpu ?? "-"}C / {item.payload.gpu ?? 0}GPU / {item.payload.memory ?? "-"}G
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-middle">
                          <div className="flex items-center gap-1.5">
                            {isMissedRow(item) ? <StatePill tone="warning">{text("已错过", "Missed")}</StatePill> : null}
                            <StatePill tone={statusTone(item.status)}>
                              {locale === "en-US" ? statusText[item.status].en : statusText[item.status].zh}
                            </StatePill>
                          </div>
                        </td>
                        <td className="max-w-96 px-3 py-2 align-middle text-app-muted">
                          {item.lastError ? <span className="text-app-danger">{item.lastError}</span> : item.lastRunAt ? formatScheduleTime(item.lastRunAt) : "-"}
                        </td>
                        <td className="sticky right-0 z-10 bg-app-surface px-3 py-2 align-middle shadow-stickyColumn">
                          <div className="flex flex-wrap justify-end gap-1">
                            {renderItemActions(item)}
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
      )}
        </>
      ) : (
        <ExecutionLedgerPanel />
      )}

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
      {runPreview ? (
        <BatchPreviewDialog
          open
          title={runPreview.force && runPreview.targets.length === 1
            ? text(`确认立即执行：${runPreview.targets[0].name}`, `Run Now: ${runPreview.targets[0].name}`)
            : text("确认执行到期计划", "Run Due Plans")}
          tone="default"
          items={runPreview.targets.map((item) => ({ key: item.id, name: item.name, meta: runPreviewMeta(item) }))}
          account={{ displayName: username }}
          summary={<CreateImpactSummary payloads={runPreview.targets.map((item) => item.payload)} />}
          confirmLabel={text(`创建 ${runPreview.targets.length} 个实例`, `Create ${runPreview.targets.length} instance${runPreview.targets.length === 1 ? "" : "s"}`)}
          onConfirm={() => {
            const { targets, force } = runPreview;
            setRunPreview(null);
            void executeTargets(targets, force);
          }}
          onClose={() => setRunPreview(null)}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}
