import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { ErrorState } from "../DataState";
import { RemoteStoragePicker } from "../storage/RemoteStoragePicker";
import { Button, Dialog, Input, Select } from "../ui";
import { imageApi, instanceApi } from "../../lib/api";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../../lib/batch";
import { useAuth } from "../../lib/use-auth";
import { useToast } from "../../lib/use-toast";
import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName, releaseConditionText, releaseConditionTextEn } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { normalizeStoragePath } from "../../lib/remote-storage";
import { mountPathToRemoteStoragePath, remoteStorageDirectoryToWorkDirectory, resolveTaskReleaseScriptSelection } from "../../lib/task-release-path";
import type { CreateTaskPayload, ImageItem, Task } from "../../lib/types";
import { errorMessage, useRunLogger } from "../../lib/use-run-logger";

const DEFAULT_PRICE = 1;
const DEFAULT_CPU = "4";
const DEFAULT_GPU = "0";
const DEFAULT_MEMORY = "16";
const MAX_BATCH_COUNT = 50;

type StoragePickerTarget = "storage" | "workDirectory" | "scriptPath";

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

export function CreateTaskDialog({ open, onClose, initialTask }: { open: boolean; onClose: () => void; initialTask?: Task | null }) {
  const auth = useAuth();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const queryClient = useQueryClient();
  const images = useQuery({ queryKey: ["images", "task-create"], queryFn: () => imageApi.list({ page: 1, page_size: 100 }), enabled: open });
  const systemImages = useQuery({ queryKey: ["images", "system", "task-create"], queryFn: () => imageApi.system({}), enabled: open });
  const [name, setName] = useState("");
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
  const [storagePickerTarget, setStoragePickerTarget] = useState<StoragePickerTarget | null>(null);
  const [batchCount, setBatchCount] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);

  const imageOptions = useMemo(() => [...(images.data?.items ?? []), ...(systemImages.data?.items ?? [])], [images.data, systemImages.data]);
  const hasSelectedImageOption = imageOptions.some((image) => String(image.id) === imageId);
  const username = auth.user?.username ?? "";

  useEffect(() => {
    if (open) {
      setName(formatTaskDefaultName());
      setImageId(String(getTaskImageId(initialTask)));
      setCpu(String(initialTask?.cpu ?? DEFAULT_CPU));
      setGpu(String(initialTask?.gpu ?? DEFAULT_GPU));
      setMemory(String(initialTask?.memory ?? DEFAULT_MEMORY));
      setReleaseCondition(String(initialTask?.releace_conditions ?? initialTask?.release_condition ?? "1"));
      setReleaseTime(formatClonedReleaseTime(initialTask?.releace_time));
      setStoragePath(initialTask?.storage_path || `/${username}`);
      setMountPath(initialTask?.mount_path || `/home/ubuntu/${username}`);
      setWorkDirectory(initialTask?.work_directory ?? "");
      setScriptPath(initialTask?.script_path ?? "");
      setStoragePickerTarget(null);
      setBatchCount("1");
      setFormError(null);
    }
  }, [initialTask, open, username]);

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
      await runSequentiallyWithDelay(payloads, (payload) => instanceApi.createTask(payload));
    },
    onSuccess: (_data, payloads) => {
      const firstName = String(payloads[0]?.name ?? "");
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
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
    },
    onError: (error) => {
      toast.error(text("实例创建失败", "Instance creation failed"), error instanceof Error ? error.message : text("请检查表单或稍后重试", "Check the form or try again later"));
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
    const taskName = name.trim();
    if (!taskName) {
      setFormError(text("任务名称不能为空", "Task name is required"));
      return;
    }
    if (!imageId) {
      setFormError(text("请选择镜像", "Select an image"));
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

    const count = Number(batchCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_COUNT) {
      setFormError(text(`批量数量必须在 1-${MAX_BATCH_COUNT} 之间`, `Batch count must be between 1 and ${MAX_BATCH_COUNT}`));
      return;
    }
    const selectedStoragePath = normalizeStoragePath(storagePath.trim() || `/${username}`);
    const selectedMountPath = mountPath.trim() || `/home/ubuntu/${username}`;

    const sharedPayload = {
      ...getCloneCreateFields(initialTask),
      price: DEFAULT_PRICE,
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

    mutation.mutate(
      Array.from({ length: count }, (_, index) => ({
        ...sharedPayload,
        name: formatBatchTaskName(taskName, index, count),
      })),
    );
  }

  const pickerStoragePath = normalizeStoragePath(storagePath.trim() || `/${username}`);
  const pickerMountPath = mountPath.trim() || `/home/ubuntu/${username}`;
  const pickerWorkDirectoryPath = workDirectory.trim()
    ? mountPathToRemoteStoragePath(workDirectory, pickerStoragePath, pickerMountPath)
    : storagePath || "/";
  const pickerMode = storagePickerTarget === "scriptPath" ? "file" : "directory";
  const pickerInitialPath =
    storagePickerTarget === "scriptPath"
      ? pickerWorkDirectoryPath
      : storagePickerTarget === "workDirectory"
        ? pickerWorkDirectoryPath
        : storagePath || "/";
  const pickerTitle =
    storagePickerTarget === "storage" ? text("选择存储目录", "Select storage directory") : storagePickerTarget === "workDirectory" ? text("选择工作目录", "Select working directory") : text("选择脚本文件", "Select script file");

  function handleStoragePickerSelect(path: string) {
    const selectedStoragePath = normalizeStoragePath(storagePath.trim() || `/${username}`);
    const selectedMountPath = mountPath.trim() || `/home/ubuntu/${username}`;

    if (storagePickerTarget === "storage") {
      setStoragePath(path);
    }
    if (storagePickerTarget === "workDirectory") {
      setWorkDirectory(remoteStorageDirectoryToWorkDirectory(path, selectedStoragePath, selectedMountPath));
    }
    if (storagePickerTarget === "scriptPath") {
      const nextPaths = resolveTaskReleaseScriptSelection({
        selectedFilePath: path,
        storagePath: selectedStoragePath,
        mountPath: selectedMountPath,
        currentWorkDirectory: workDirectory,
      });
      setWorkDirectory(nextPaths.workDirectory);
      setScriptPath(nextPaths.scriptPath);
    }
    setStoragePickerTarget(null);
  }

  return (
    <Dialog open={open} title={initialTask ? text("复制实例", "Clone Instance") : text("新建任务", "New Task")} onClose={onClose} width="max-w-4xl">
      <form className="p-4" onSubmit={submit}>
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("任务名称", "Task name")}</span>
              <Input className="w-full" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("创建数量", "Quantity")}</span>
              <Input
                className="w-full"
                type="number"
                min="1"
                max={MAX_BATCH_COUNT}
                step="1"
                value={batchCount}
                onChange={(event) => setBatchCount(event.target.value)}
                required
              />
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
          </div>
          {releaseCondition === "2" ? (
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("释放时间", "Release time")}</span>
              <Input className="w-full" type="datetime-local" value={releaseTime} onChange={(event) => setReleaseTime(event.target.value)} required />
            </label>
          ) : null}
          {releaseCondition === "3" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("工作目录", "Working directory")}</span>
                <div className="flex gap-2">
                  <Input className="w-full font-mono text-xs" value={workDirectory} onChange={(event) => setWorkDirectory(event.target.value)} required />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("workDirectory")}>
                    <FolderOpen className="h-4 w-4" />
                    {text("选择", "Select")}
                  </Button>
                </div>
              </div>
              <div className="block text-sm">
                <span className="mb-1 block text-app-muted">{text("脚本路径", "Script path")}</span>
                <div className="flex gap-2">
                  <Input className="w-full font-mono text-xs" value={scriptPath} onChange={(event) => setScriptPath(event.target.value)} required />
                  <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                    <FolderOpen className="h-4 w-4" />
                    {text("选择", "Select")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("镜像", "Image")}</span>
            <Select className="w-full" value={imageId} onChange={(event) => setImageId(event.target.value)}>
              <option value="">{text("请选择镜像", "Select an image")}</option>
              {imageId && !hasSelectedImageOption ? <option value={imageId}>{text(`原实例镜像 #${imageId}`, `Original instance image #${imageId}`)}</option> : null}
              {imageOptions.map((image) => (
                <option key={String(image.id)} value={String(image.id)}>
                  {getImageOptionLabel(image)}
                </option>
              ))}
            </Select>
          </label>
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
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">CPU</span>
              <Input className="w-full" type="number" min="0.1" step="0.1" value={cpu} onChange={(event) => setCpu(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">GPU</span>
              <Input className="w-full" type="number" min="0" step="1" value={gpu} onChange={(event) => handleGpuChange(event.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("内存 (GiB)", "Memory (GiB)")}</span>
              <Input className="w-full" type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} required />
            </label>
          </div>
          {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
          {mutation.isError ? <ErrorState error={mutation.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={mutation.isPending}>{mutation.isPending ? text("正在创建", "Creating") : text("创建", "Create")}</Button>
          </div>
        </div>
      </form>
      <RemoteStoragePicker
        initialPath={pickerInitialPath}
        mode={pickerMode}
        open={storagePickerTarget !== null}
        title={pickerTitle}
        onClose={() => setStoragePickerTarget(null)}
        onSelect={handleStoragePickerSelect}
      />
    </Dialog>
  );
}
