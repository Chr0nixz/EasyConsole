import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { ErrorState } from "../DataState";
import { FieldError, FormSection, useFormFieldErrors } from "../form-fields";
import { RemoteStoragePicker } from "../storage/RemoteStoragePicker";
import { ResourcePriceFields } from "./ResourcePriceFields";
import { Button, Dialog, Input, Select } from "../ui";
import { imageApi, instanceApi } from "../../lib/api";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../../lib/batch";
import { useAuth } from "../../lib/use-auth";
import { useToast } from "../../lib/use-toast";
import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName, releaseConditionText, releaseConditionTextEn } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useI18n } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { parsePositivePrice } from "../../lib/resource-price";
import { normalizeStoragePath } from "../../lib/remote-storage";
import { invalidateTaskQueries } from "../../lib/task-snapshot-query";
import type { CreateTaskPayload, ImageItem, Task } from "../../lib/types";
import { confirmDiscardUnsavedChanges, useUnsavedChanges } from "../../lib/use-unsaved-changes";
import { errorMessage, useRunLogger } from "../../lib/use-run-logger";

const DEFAULT_PRICE = "1";
const DEFAULT_CPU = "4";
const DEFAULT_GPU = "0";
const DEFAULT_MEMORY = "16";
const MAX_BATCH_COUNT = 50;

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
  batchCount: string;
};

