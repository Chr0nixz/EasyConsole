import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { ErrorState } from "../DataState";
import { FieldError, FormSection, useFormFieldErrors } from "../form-fields";
import { RemoteStoragePicker } from "../storage/RemoteStoragePicker";
import { ResourcePriceFields } from "./ResourcePriceFields";
import { ScriptEnvFields } from "./ScriptEnvFields";
import { Button, Dialog, Input, Select } from "../ui";
import { imageApi, instanceApi } from "../../lib/api";
import { getRuntimeSettings } from "../../lib/app-settings";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../../lib/batch";
import {
  DEFAULT_CREATE_TASK_UI_PREFS,
  loadCreateTaskUiPrefs,
  saveCreateTaskUiPrefs,
  sectionsForFieldErrors,
  type CreateTaskSectionId,
  type CreateTaskUiPrefs,
} from "../../lib/create-task-ui-prefs";
import { useAuth } from "../../lib/use-auth";
import { useToast } from "../../lib/use-toast";
import {
  addHours,
  formatDateTimeForApi,
  formatDateTimeLocalInput,
  formatExperimentTimedTaskName,
  formatTaskDefaultName,
  localizedText,
  releaseConditionText,
} from "../../lib/format";
import { cn } from "../../lib/utils";
import { useI18n } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { parsePositivePrice } from "../../lib/resource-price";
import { normalizeStoragePath } from "../../lib/remote-storage";
import { browserRuntime } from "../../lib/runtime";
import {
  applyEnvToScriptCommand,
  EXPERIMENT_ID_ENV_KEY,
  findScriptEnvVarErrors,
  getScriptEnvValue,
  normalizeScriptEnvVars,
  parseScriptCommandEnv,
  type ScriptEnvVar,
} from "../../lib/script-command-env";
import { allocateUniqueTaskNames, collectExistingTaskNames, createCombinedTaskNameAvailabilityChecker } from "../../lib/task-name-unique";
import { invalidateTaskQueries, TASK_SNAPSHOT_QUERY_KEY } from "../../lib/task-snapshot-query";
import type { CreateTaskPayload, ImageItem, ListResult, Task } from "../../lib/types";
import { useUnsavedChanges } from "../../lib/use-unsaved-changes";
import { useConfirmAction } from "../../lib/use-confirm-action";
import { UnsavedChangesPrompt } from "../UnsavedChangesPrompt";
import { errorMessage, useRunLogger } from "../../lib/use-run-logger";

const DEFAULT_PRICE = "";
const DEFAULT_CPU = "4";
const DEFAULT_GPU = "0";
const DEFAULT_MEMORY = "16";
const MAX_BATCH_COUNT = 50;
const MOBILE_DEFAULTS_APPLIED_KEY = "easy-console.createTaskUiPrefs.mobileDefaultsApplied";

type StoragePickerTarget = "storage" | "workDirectory" | "scriptPath";

type FormSnapshot = {
  name: string;
  imageId: string;
  price: string;
  cpu: string;
  gpu: string;
  memory: string;
  releaseCondition: string;
  releaseTime: string;
  storagePath: string;
  mountPath: string;
  workDirectory: string;
  scriptPath: string;
  scriptEnvJson: string;
  batchCount: string;
};

function serializeScriptEnv(env: ScriptEnvVar[]) {
  return JSON.stringify(normalizeScriptEnvVars(env));
}

function buildFormSnapshot({
  isEditMode,
  initialTask,
  username,
}: {
  isEditMode: boolean;
  initialTask?: Task | null;
  username: string;
}): FormSnapshot {
  const parsedScript = parseScriptCommandEnv(initialTask?.script_path ?? "");
  return {
    name: isEditMode ? (initialTask?.name ?? "") : formatTaskDefaultName(),
    imageId: String(getTaskImageId(initialTask)),
    price: String(initialTask?.price ?? DEFAULT_PRICE),
    cpu: String(initialTask?.cpu ?? DEFAULT_CPU),
    gpu: String(initialTask?.gpu ?? DEFAULT_GPU),
    memory: String(initialTask?.memory ?? DEFAULT_MEMORY),
    releaseCondition: String(initialTask?.releace_conditions ?? initialTask?.release_condition ?? "1"),
    releaseTime: formatClonedReleaseTime(initialTask?.releace_time),
    storagePath: initialTask?.storage_path || `/${username}`,
    mountPath: initialTask?.mount_path || `/home/ubuntu/${username}`,
    workDirectory: initialTask?.work_directory ?? "",
    scriptPath: parsedScript.command,
    scriptEnvJson: serializeScriptEnv(parsedScript.env),
    batchCount: "1",
  };
}

function isFormDirty(current: FormSnapshot, initial: FormSnapshot | null) {
  if (!initial) return false;
  return (Object.keys(initial) as Array<keyof FormSnapshot>).some((key) => current[key] !== initial[key]);
}

function getImageOptionLabel(image: ImageItem) {
  const name = image.name ?? image.image_name ?? String(image.id);
  return image.tag ? `${name}:${image.tag}` : name;
}

function normalizeId(value: string) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function numericScore(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const digits = String(value).match(/\d+/g)?.join("") ?? "";
  const number = Number(digits);
  return Number.isFinite(number) ? number : 0;
}