function buildFormSnapshot({
  isEditMode,
  initialTask,
  username,
}: {
  isEditMode: boolean;
  initialTask?: Task | null;
  username: string;
}): FormSnapshot {
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
    scriptPath: initialTask?.script_path ?? "",
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
  const [storagePickerTarget, setStoragePickerTarget] = useState<StoragePickerTarget | null>(null);
  const [batchCount, setBatchCount] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);
  const { touchedFields, markTouched, touchAll, resetTouched } = useFormFieldErrors();
  const unsavedMessage = text("表单有未保存的更改，确定要关闭吗？", "You have unsaved changes. Discard them and close?");

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
      batchCount,
    }),
    [batchCount, cpu, gpu, imageId, memory, mountPath, name, price, releaseCondition, releaseTime, scriptPath, storagePath, workDirectory],
  );
  const dirty = open && isFormDirty(currentSnapshot, initialSnapshot);
  useUnsavedChanges(dirty, unsavedMessage);

  function requestClose() {
    if (dirty && !confirmDiscardUnsavedChanges(unsavedMessage)) return;
    onClose();
  }

  const fieldErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = text("任务名称不能为空", "Task name is required");
    if (!imageId) errors.image = text("请选择镜像", "Select an image");
    if (parsePositivePrice(price) === null) errors.price = text("价格必须大于 0", "Price must be greater than 0");
    if (parsePositiveNumber(cpu) === null) errors.cpu = text("CPU 必须大于 0", "CPU must be greater than 0");
    if (parseNonNegativeInteger(gpu) === null) errors.gpu = text("GPU 必须是非负整数", "GPU must be a non-negative integer");
    if (parsePositiveInteger(memory) === null) errors.memory = text("内存必须是正整数", "Memory must be a positive integer");
    const cond = Number(releaseCondition);
    if (cond === 2 && !releaseTime) errors.releaseTime = text("请选择释放时间", "Select a release time");
    if (cond === 3 && !workDirectory.trim()) errors.workDirectory = text("请填写工作目录", "Enter the working directory");
    if (cond === 3 && !scriptPath.trim()) errors.scriptPath = text("请填写脚本路径", "Enter the script path");
    const count = Number(batchCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_COUNT) {
      errors.batchCount = text(`数量必须在 1-${MAX_BATCH_COUNT} 之间`, `Count must be 1-${MAX_BATCH_COUNT}`);
    }
    return errors;
  }, [batchCount, cpu, gpu, imageId, memory, name, price, releaseCondition, releaseTime, scriptPath, text, workDirectory]);

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
      setStoragePickerTarget(null);
      setBatchCount(snapshot.batchCount);
      setFormError(null);
      resetTouched();
    } else {
      setInitialSnapshot(null);
    }
  }, [initialTask, isEditMode, open, resetTouched, username]);

  useEffect(() => {
    if (!open || imageId || imageOptions.length === 0) return;
    const latest = getLatestImage(imageOptions);
    if (latest) setImageId(String(latest.id));
  }, [imageId, imageOptions, open]);

  function handleReleaseConditionChange(value: string) {
    setReleaseCondition(value);
    if (value === "2") {
      setReleaseTime(getDefaultReleaseTime(gpu));
    } else {
      setReleaseTime("");
    }
  }

  function handleGpuChange(value: string) {
    setGpu(value);
    if (releaseCondition === "2") {
      setReleaseTime(getDefaultReleaseTime(value));
    }
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

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    touchAll(["name", "image", "price", "cpu", "gpu", "memory", "batchCount", "releaseTime", "workDirectory", "scriptPath"]);
    const taskName = name.trim();
    if (!taskName) {
      setFormError(text("任务名称不能为空", "Task name is required"));
      return;
    }
    if (!imageId) {
      setFormError(text("请选择镜像", "Select an image"));
      return;
    }
    const priceValue = parsePositivePrice(price);
    if (priceValue === null) {
      setFormError(text("价格必须大于 0", "Price must be greater than 0"));
      return;
    }
    const cpuValue = parsePositiveNumber(cpu);
    if (cpuValue === null) {
      setFormError(text("CPU 必须大于 0", "CPU must be greater than 0"));
      return;
    }
    const gpuValue = parseNonNegativeInteger(gpu);
    if (gpuValue === null) {
      setFormError(text("GPU 必须是非负整数", "GPU must be a non-negative integer"));
      return;
    }
    const memoryValue = parsePositiveInteger(memory);
    if (memoryValue === null) {
      setFormError(text("内存必须是正整数", "Memory must be a positive integer"));
      return;
    }
    const releaceConditions = Number(releaseCondition);
    if (releaceConditions === 2 && !releaseTime) {
      setFormError(text("请选择释放时间", "Select a release time"));
      return;
    }
    if (releaceConditions === 3 && (!workDirectory.trim() || !scriptPath.trim())) {
      setFormError(text("请填写工作目录和脚本路径", "Enter the working directory and script path"));
      return;
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
      script_path: releaceConditions === 3 ? scriptPath.trim() : undefined,
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

    mutation.mutate(
      Array.from({ length: count }, (_, index) => ({
        ...sharedPayload,
        name: formatBatchTaskName(taskName, index, count),
      })),
    );
  }

  const pickerMode = storagePickerTarget === "scriptPath" ? "file" : "directory";
  const pickerInitialPath =
    storagePickerTarget === "scriptPath"
      ? workDirectory || storagePath || "/"
      : storagePickerTarget === "workDirectory"
        ? workDirectory || storagePath || "/"
        : storagePath || "/";
  const pickerTitle =
    storagePickerTarget === "storage" ? text("选择存储目录", "Select storage directory") : storagePickerTarget === "workDirectory" ? text("选择工作目录", "Select working directory") : text("选择脚本文件", "Select script file");

  return (
    <Dialog
      open={open}
      title={isEditMode ? text("编辑任务", "Edit Task") : initialTask ? text("复制实例", "Clone Instance") : text("新建任务", "New Task")}
      onClose={requestClose}
      closeOnOverlayClick={false}
      onOverlayClick={requestClose}
      width="max-w-4xl"
    >
      <form className="p-4" onSubmit={submit}>
        <div className="space-y-5">
          <FormSection title={text("基础", "Basic")}>
            <div className={cn("grid gap-4", isEditMode ? "grid-cols-1" : "md:grid-cols-2")}>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("任务名称", "Task name")}</span>
                <Input className={cn("w-full", touchedFields.has("name") && fieldErrors.name && "border-app-danger")} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => markTouched("name")} required />
                <FieldError message={touchedFields.has("name") ? fieldErrors.name : undefined} />
              </label>
              {isEditMode ? null : (
                <label className="block text-sm">
                  <span className="mb-1 block text-app-muted">{text("创建数量", "Quantity")}</span>
                  <Input
                    className={cn("w-full", touchedFields.has("batchCount") && fieldErrors.batchCount && "border-app-danger")}
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
              <Select className={cn("w-full", touchedFields.has("image") && fieldErrors.image && "border-app-danger")} value={imageId} onChange={(event) => setImageId(event.target.value)} onBlur={() => markTouched("image")}>
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

          <FormSection title={text("资源配置", "Resources")} divided>
            <ResourcePriceFields
              price={price}
              priceError={fieldErrors.price}
              priceTouched={touchedFields.has("price")}
              onPriceBlur={() => markTouched("price")}
              onPriceChange={setPrice}
              onApplySpec={({ cpu: nextCpu, gpu: nextGpu, memory: nextMemory }) => {
                setCpu(nextCpu);
                handleGpuChange(nextGpu);
                setMemory(nextMemory);
              }}
            />
            <div className="grid gap-4 md:grid-cols-3">
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">CPU</span>
                <Input className={cn("w-full", touchedFields.has("cpu") && fieldErrors.cpu && "border-app-danger")} type="number" min="0.1" step="0.1" value={cpu} onChange={(event) => setCpu(event.target.value)} onBlur={() => markTouched("cpu")} required />
                <FieldError message={touchedFields.has("cpu") ? fieldErrors.cpu : undefined} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">GPU</span>
                <Input className={cn("w-full", touchedFields.has("gpu") && fieldErrors.gpu && "border-app-danger")} type="number" min="0" step="1" value={gpu} onChange={(event) => handleGpuChange(event.target.value)} onBlur={() => markTouched("gpu")} required />
                <FieldError message={touchedFields.has("gpu") ? fieldErrors.gpu : undefined} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("内存 (GiB)", "Memory (GiB)")}</span>
                <Input className={cn("w-full", touchedFields.has("memory") && fieldErrors.memory && "border-app-danger")} type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} onBlur={() => markTouched("memory")} required />
                <FieldError message={touchedFields.has("memory") ? fieldErrors.memory : undefined} />
              </label>
            </div>
          </FormSection>

          <FormSection title={text("存储", "Storage")} divided>
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
              <div>
                <span className="mb-1 block text-app-muted">{text("挂载路径", "Mount path")}</span>
                <Input className="w-full font-mono text-xs" value={mountPath} onChange={(event) => setMountPath(event.target.value)} />
              </div>
            </div>
          </FormSection>

          <FormSection title={text("释放策略", "Release")} divided>
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
            </div>
            {releaseCondition === "2" ? (
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("释放时间", "Release time")}</span>
                <Input className={cn("w-full", touchedFields.has("releaseTime") && fieldErrors.releaseTime && "border-app-danger")} type="datetime-local" value={releaseTime} onChange={(event) => setReleaseTime(event.target.value)} onBlur={() => markTouched("releaseTime")} required />
                <FieldError message={touchedFields.has("releaseTime") ? fieldErrors.releaseTime : undefined} />
              </label>
            ) : null}
            {releaseCondition === "3" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="block text-sm">
                  <span className="mb-1 block text-app-muted">{text("工作目录", "Working directory")}</span>
                  <div className="flex gap-2">
                    <Input className={cn("w-full font-mono text-xs", touchedFields.has("workDirectory") && fieldErrors.workDirectory && "border-app-danger")} value={workDirectory} onChange={(event) => setWorkDirectory(event.target.value)} onBlur={() => markTouched("workDirectory")} required />
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
                    <Input className={cn("w-full font-mono text-xs", touchedFields.has("scriptPath") && fieldErrors.scriptPath && "border-app-danger")} value={scriptPath} onChange={(event) => setScriptPath(event.target.value)} onBlur={() => markTouched("scriptPath")} required />
                    <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                      <FolderOpen className="h-4 w-4" />
                      {text("选择", "Select")}
                    </Button>
                  </div>
                  <FieldError message={touchedFields.has("scriptPath") ? fieldErrors.scriptPath : undefined} />
                </div>
              </div>
            ) : null}
          </FormSection>

          {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
          {mutation.isError ? <ErrorState error={mutation.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={requestClose}>
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={mutation.isPending}>
              {mutation.isPending
                ? isEditMode
                  ? text("保存中", "Saving")
                  : text("正在创建", "Creating")
                : isEditMode
                  ? text("保存", "Save")
                  : text("创建", "Create")}
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
    </Dialog>
  );
}