function timeScore(value: unknown) {
  if (typeof value !== "string") return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function getImageFreshnessScore(image: ImageItem) {
  return Math.max(numericScore(image.tag), timeScore(image.update_time), timeScore(image.create_time), timeScore(image.created_at), numericScore(image.id));
}

function getLatestImage(images: ImageItem[]) {
  return images.reduce<ImageItem | null>((latest, image) => {
    if (!latest) return image;
    return getImageFreshnessScore(image) > getImageFreshnessScore(latest) ? image : latest;
  }, null);
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
  return formatDateTimeLocalInput(addHours(new Date(), 24 / (gpu && gpu > 0 ? gpu : 1)));
}

function formatClonedReleaseTime(value?: string | null) {
  if (!value) return "";
  return value.replace(" ", "T").slice(0, 19);
}

function getTaskImageId(task?: Task | null) {
  return task?.image_id ?? task?.img ?? "";
}

const CLONE_CREATE_FIELDS = new Set([
  "price",
  "price_mode",
  "price_target",
  "price_type",
  "resource",
  "resource_id",
  "resource_spec_id",
]);

function getCloneCreateFields(task?: Task | null) {
  if (!task) return {};
  return Object.fromEntries(Object.entries(task).filter(([key]) => CLONE_CREATE_FIELDS.has(key)));
}

function formatBatchTaskName(baseName: string, index: number, total: number) {
  if (total === 1) return baseName;
  const width = String(total).length;
  return `${baseName}-${String(index + 1).padStart(width, "0")}`;
}

export function CreateTaskDialog({
  open,
  onClose,
  initialTask,
  mode = "create",
  editTaskId,
}: {
  open: boolean;
  onClose: () => void;
  initialTask?: Task | null;
  mode?: "create" | "edit";
  editTaskId?: string | number;
}) {
  const isEditMode = mode === "edit";
  const auth = useAuth();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const queryClient = useQueryClient();
  const images = useQuery({
    queryKey: queryKeys.images.list(),
    queryFn: ({ signal }) => imageApi.list({ page: 1, page_size: 100 }, { signal }),
    enabled: open,
  });
  const systemImages = useQuery({
    queryKey: queryKeys.images.system(),
    queryFn: ({ signal }) => imageApi.system({}, { signal }),
    enabled: open,
  });
  const [initialSnapshot, setInitialSnapshot] = useState<FormSnapshot | null>(null);
  const [name, setName] = useState("");
  const [imageId, setImageId] = useState("");
  const [price, setPrice] = useState(DEFAULT_PRICE);
  const [cpu, setCpu] = useState(DEFAULT_CPU);
  const [gpu, setGpu] = useState(DEFAULT_GPU);
  const [memory, setMemory] = useState(DEFAULT_MEMORY);
  const [releaseCondition, setReleaseCondition] = useState("1");
  const [releaseTime, setReleaseTime] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [workDirectory, setWorkDirectory] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [scriptEnv, setScriptEnv] = useState<ScriptEnvVar[]>([]);
  const [storagePickerTarget, setStoragePickerTarget] = useState<StoragePickerTarget | null>(null);
  const [batchCount, setBatchCount] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);
  const [resolvingNames, setResolvingNames] = useState(false);
  const [uiPrefs, setUiPrefs] = useState<CreateTaskUiPrefs>(() => ({
    ...DEFAULT_CREATE_TASK_UI_PREFS,
    sections: { ...DEFAULT_CREATE_TASK_UI_PREFS.sections },
  }));
  const { touchedFields, markTouched, touchAll, resetTouched } = useFormFieldErrors();
  const unsavedMessage = text("表单有未保存的更改，确定要关闭吗？", "You have unsaved changes. Discard them and close?");

  const applyDefaultPrice = useCallback((nextPrice: string) => {
    setPrice(nextPrice);
    setInitialSnapshot((snapshot) => snapshot ? { ...snapshot, price: nextPrice } : snapshot);
  }, []);

  function persistUiPrefs(next: CreateTaskUiPrefs) {
    setUiPrefs(next);
    void saveCreateTaskUiPrefs(browserRuntime.storage, next);
  }

  function setSectionOpen(id: CreateTaskSectionId, nextOpen: boolean) {
    persistUiPrefs({
      ...uiPrefs,
      sections: { ...uiPrefs.sections, [id]: nextOpen },
    });
  }

  function openSectionsForErrors(errors: Record<string, string>) {
    const needed = sectionsForFieldErrors(errors);
    if (needed.length === 0) return;
    const sections = { ...uiPrefs.sections };
    let changed = false;
    for (const id of needed) {
      if (!sections[id]) {
        sections[id] = true;
        changed = true;
      }
    }
    const scriptEnvOpen = errors.scriptEnv ? true : uiPrefs.scriptEnvOpen;
    if (errors.scriptEnv && !uiPrefs.scriptEnvOpen) changed = true;
    if (changed) persistUiPrefs({ ...uiPrefs, sections, scriptEnvOpen });
  }

  const currentSnapshot = useMemo<FormSnapshot>(
    () => ({
      name,
      imageId,
      price,
      cpu,
      gpu,
      memory,
      releaseCondition,
      releaseTime,
      storagePath,
      mountPath,
      workDirectory,
      scriptPath,
      scriptEnvJson: serializeScriptEnv(scriptEnv),
      batchCount,
    }),
    [batchCount, cpu, gpu, imageId, memory, mountPath, name, price, releaseCondition, releaseTime, scriptEnv, scriptPath, storagePath, workDirectory],
  );
  const dirty = open && isFormDirty(currentSnapshot, initialSnapshot);
  const navigationBlocker = useUnsavedChanges(dirty, unsavedMessage);
  const { confirm: confirmDiscard, confirmDialog: discardDialog } = useConfirmAction();

  function requestClose() {
    if (!dirty) {
      onClose();
      return;
    }
    confirmDiscard({
      title: text("放弃未保存的更改？", "Discard unsaved changes?"),
      description: unsavedMessage,
      confirmLabel: text("放弃并关闭", "Discard and close"),
      tone: "danger",
      run: onClose,
    });
  }

  const fieldErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    const syncActive = !isEditMode && uiPrefs.syncNameWithExperimentId && Number(releaseCondition) === 3;
    const experimentId = getScriptEnvValue(scriptEnv, EXPERIMENT_ID_ENV_KEY);
    if (syncActive) {
      if (!experimentId) {
        errors.name = text("请填写 EXPERIMENT_ID（实例名称将自动与之同步）", "Enter EXPERIMENT_ID (task name will synchronize with it)");
        errors.scriptEnv = text("请填写 EXPERIMENT_ID", "Enter EXPERIMENT_ID");
      }
    } else if (!name.trim()) {
      errors.name = text("任务名称不能为空", "Task name is required");
    }
    if (!imageId) errors.image = text("请选择镜像", "Select an image");
    if (parsePositivePrice(price) === null) errors.price = text("计费单价必须大于 0", "Hourly rate must be greater than 0");
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
    const count = Number(batchCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_COUNT) {
      errors.batchCount = text(`批量创建数量必须在 1-${MAX_BATCH_COUNT} 之间`, `Batch count must be between 1 and ${MAX_BATCH_COUNT}`);
    }
    return errors;
  }, [batchCount, cpu, gpu, imageId, isEditMode, memory, name, price, releaseCondition, releaseTime, scriptEnv, scriptPath, text, uiPrefs.syncNameWithExperimentId, workDirectory]);

  const imageOptions = useMemo(() => [...(images.data?.items ?? []), ...(systemImages.data?.items ?? [])], [images.data, systemImages.data]);
  const hasSelectedImageOption = imageOptions.some((image) => String(image.id) === imageId);
  const username = auth.user?.username ?? "";

  useEffect(() => {
    if (open) {
      const snapshot = buildFormSnapshot({ isEditMode, initialTask, username });
      setInitialSnapshot(snapshot);
      setName(snapshot.name);
      setImageId(snapshot.imageId);
      setPrice(snapshot.price);
      setCpu(snapshot.cpu);
      setGpu(snapshot.gpu);
      setMemory(snapshot.memory);
      setReleaseCondition(snapshot.releaseCondition);
      setReleaseTime(snapshot.releaseTime);
      setStoragePath(snapshot.storagePath);
      setMountPath(snapshot.mountPath);
      setWorkDirectory(snapshot.workDirectory);
      setScriptPath(snapshot.scriptPath);
      setScriptEnv(JSON.parse(snapshot.scriptEnvJson) as ScriptEnvVar[]);
      setStoragePickerTarget(null);
      setBatchCount(snapshot.batchCount);
      setFormError(null);
      setResolvingNames(false);
      resetTouched();
      void loadCreateTaskUiPrefs(browserRuntime.storage).then((prefs) => {
        void browserRuntime.storage.get(MOBILE_DEFAULTS_APPLIED_KEY).then((applied) => {
          const shouldApplyMobileDefaults = browserRuntime.isMobile && !isEditMode && applied !== "1";
          const nextPrefs = shouldApplyMobileDefaults
            ? {
                ...prefs,
                sections: { ...prefs.sections, basic: true, resources: true, storage: false, release: false },
              }
            : prefs;
          setUiPrefs(nextPrefs);
          if (shouldApplyMobileDefaults) void browserRuntime.storage.set(MOBILE_DEFAULTS_APPLIED_KEY, "1");
          if (!isEditMode && nextPrefs.syncNameWithExperimentId && snapshot.releaseCondition === "3") {
            const id = getScriptEnvValue(JSON.parse(snapshot.scriptEnvJson) as ScriptEnvVar[], EXPERIMENT_ID_ENV_KEY);
            if (id) {
              setName((current) => current === snapshot.name ? id : current);
              setInitialSnapshot((current) => current ? { ...current, name: id } : current);
            }
          }
        });
      });
    } else {
      setInitialSnapshot(null);
    }
  }, [initialTask, isEditMode, open, resetTouched, username]);

  useEffect(() => {
    if (!open || !initialSnapshot || imageId || imageOptions.length === 0 || touchedFields.has("image")) return;
    const latest = getLatestImage(imageOptions);
    if (latest) {
      const nextImageId = String(latest.id);
      setImageId(nextImageId);
      setInitialSnapshot((snapshot) => snapshot ? { ...snapshot, imageId: nextImageId } : snapshot);
    }
  }, [imageId, imageOptions, initialSnapshot, open, touchedFields]);

  const syncNameWithExperimentId = !isEditMode && uiPrefs.syncNameWithExperimentId;
  const experimentIdValue = getScriptEnvValue(scriptEnv, EXPERIMENT_ID_ENV_KEY);
  const namePreviewFromExperiment =
    syncNameWithExperimentId && releaseCondition === "3" && experimentIdValue
      ? formatExperimentTimedTaskName(experimentIdValue)
      : "";

  function setSyncNameWithExperimentId(next: boolean) {
    persistUiPrefs({
      ...uiPrefs,
      syncNameWithExperimentId: next,
      scriptEnvOpen: next && releaseCondition === "3" ? true : uiPrefs.scriptEnvOpen,
    });
    if (next && releaseCondition === "3") {
      const id = getScriptEnvValue(scriptEnv, EXPERIMENT_ID_ENV_KEY);
      if (id) setName(id);
    }
  }

  function handleReleaseConditionChange(value: string) {
    setReleaseCondition(value);
    if (value === "2") {
      setReleaseTime(getDefaultReleaseTime(gpu));
    } else {
      setReleaseTime("");
    }
    if (value === "3" && uiPrefs.syncNameWithExperimentId && !isEditMode) {
      const id = getScriptEnvValue(scriptEnv, EXPERIMENT_ID_ENV_KEY);
      if (id) setName(id);
    }
  }

  function handleGpuChange(value: string) {
    setGpu(value);
    if (releaseCondition === "2") {
      setReleaseTime(getDefaultReleaseTime(value));
    }
  }

  function applyResourceSpec({ cpu: specCpu, gpu: specGpu, memory: specMemory }: { cpu: string; gpu: string; memory: string }) {
    setCpu(specCpu);
    handleGpuChange(specGpu);
    setMemory(specMemory);
  }

  function handleScriptEnvChange(next: ScriptEnvVar[]) {
    setScriptEnv(next);
    if (!syncNameWithExperimentId || releaseCondition !== "3") return;
    const nextId = getScriptEnvValue(next, EXPERIMENT_ID_ENV_KEY);
    const prevId = getScriptEnvValue(scriptEnv, EXPERIMENT_ID_ENV_KEY);
    if (nextId !== prevId) setName(nextId);
  }

  const mutation = useMutation({
    mutationFn: async (payloads: CreateTaskPayload[]) => {
      if (isEditMode && editTaskId !== undefined) {
        await instanceApi.updateTask(editTaskId, payloads[0] as Partial<CreateTaskPayload>);
        return;
      }
      await runSequentiallyWithDelay(payloads, (payload) => instanceApi.createTask(payload));
    },
    onSuccess: (_data, payloads) => {
      const firstName = String(payloads[0]?.name ?? "");
      if (isEditMode) {
        toast.success(text("任务已更新", "Task updated"), firstName);
        void runLogger.log({
          source: "task",
          level: "info",
          action: "task.update",
          result: "success",
          title: text("任务已更新", "Task updated"),
          targetName: firstName,
          targetId: editTaskId,
        });
        invalidateTaskQueries(queryClient);
        onClose();
        return;
      }
      const delayText = payloads.length > 1 ? text(`，间隔 ${BATCH_REQUEST_DELAY_MS}ms`, `, ${BATCH_REQUEST_DELAY_MS}ms apart`) : "";
      const description = payloads.length > 1 ? text(`${firstName} 等 ${payloads.length} 个实例${delayText}`, `${firstName} and ${payloads.length - 1} more instances${delayText}`) : firstName;
      const title = initialTask ? text("复制创建已提交", "Clone creation submitted") : text("实例创建已提交", "Instance creation submitted");
      toast.success(title, description);
      void runLogger.log({
        source: "task",
        level: "info",
        action: initialTask ? "task.cloneCreate" : "task.create",
        result: "success",
        title,
        targetName: firstName,
        metadata: { count: payloads.length, names: payloads.map((payload) => payload.name) },
      });
      invalidateTaskQueries(queryClient);
      onClose();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : text("请检查表单或稍后重试", "Check the form or try again later");
      if (isEditMode) {
        setFormError(message);
        void runLogger.log({
          source: "task",
          level: "error",
          action: "task.update",
          result: "failure",
          title: text("任务更新失败", "Task update failed"),
          targetName: name.trim(),
          targetId: editTaskId,
          error: errorMessage(error, text("任务更新失败", "Task update failed")),
        });
        return;
      }
      toast.error(text("实例创建失败", "Instance creation failed"), message);
      void runLogger.log({
        source: "task",
        level: "error",
        action: initialTask ? "task.cloneCreate" : "task.create",
        result: "failure",
        title: text("实例创建失败", "Instance creation failed"),
        targetName: name.trim(),
        error: errorMessage(error, text("实例创建失败", "Instance creation failed")),
      });
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    touchAll(["name", "image", "price", "cpu", "gpu", "memory", "batchCount", "releaseTime", "workDirectory", "scriptPath", "scriptEnv"]);
    const syncActive = !isEditMode && uiPrefs.syncNameWithExperimentId && Number(releaseCondition) === 3;
    const experimentId = getScriptEnvValue(scriptEnv, EXPERIMENT_ID_ENV_KEY);
    if (syncActive && !experimentId) {
      openSectionsForErrors({ name: "required", scriptEnv: "required" });
      setFormError(text("请填写 EXPERIMENT_ID（实例名称将自动与之同步）", "Enter EXPERIMENT_ID (task name will synchronize with it)"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const taskName = syncActive ? experimentId : name.trim();
    if (!taskName) {
      openSectionsForErrors({ name: "required" });
      setFormError(text("任务名称不能为空", "Task name is required"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    if (!imageId) {
      openSectionsForErrors({ image: "required" });
      setFormError(text("请选择镜像", "Select an image"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const priceValue = parsePositivePrice(price);
    if (priceValue === null) {
      openSectionsForErrors({ price: "required" });
      setFormError(text("计费单价必须大于 0", "Hourly rate must be greater than 0"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const cpuValue = parsePositiveNumber(cpu);
    if (cpuValue === null) {
      openSectionsForErrors({ cpu: "required" });
      setFormError(text("CPU 必须大于 0", "CPU must be greater than 0"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const gpuValue = parseNonNegativeInteger(gpu);
    if (gpuValue === null) {
      openSectionsForErrors({ gpu: "required" });
      setFormError(text("GPU 必须是非负整数", "GPU must be a non-negative integer"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const memoryValue = parsePositiveInteger(memory);
    if (memoryValue === null) {
      openSectionsForErrors({ memory: "required" });
      setFormError(text("内存必须是正整数", "Memory must be a positive integer"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const releaceConditions = Number(releaseCondition);
    if (releaceConditions === 2 && !releaseTime) {
      openSectionsForErrors({ releaseTime: "required" });
      setFormError(text("请选择释放时间", "Select a release time"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    if (releaceConditions === 3 && (!workDirectory.trim() || !scriptPath.trim())) {
      openSectionsForErrors({ workDirectory: "required", scriptPath: "required" });
      setFormError(text("请填写工作目录和脚本路径", "Enter the working directory and script path"));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    if (releaceConditions === 3) {
      const envError = findScriptEnvVarErrors(scriptEnv);
      if (envError) {
        openSectionsForErrors({ scriptEnv: "invalid" });
        setFormError(text(envError.messageZh, envError.messageEn));
        window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
        return;
      }
    }

    const selectedStoragePath = normalizeStoragePath(storagePath.trim() || `/${username}`);
    const selectedMountPath = mountPath.trim() || `/home/ubuntu/${username}`;

    const sharedPayload = {
      ...(isEditMode ? {} : getCloneCreateFields(initialTask)),
      price: priceValue,
      cpu: cpuValue,
      gpu: gpuValue > 0 ? gpuValue : undefined,
      memory: memoryValue,
      img: imageId ? normalizeId(imageId) : undefined,
      storage_path: selectedStoragePath,
      mount_path: selectedMountPath,
      releace_conditions: releaceConditions,
      releace_time: releaceConditions === 2 ? formatDateTimeForApi(releaseTime) : undefined,
      work_directory: releaceConditions === 3 ? workDirectory.trim() : undefined,
      script_path:
        releaceConditions === 3 ? applyEnvToScriptCommand(scriptPath.trim(), scriptEnv) : undefined,
    };

    if (isEditMode) {
      mutation.mutate([{ ...sharedPayload, name: taskName } as CreateTaskPayload]);
      return;
    }

    const count = Number(batchCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_COUNT) {
      setFormError(text(`批量数量必须在 1-${MAX_BATCH_COUNT} 之间`, `Batch count must be between 1 and ${MAX_BATCH_COUNT}`));
      return;
    }

    // Sync mode: name = EXPERIMENT_ID + timestamp; EXPERIMENT_ID itself stays unnumbered.
    const createBaseName = syncActive ? formatExperimentTimedTaskName(taskName) : taskName;
    const baseNames = Array.from({ length: count }, (_, index) => formatBatchTaskName(createBaseName, index, count));
    let resolvedNames = baseNames;
    if (getRuntimeSettings().autoNumberDuplicateTaskNames) {
      setResolvingNames(true);
      try {
        // Prefer a few checkTaskName calls over paging the entire task list.
        // Seed only from already-cached snapshot data (no extra network).
        const cachedSnapshot = queryClient.getQueryData(TASK_SNAPSHOT_QUERY_KEY) as ListResult<Task> | undefined;
        resolvedNames = await allocateUniqueTaskNames(
          baseNames,
          createCombinedTaskNameAvailabilityChecker({
            existingNames: cachedSnapshot?.items ? collectExistingTaskNames(cachedSnapshot.items) : [],
            checkTaskName: (candidate) => instanceApi.checkTaskName(candidate),
          }),
        );
      } catch (error) {
        setFormError(error instanceof Error ? error.message : text("无法分配可用实例名称", "Unable to allocate an available instance name"));
        return;
      } finally {
        setResolvingNames(false);
      }
    }

    mutation.mutate(
      resolvedNames.map((resolvedName) => ({
        ...sharedPayload,
        name: resolvedName,
      })),
    );
  }

  const pickerMode = storagePickerTarget === "scriptPath" ? "file" : "directory";
  const describedByWorkDirectory = [
    "create-task-work-directory-hint",
    touchedFields.has("workDirectory") && fieldErrors.workDirectory ? "create-task-work-directory-error" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const describedByScriptPath = [
    "create-task-script-path-hint",
    touchedFields.has("scriptPath") && fieldErrors.scriptPath ? "create-task-script-path-error" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const pickerInitialPath =
    storagePickerTarget === "scriptPath"
      ? workDirectory || storagePath || "/"
      : storagePickerTarget === "workDirectory"
        ? workDirectory || storagePath || "/"
        : storagePath || "/";
  const pickerTitle =
    storagePickerTarget === "storage" ? text("选择存储目录", "Select storage directory") : storagePickerTarget === "workDirectory" ? text("选择工作目录", "Select working directory") : text("选择脚本文件", "Select script file");
  const selectedImage = imageOptions.find((image) => String(image.id) === imageId);
  const imageSummary = selectedImage
    ? getImageOptionLabel(selectedImage)
    : imageId ? text(`原实例镜像 #${imageId}`, `Original instance image #${imageId}`) : text("未选择镜像", "No image selected");
  const priceValue = parsePositivePrice(price);
  // The summary states what the user is committing to: with a batch, the rate is shown as
  // count × per-instance rate = total, so 50 instances never read as one instance's price.
  const instanceCount = isEditMode ? 1 : Number(batchCount);
  const validCount = Number.isInteger(instanceCount) && instanceCount >= 1 ? instanceCount : null;
  const gpuPerInstance = parseNonNegativeInteger(gpu);
  const rateText = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 4 });
  const priceSummary = priceValue === null
    ? text("未设置单价", "Rate not set")
    : validCount !== null && validCount > 1
      ? text(
          `${validCount} × ${rateText(priceValue)} = ${rateText(validCount * priceValue)} 元/小时`,
          `${validCount} × CNY ${rateText(priceValue)} = CNY ${rateText(validCount * priceValue)}/hr`,
        )
      : text(`${rateText(priceValue)} 元/小时`, `CNY ${rateText(priceValue)}/hr`);
  const gpuSummary = validCount !== null && gpuPerInstance !== null && gpuPerInstance > 0
    ? text(`共 ${validCount * gpuPerInstance} GPU`, `${validCount * gpuPerInstance} GPU total`)
    : null;
  const createLabel = validCount !== null && validCount > 1
    ? text(`创建 ${validCount} 个实例`, `Create ${validCount} instances`)
    : text("创建", "Create");
  const releaseSummary = localizedText(releaseConditionText[Number(releaseCondition)], locale) ?? "-";

  return (
    <Dialog
      open={open}
      title={isEditMode ? text("编辑任务", "Edit Task") : initialTask ? text("克隆实例", "Clone Instance") : text("新建任务", "New Task")}
      onClose={requestClose}
      closeOnOverlayClick={false}
      onOverlayClick={requestClose}
      width="max-w-4xl"
      mobileMode="fullscreen"
      contained
    >
      <form className="flex h-full min-h-0 flex-col overflow-hidden" noValidate onSubmit={submit}>
        <div className="app-mobile-form-body min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <FormSection
            title={text("基础", "Basic")}
            collapsible
            open={uiPrefs.sections.basic}
            onOpenChange={(next) => setSectionOpen("basic", next)}
            hint={name.trim() || undefined}
          >
            <div className={cn("grid gap-4", isEditMode ? "grid-cols-1" : "md:grid-cols-2")}>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("任务名称", "Task name")}</span>
                <Input
                  className={cn("w-full", touchedFields.has("name") && fieldErrors.name && "border-app-danger")}
                  aria-invalid={Boolean(touchedFields.has("name") && fieldErrors.name)}
                  value={syncNameWithExperimentId && releaseCondition === "3" ? experimentIdValue : name}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => markTouched("name")}
                  readOnly={syncNameWithExperimentId && releaseCondition === "3"}
                  required={!syncNameWithExperimentId || releaseCondition !== "3"}
                />
                {syncNameWithExperimentId && releaseCondition === "3" ? (
                  <span className="mt-1 block text-xs leading-5 text-app-muted">
                    {namePreviewFromExperiment
                      ? text(`创建时名称：${namePreviewFromExperiment}（EXPERIMENT_ID 不加编号）`, `Created as ${namePreviewFromExperiment} (EXPERIMENT_ID stays unnumbered)`)
                      : text("名称跟随 EXPERIMENT_ID；创建时自动追加时间编号。", "Name follows EXPERIMENT_ID; a timestamp suffix is added on create.")}
                  </span>
                ) : null}
                <FieldError message={touchedFields.has("name") ? fieldErrors.name : undefined} />
              </label>
              {isEditMode ? null : (
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{text("创建数量", "Quantity")}</span>
                  <Input
                    className={cn("w-full", touchedFields.has("batchCount") && fieldErrors.batchCount && "border-app-danger")}
                    aria-invalid={Boolean(touchedFields.has("batchCount") && fieldErrors.batchCount)}
                    type="number"
                    min="1"
                    max={MAX_BATCH_COUNT}
                    step="1"
                    value={batchCount}
                    onChange={(event) => setBatchCount(event.target.value)}
                    onBlur={() => markTouched("batchCount")}
                    required
                  />
                  <FieldError message={touchedFields.has("batchCount") ? fieldErrors.batchCount : undefined} />
                </label>
              )}
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("镜像", "Image")}</span>
              <Select aria-invalid={Boolean(touchedFields.has("image") && fieldErrors.image)} className={cn("w-full", touchedFields.has("image") && fieldErrors.image && "border-app-danger")} value={imageId} onChange={(event) => { markTouched("image"); setImageId(event.target.value); }} onBlur={() => markTouched("image")}>
                <option value="">{text("请选择镜像", "Select an image")}</option>
                {imageId && !hasSelectedImageOption ? <option value={imageId}>{text(`原实例镜像 #${imageId}`, `Original instance image #${imageId}`)}</option> : null}
                {imageOptions.map((image) => (
                  <option key={String(image.id)} value={String(image.id)}>
                    {getImageOptionLabel(image)}
                  </option>
                ))}
              </Select>
              <FieldError message={touchedFields.has("image") ? fieldErrors.image : undefined} />
            </label>
          </FormSection>

          <FormSection
            title={text("资源配置", "Resources")}
            divided
            collapsible
            keepMounted
            open={uiPrefs.sections.resources}
            onOpenChange={(next) => setSectionOpen("resources", next)}
            hint={`${cpu || "-"}C / ${gpu || "0"}GPU / ${memory || "-"}G`}
          >
            <ResourcePriceFields
              onApplySpec={applyResourceSpec}
              onPriceBlur={() => markTouched("price")}
              onPriceChange={(nextPrice) => { markTouched("price"); setPrice(nextPrice); }}
              onDefaultPriceChange={applyDefaultPrice}
              allowDefaultPrice={initialSnapshot?.price === "" && !touchedFields.has("price")}
              originalPrice={initialTask?.price}
              price={price}
              priceError={fieldErrors.price}
              priceTouched={touchedFields.has("price")}
            />
            <div className="grid gap-4 md:grid-cols-3">
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">CPU</span>
                <Input aria-invalid={Boolean(touchedFields.has("cpu") && fieldErrors.cpu)} className={cn("w-full", touchedFields.has("cpu") && fieldErrors.cpu && "border-app-danger")} type="number" min="0.1" step="0.1" value={cpu} onChange={(event) => setCpu(event.target.value)} onBlur={() => markTouched("cpu")} required />
                <FieldError message={touchedFields.has("cpu") ? fieldErrors.cpu : undefined} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">GPU</span>
                <Input aria-invalid={Boolean(touchedFields.has("gpu") && fieldErrors.gpu)} className={cn("w-full", touchedFields.has("gpu") && fieldErrors.gpu && "border-app-danger")} type="number" min="0" step="1" value={gpu} onChange={(event) => handleGpuChange(event.target.value)} onBlur={() => markTouched("gpu")} required />
                <FieldError message={touchedFields.has("gpu") ? fieldErrors.gpu : undefined} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("内存 (GiB)", "Memory (GiB)")}</span>
                <Input aria-invalid={Boolean(touchedFields.has("memory") && fieldErrors.memory)} className={cn("w-full", touchedFields.has("memory") && fieldErrors.memory && "border-app-danger")} type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} onBlur={() => markTouched("memory")} required />
                <FieldError message={touchedFields.has("memory") ? fieldErrors.memory : undefined} />
              </label>
            </div>
          </FormSection>

          <FormSection
            title={text("存储", "Storage")}
            divided
            collapsible
            open={uiPrefs.sections.storage}
            onOpenChange={(next) => setSectionOpen("storage", next)}
            hint={storagePath.trim() || undefined}
          >
            <div className="grid gap-4 text-sm md:grid-cols-2">
              <div>
                <label className="mb-1 block text-app-muted" htmlFor="create-task-storage-path">{text("存储路径", "Storage path")}</label>
                <div className="flex gap-2">
                  <Input
                    id="create-task-storage-path"
                    aria-describedby="create-task-storage-path-hint"
                    className="w-full font-mono text-xs"
                    value={storagePath}
                    onChange={(event) => setStoragePath(event.target.value)}
                  />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("storage")}>
                    <FolderOpen className="h-4 w-4" />
                    {text("选择", "Select")}
                  </Button>
                </div>
                <span className="mt-1 block text-xs leading-5 text-app-muted" id="create-task-storage-path-hint">
                  {text("远端存储目录；清空时默认", "Remote storage directory; defaults to")} /{username}
                </span>
              </div>
              <div>
                <label className="mb-1 block text-app-muted" htmlFor="create-task-mount-path">{text("挂载路径", "Mount path")}</label>
                <Input
                  id="create-task-mount-path"
                  aria-describedby="create-task-mount-path-hint"
                  className="w-full font-mono text-xs"
                  value={mountPath}
                  onChange={(event) => setMountPath(event.target.value)}
                />
                <span className="mt-1 block text-xs leading-5 text-app-muted" id="create-task-mount-path-hint">
                  {text("挂载到实例内的路径；清空时默认", "Mount point inside the instance; defaults to")} /home/ubuntu/{username}
                </span>
              </div>
            </div>
          </FormSection>

          <FormSection
            title={text("释放策略", "Release")}
            divided
            collapsible
            open={uiPrefs.sections.release}
            onOpenChange={(next) => setSectionOpen("release", next)}
            hint={localizedText(releaseConditionText[Number(releaseCondition)], locale)}
          >
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
            </div>
            {releaseCondition === "2" ? (
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("释放时间", "Release time")}</span>
                <Input aria-invalid={Boolean(touchedFields.has("releaseTime") && fieldErrors.releaseTime)} className={cn("w-full", touchedFields.has("releaseTime") && fieldErrors.releaseTime && "border-app-danger")} type="datetime-local" value={releaseTime} onChange={(event) => setReleaseTime(event.target.value)} onBlur={() => markTouched("releaseTime")} required />
                <FieldError message={touchedFields.has("releaseTime") ? fieldErrors.releaseTime : undefined} />
              </label>
            ) : null}
            {releaseCondition === "3" ? (
              <div className="space-y-4">
                <div className="block text-sm">
                  <label className="mb-1 block text-app-muted" htmlFor="create-task-work-directory">{text("工作目录", "Working directory")}</label>
                  <div className="flex gap-2">
                    <Input
                      id="create-task-work-directory"
                      aria-describedby={describedByWorkDirectory}
                      aria-invalid={Boolean(touchedFields.has("workDirectory") && fieldErrors.workDirectory)}
                      className={cn("w-full font-mono text-xs", touchedFields.has("workDirectory") && fieldErrors.workDirectory && "border-app-danger")}
                      value={workDirectory}
                      onChange={(event) => setWorkDirectory(event.target.value)}
                      onBlur={() => markTouched("workDirectory")}
                      required
                    />
                    <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("workDirectory")}>
                      <FolderOpen className="h-4 w-4" />
                      {text("选择", "Select")}
                    </Button>
                  </div>
                  <span className="mt-1 block text-xs leading-5 text-app-muted" id="create-task-work-directory-hint">
                    {text("脚本在远端实例的该目录中执行", "The script runs in this directory on the remote instance")}
                  </span>
                  <FieldError id="create-task-work-directory-error" message={touchedFields.has("workDirectory") ? fieldErrors.workDirectory : undefined} />
                </div>
                <div className="block text-sm">
                  <label className="mb-1 block text-app-muted" htmlFor="create-task-script-path">{text("脚本路径", "Script path")}</label>
                  <div className="flex gap-2">
                    <Input
                      id="create-task-script-path"
                      aria-describedby={describedByScriptPath}
                      aria-invalid={Boolean(touchedFields.has("scriptPath") && fieldErrors.scriptPath)}
                      className={cn("w-full font-mono text-xs", touchedFields.has("scriptPath") && fieldErrors.scriptPath && "border-app-danger")}
                      value={scriptPath}
                      onChange={(event) => setScriptPath(event.target.value)}
                      onBlur={() => markTouched("scriptPath")}
                      required
                    />
                    <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                      <FolderOpen className="h-4 w-4" />
                      {text("选择", "Select")}
                    </Button>
                  </div>
                  <span className="mt-1 block text-xs leading-5 text-app-muted" id="create-task-script-path-hint">
                    {text("脚本执行完成后，实例将按「任务结束释放」自动释放", "When the script finishes, the instance releases automatically (release after task ends)")}
                  </span>
                  <FieldError id="create-task-script-path-error" message={touchedFields.has("scriptPath") ? fieldErrors.scriptPath : undefined} />
                </div>
                <ScriptEnvFields
                  envVars={scriptEnv}
                  scriptPath={scriptPath}
                  onChange={handleScriptEnvChange}
                  error={touchedFields.has("scriptEnv") ? fieldErrors.scriptEnv : undefined}
                  expanded={uiPrefs.scriptEnvOpen}
                  onExpandedChange={(next) => persistUiPrefs({ ...uiPrefs, scriptEnvOpen: next })}
                />
                {isEditMode ? null : (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      className="mt-0.5"
                      type="checkbox"
                      checked={uiPrefs.syncNameWithExperimentId}
                      onChange={(event) => setSyncNameWithExperimentId(event.target.checked)}
                    />
                    <span>
                      <span className="block text-app-text">{text("实例名称与 EXPERIMENT_ID 一致", "Keep instance name equal to EXPERIMENT_ID")}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-app-muted">
                        {text(
                          "创建时在名称后追加时间编号（如 exp_202608091723）；EXPERIMENT_ID 本身不加编号。",
                          "On create, append a timestamp to the name (e.g. exp_202608091723); EXPERIMENT_ID itself is not numbered.",
                        )}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            ) : null}
          </FormSection>

          {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
          {mutation.isError ? <ErrorState error={mutation.error} /> : null}
        </div>
        <div className="app-mobile-form-actions flex shrink-0 flex-col gap-3 border-t border-app-border bg-app-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 text-xs text-app-muted" role="group" aria-label={text("提交摘要", "Submission summary")}>
            <p className="flex flex-wrap gap-x-3 gap-y-1 font-medium text-app-text">
              <span>{text(`${isEditMode ? "1" : batchCount || "-"} 个实例`, `${isEditMode ? "1" : batchCount || "-"} ${isEditMode || Number(batchCount) === 1 ? "instance" : "instances"}`)}</span>
              <span className="app-numeric">{priceSummary}</span>
              {gpuSummary ? <span className="app-numeric">{gpuSummary}</span> : null}
              <span>{releaseSummary}{releaseCondition === "2" && releaseTime ? ` · ${formatDateTimeForApi(releaseTime)}` : ""}</span>
            </p>
            <p className="mt-1 truncate" title={imageSummary}>{text(`镜像：${imageSummary}`, `Image: ${imageSummary}`)}</p>
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button type="button" variant="secondary" onClick={requestClose}>
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={mutation.isPending || resolvingNames}>
              {mutation.isPending || resolvingNames
                ? isEditMode
                  ? text("保存中", "Saving")
                  : resolvingNames
                    ? text("检查名称中", "Checking names")
                    : text("正在创建", "Creating")
                : isEditMode
                  ? text("保存", "Save")
                  : createLabel}
            </Button>
          </div>
        </div>
      </form>
      <RemoteStoragePicker
        initialPath={pickerInitialPath}
        mode={pickerMode}
        open={storagePickerTarget !== null}
        title={pickerTitle}
        onClose={() => setStoragePickerTarget(null)}
        onSelect={(path) => {
          if (storagePickerTarget === "storage") setStoragePath(path);
          if (storagePickerTarget === "workDirectory") setWorkDirectory(path);
          if (storagePickerTarget === "scriptPath") setScriptPath(path);
          setStoragePickerTarget(null);
        }}
      />
      {discardDialog}
      <UnsavedChangesPrompt blocker={navigationBlocker} message={unsavedMessage} />
    </Dialog>
  );
}
