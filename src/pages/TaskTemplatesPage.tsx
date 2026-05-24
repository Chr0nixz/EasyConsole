import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyPlus, Edit2, FolderOpen, Plus, RefreshCw, Rocket, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { RemoteStoragePicker } from "../components/storage/RemoteStoragePicker";
import { Button, Dialog, Input, Panel, Select, Textarea } from "../components/ui";
import { imageApi, instanceApi } from "../lib/api";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../lib/batch";
import { getReleaseConditionText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { normalizeStoragePath } from "../lib/remote-storage";
import { browserRuntime } from "../lib/runtime";
import {
  createTaskTemplate,
  loadTaskTemplates,
  MAX_TEMPLATE_BATCH_COUNT,
  recordTaskTemplateUsage,
  saveTaskTemplates,
  taskMatchesTemplate,
  taskTemplateToPayloads,
  updateTaskTemplate,
  type EditableTaskTemplate,
} from "../lib/task-templates";
import type { ImageItem, Task, TaskTemplate } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

type StoragePickerTarget = "storage" | "workDirectory" | "scriptPath";

const DEFAULT_CPU = 4;
const DEFAULT_GPU = 0;
const DEFAULT_MEMORY = 16;
const RUNNING_TASK_STATUS = 2;
const RUNNING_TASK_PAGE_SIZE = 200;
const MAX_RUNNING_TASK_PAGES = 20;

function getImageOptionLabel(image: ImageItem) {
  const name = image.name ?? image.image_name ?? String(image.id);
  return image.tag ? `${name}:${image.tag}` : name;
}

function getImageName(images: ImageItem[], imageId: string, text: (zh: string, en: string) => string) {
  const image = images.find((item) => String(item.id) === imageId);
  return image ? getImageOptionLabel(image) : text(`镜像 #${imageId}`, `Image #${imageId}`);
}

function getDefaultTemplate(username: string, imageId = ""): EditableTaskTemplate {
  return {
    name: "Default dev environment",
    description: "",
    taskNamePrefix: "dev",
    batchCount: 1,
    imageId,
    cpu: DEFAULT_CPU,
    gpu: DEFAULT_GPU,
    memory: DEFAULT_MEMORY,
    storagePath: `/${username}`,
    mountPath: `/home/ubuntu/${username}`,
    releaseCondition: 1,
    releaseAfterHours: 24,
    workDirectory: "",
    scriptPath: "",
  };
}

function formatResource(template: TaskTemplate) {
  return `${template.cpu}C / ${template.gpu}GPU / ${template.memory}G`;
}

function parseFormNumber(value: string, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchRunningTasks() {
  const tasks: Task[] = [];
  for (let page = 1; page <= MAX_RUNNING_TASK_PAGES; page += 1) {
    const result = await instanceApi.tasks({ page, page_size: RUNNING_TASK_PAGE_SIZE, status: RUNNING_TASK_STATUS });
    tasks.push(...result.items);
    if (typeof result.total === "number" && tasks.length >= result.total) break;
    if (result.items.length < RUNNING_TASK_PAGE_SIZE) break;
  }
  return tasks;
}

function TemplateDialog({
  imageOptions,
  initialValue,
  open,
  username,
  onClose,
  onSave,
}: {
  imageOptions: ImageItem[];
  initialValue: TaskTemplate | null;
  open: boolean;
  username: string;
  onClose: () => void;
  onSave: (value: EditableTaskTemplate) => void;
}) {
  const { text } = useI18n();
  const [form, setForm] = useState<EditableTaskTemplate>(() => getDefaultTemplate(username));
  const [storagePickerTarget, setStoragePickerTarget] = useState<StoragePickerTarget | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialValue ?? getDefaultTemplate(username, imageOptions[0] ? String(imageOptions[0].id) : ""));
    setFormError(null);
    setStoragePickerTarget(null);
  }, [imageOptions, initialValue, open, username]);

  function update<K extends keyof EditableTaskTemplate>(key: K, value: EditableTaskTemplate[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const name = form.name.trim();
    const taskNamePrefix = form.taskNamePrefix.trim();
    const imageId = form.imageId.trim();
    if (!name) {
      setFormError(text("模板名称不能为空", "Template name is required"));
      return;
    }
    if (!taskNamePrefix) {
      setFormError(text("实例名称前缀不能为空", "Instance name prefix is required"));
      return;
    }
    if (!imageId) {
      setFormError(text("请选择镜像", "Select an image"));
      return;
    }
    if (form.cpu <= 0) {
      setFormError(text("CPU 必须大于 0", "CPU must be greater than 0"));
      return;
    }
    if (!Number.isInteger(form.gpu) || form.gpu < 0) {
      setFormError(text("GPU 必须是非负整数", "GPU must be a non-negative integer"));
      return;
    }
    if (!Number.isInteger(form.memory) || form.memory <= 0) {
      setFormError(text("内存必须是正整数", "Memory must be a positive integer"));
      return;
    }
    if (!Number.isInteger(form.batchCount) || form.batchCount < 1 || form.batchCount > MAX_TEMPLATE_BATCH_COUNT) {
      setFormError(text(`创建数量必须在 1-${MAX_TEMPLATE_BATCH_COUNT} 之间`, `Quantity must be between 1 and ${MAX_TEMPLATE_BATCH_COUNT}`));
      return;
    }
    if (form.releaseCondition === 2 && (!form.releaseAfterHours || form.releaseAfterHours <= 0)) {
      setFormError(text("定时释放小时数必须大于 0", "Timed release hours must be greater than 0"));
      return;
    }
    if (form.releaseCondition === 3 && (!form.workDirectory?.trim() || !form.scriptPath?.trim())) {
      setFormError(text("任务结束释放需要填写工作目录和脚本路径", "Release after task ends requires a working directory and script path"));
      return;
    }

    onSave({
      ...form,
      name,
      description: form.description?.trim(),
      taskNamePrefix,
      imageId,
      storagePath: normalizeStoragePath(form.storagePath.trim() || `/${username}`),
      mountPath: form.mountPath.trim() || `/home/ubuntu/${username}`,
      workDirectory: form.workDirectory?.trim(),
      scriptPath: form.scriptPath?.trim(),
    });
  }

  const pickerMode = storagePickerTarget === "scriptPath" ? "file" : "directory";
  const pickerInitialPath =
    storagePickerTarget === "scriptPath"
      ? form.workDirectory || form.storagePath || "/"
      : storagePickerTarget === "workDirectory"
        ? form.workDirectory || form.storagePath || "/"
        : form.storagePath || "/";
  const pickerTitle =
    storagePickerTarget === "storage" ? text("选择存储目录", "Select storage directory") : storagePickerTarget === "workDirectory" ? text("选择工作目录", "Select working directory") : text("选择脚本文件", "Select script file");

  const dialogTitle = initialValue?.id ? text("编辑实例模板", "Edit Instance Template") : initialValue ? text("复制实例模板", "Copy Instance Template") : text("新建实例模板", "New Instance Template");

  return (
    <Dialog open={open} title={dialogTitle} onClose={onClose} width="max-w-4xl">
      <form className="space-y-4 p-4" onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("模板名称", "Template name")}</span>
            <Input className="w-full" value={form.name} onChange={(event) => update("name", event.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("实例名称前缀", "Instance name prefix")}</span>
            <Input className="w-full" value={form.taskNamePrefix} onChange={(event) => update("taskNamePrefix", event.target.value)} required />
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-app-muted">{text("说明", "Description")}</span>
          <Textarea className="min-h-20 w-full" value={form.description ?? ""} onChange={(event) => update("description", event.target.value)} />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("镜像", "Image")}</span>
            <Select className="w-full" value={form.imageId} onChange={(event) => update("imageId", event.target.value)} required>
              <option value="">{text("请选择镜像", "Select an image")}</option>
              {imageOptions.map((image) => (
                <option key={String(image.id)} value={String(image.id)}>
                  {getImageOptionLabel(image)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("创建数量", "Quantity")}</span>
            <Input
              className="w-full"
              max={MAX_TEMPLATE_BATCH_COUNT}
              min="1"
              step="1"
              type="number"
              value={form.batchCount}
              onChange={(event) => update("batchCount", parseFormNumber(event.target.value, 1))}
              required
            />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">CPU</span>
            <Input className="w-full" min="0.1" step="0.1" type="number" value={form.cpu} onChange={(event) => update("cpu", parseFormNumber(event.target.value, DEFAULT_CPU))} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">GPU</span>
            <Input className="w-full" min="0" step="1" type="number" value={form.gpu} onChange={(event) => update("gpu", parseFormNumber(event.target.value, DEFAULT_GPU))} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("内存 (GiB)", "Memory (GiB)")}</span>
            <Input className="w-full" min="1" step="1" type="number" value={form.memory} onChange={(event) => update("memory", parseFormNumber(event.target.value, DEFAULT_MEMORY))} required />
          </label>
        </div>
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <span className="mb-1 block text-app-muted">{text("存储路径", "Storage path")}</span>
            <div className="flex gap-2">
              <Input className="w-full font-mono text-xs" value={form.storagePath} onChange={(event) => update("storagePath", event.target.value)} />
              <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("storage")}>
                <FolderOpen className="h-4 w-4" />
                {text("选择", "Select")}
              </Button>
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-app-muted">{text("挂载路径", "Mount path")}</span>
            <Input className="w-full font-mono text-xs" value={form.mountPath} onChange={(event) => update("mountPath", event.target.value)} />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("释放条件", "Release condition")}</span>
            <Select className="w-full" value={form.releaseCondition} onChange={(event) => update("releaseCondition", Number(event.target.value) as 1 | 2 | 3)}>
              <option value={1}>{text("手动释放", "Manual release")}</option>
              <option value={2}>{text("定时释放", "Timed release")}</option>
              <option value={3}>{text("任务结束释放", "Release after task ends")}</option>
            </Select>
          </label>
          {form.releaseCondition === 2 ? (
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("创建后释放小时数", "Release hours after creation")}</span>
              <Input className="w-full" min="0.1" step="0.1" type="number" value={form.releaseAfterHours ?? 24} onChange={(event) => update("releaseAfterHours", parseFormNumber(event.target.value, 24))} required />
            </label>
          ) : null}
        </div>
        {form.releaseCondition === 3 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("工作目录", "Working directory")}</span>
              <div className="flex gap-2">
                <Input className="w-full font-mono text-xs" value={form.workDirectory ?? ""} onChange={(event) => update("workDirectory", event.target.value)} required />
                <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("workDirectory")}>
                  <FolderOpen className="h-4 w-4" />
                  {text("选择", "Select")}
                </Button>
              </div>
            </div>
            <div className="block text-sm">
              <span className="mb-1 block text-app-muted">{text("脚本路径", "Script path")}</span>
              <div className="flex gap-2">
                <Input className="w-full font-mono text-xs" value={form.scriptPath ?? ""} onChange={(event) => update("scriptPath", event.target.value)} required />
                <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                  <FolderOpen className="h-4 w-4" />
                  {text("选择", "Select")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
        <div className="flex justify-end gap-2 border-t border-app-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            {text("取消", "Cancel")}
          </Button>
          <Button>{initialValue ? text("保存", "Save") : text("创建模板", "Create template")}</Button>
        </div>
      </form>
      <RemoteStoragePicker
        initialPath={pickerInitialPath}
        mode={pickerMode}
        open={storagePickerTarget !== null}
        title={pickerTitle}
        onClose={() => setStoragePickerTarget(null)}
        onSelect={(path) => {
          if (storagePickerTarget === "storage") update("storagePath", path);
          if (storagePickerTarget === "workDirectory") update("workDirectory", path);
          if (storagePickerTarget === "scriptPath") update("scriptPath", path);
          setStoragePickerTarget(null);
        }}
      />
    </Dialog>
  );
}

export function TaskTemplatesPage() {
  const auth = useAuth();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirmAction();
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const username = auth.user?.username ?? "";

  const imageQuery = useMutation({
    mutationFn: async () => {
      const [customImages, systemImages] = await Promise.all([imageApi.list({ page: 1, page_size: 100 }), imageApi.system({})]);
      return [...customImages.items, ...systemImages.items];
    },
  });
  const imageOptions = useMemo(() => imageQuery.data ?? [], [imageQuery.data]);
  const runningTasksQuery = useQuery({
    queryKey: ["task-template-running-counts"],
    queryFn: fetchRunningTasks,
    enabled: !loading,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const runningCountByTemplateId = useMemo(() => {
    const runningTasks = runningTasksQuery.data ?? [];
    return Object.fromEntries(
      templates.map((template) => [
        template.id,
        runningTasks.filter((task) => Number(task.status) === RUNNING_TASK_STATUS && taskMatchesTemplate(task, template)).length,
      ]),
    );
  }, [runningTasksQuery.data, templates]);

  useEffect(() => {
    void loadTaskTemplates(browserRuntime.storage)
      .then((items) => {
        setTemplates(items);
        setLoadError(null);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error : new Error(text("模板读取失败", "Failed to read templates")));
      })
      .finally(() => setLoading(false));
    imageQuery.mutate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function persist(nextTemplates: TaskTemplate[]) {
    setTemplates(nextTemplates);
    await saveTaskTemplates(browserRuntime.storage, nextTemplates);
  }

  function openCreateDialog() {
    setEditingTemplate(null);
    setDialogOpen(true);
  }

  function openEditDialog(template: TaskTemplate) {
    setEditingTemplate(template);
    setDialogOpen(true);
  }

  const createMutation = useMutation({
    mutationFn: async (template: TaskTemplate) => {
      const payloads = taskTemplateToPayloads(template);
      await runSequentiallyWithDelay(payloads, (payload) => instanceApi.createTask(payload));
      return payloads;
    },
    onSuccess: (payloads, template) => {
      const description = payloads.length > 1 ? text(`${payloads[0]?.name} 等 ${payloads.length} 个实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms`, `${payloads[0]?.name} and ${payloads.length - 1} more instances, ${BATCH_REQUEST_DELAY_MS}ms apart`) : String(payloads[0]?.name ?? "");
      const title = text(`已按模板创建：${template.name}`, `Created from template: ${template.name}`);
      toast.success(title, description);
      void runLogger.log({
        source: "task-template",
        level: "info",
        action: "taskTemplate.execute",
        result: "success",
        title,
        targetName: template.name,
        targetId: template.id,
        metadata: { count: payloads.length, names: payloads.map((payload) => payload.name) },
      });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task-template-running-counts"] });
      setTemplates((current) => {
        const next = current.map((item) => (item.id === template.id ? recordTaskTemplateUsage(item) : item));
        void saveTaskTemplates(browserRuntime.storage, next);
        return next;
      });
    },
    onError: (error, template) => {
      toast.error(text(`模板创建失败：${template.name}`, `Template creation failed: ${template.name}`), error instanceof Error ? error.message : text("请检查模板配置或稍后重试", "Check the template configuration or try again later"));
      void runLogger.log({
        source: "task-template",
        level: "error",
        action: "taskTemplate.execute",
        result: "failure",
        title: text(`模板创建失败：${template.name}`, `Template creation failed: ${template.name}`),
        targetName: template.name,
        targetId: template.id,
        error: errorMessage(error, text("模板创建失败", "Template creation failed")),
      });
    },
  });

  const storageMutation = useMutation({
    mutationFn: persist,
    onSuccess: () => {
      toast.success(text("模板已保存", "Template saved"));
      void runLogger.log({
        source: "task-template",
        level: "info",
        action: "taskTemplate.save",
        result: "success",
        title: text("模板已保存", "Template saved"),
      });
    },
    onError: (error) => {
      toast.error(text("模板保存失败", "Failed to save template"), error instanceof Error ? error.message : text("请稍后重试", "Try again later"));
      void runLogger.log({
        source: "task-template",
        level: "error",
        action: "taskTemplate.save",
        result: "failure",
        title: text("模板保存失败", "Failed to save template"),
        error: errorMessage(error, text("模板保存失败", "Failed to save template")),
      });
    },
  });

  function saveTemplate(value: EditableTaskTemplate) {
    const next = editingTemplate?.id
      ? templates.map((template) => (template.id === editingTemplate.id ? updateTaskTemplate(template, value) : template))
      : [createTaskTemplate(value), ...templates];
    storageMutation.mutate(next);
    setDialogOpen(false);
    setEditingTemplate(null);
  }

  function deleteTemplate(template: TaskTemplate) {
    confirm({
      title: text("删除实例模板", "Delete Instance Template"),
      description: text(`将删除模板 ${template.name}。已创建的实例不受影响。`, `Delete template ${template.name}. Created instances are not affected.`),
      confirmLabel: text("删除", "Delete"),
      tone: "danger",
      run: async () => {
        await persist(templates.filter((item) => item.id !== template.id));
        void runLogger.log({
          source: "task-template",
          level: "info",
          action: "taskTemplate.delete",
          result: "success",
          title: text("模板已删除", "Template deleted"),
          targetName: template.name,
          targetId: template.id,
        });
      },
    });
  }

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{text("实例模板", "Instance Templates")}</h2>
          <p className="mt-1 text-sm text-app-muted">{text("保存常用资源、镜像和路径配置，从模板直接提交新实例。", "Save common resource, image, and path settings, then create new instances directly from templates.")}</p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button className="flex-1 sm:flex-none" variant="secondary" onClick={() => runningTasksQuery.refetch()}>
            <RefreshCw className="h-4 w-4" />
            {text("刷新统计", "Refresh stats")}
          </Button>
          <Button className="flex-1 sm:flex-none" onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
            {text("新建模板", "New template")}
          </Button>
        </div>
      </div>

      {loadError ? <ErrorState error={loadError} action={<Button variant="secondary" onClick={() => window.location.reload()}>{text("重新加载", "Reload")}</Button>} /> : null}
      {imageQuery.isError ? <ErrorState error={imageQuery.error} action={<Button variant="secondary" onClick={() => imageQuery.mutate()}>{text("重试镜像列表", "Retry image list")}</Button>} /> : null}
      {runningTasksQuery.isError ? <ErrorState error={runningTasksQuery.error} action={<Button variant="secondary" onClick={() => runningTasksQuery.refetch()}>{text("重试运行统计", "Retry runtime stats")}</Button>} /> : null}

      {templates.length === 0 ? (
        <Panel>
          <EmptyState
            title={text("还没有实例模板。为常用开发、训练或批处理环境保存一套参数，之后可以一键创建。", "No instance templates yet. Save a parameter set for common development, training, or batch environments, then create instances with one action.")}
            action={<Button onClick={openCreateDialog}>{text("新建模板", "New template")}</Button>}
          />
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <div className="overflow-auto">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("模板", "Template")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("镜像", "Image")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("资源", "Resources")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("使用次数", "Uses")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("运行中", "Running")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("路径", "Paths")}</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">{text("释放", "Release")}</th>
                  <th className="sticky right-0 z-20 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 text-center font-medium shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]">
                    {text("操作", "Actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <tr key={template.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <div className="font-medium">{template.name}</div>
                      <div className="mt-0.5 max-w-72 truncate text-xs text-app-muted">
                        {template.description || text(`${template.taskNamePrefix}，每次 ${template.batchCount} 个`, `${template.taskNamePrefix}, ${template.batchCount} each time`)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{getImageName(imageOptions, template.imageId, text)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{formatResource(template)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <div className="font-medium text-app-text">{template.usageCount}</div>
                      {template.lastUsedAt ? <div className="mt-0.5 text-xs text-app-muted">{template.lastUsedAt.slice(0, 19).replace("T", " ")}</div> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <span className="inline-flex min-w-10 justify-center rounded-md border border-app-border bg-app-panel px-2 py-1 text-xs font-medium text-app-text">
                        {runningTasksQuery.isLoading ? "-" : (runningCountByTemplateId[template.id] ?? 0)}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <div className="max-w-72 truncate font-mono text-xs text-app-muted">{template.storagePath}</div>
                      <div className="mt-1 max-w-72 truncate font-mono text-xs text-app-muted">{template.mountPath}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">
                      {getReleaseConditionText(template.releaseCondition, locale)}
                      {template.releaseCondition === 2 ? text(`，${template.releaseAfterHours ?? 24} 小时后`, `, after ${template.releaseAfterHours ?? 24} hours`) : ""}
                    </td>
                    <td className="sticky right-0 z-10 bg-app-surface px-3 py-2 align-middle shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]">
                      <div className="flex justify-end gap-1">
                        <Button
                          className="h-8 px-2"
                          disabled={createMutation.isPending}
                          title={text("一键新建", "Create with template")}
                          onClick={() => createMutation.mutate(template)}
                        >
                          <Rocket className="h-4 w-4" />
                          {text("新建", "New")}
                        </Button>
                        <Button className="h-8 w-8 px-0" title={text("编辑", "Edit")} type="button" variant="ghost" onClick={() => openEditDialog(template)}>
                          <Edit2 className="h-4 w-4" />
                          <span className="sr-only">{text("编辑", "Edit")}</span>
                        </Button>
                        <Button
                          className="h-8 w-8 px-0"
                          title={text("复制模板", "Copy template")}
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setEditingTemplate({
                              ...template,
                              id: "",
                              name: text(`${template.name} 副本`, `${template.name} Copy`),
                              usageCount: 0,
                              lastUsedAt: undefined,
                              createdAt: "",
                              updatedAt: "",
                            });
                            setDialogOpen(true);
                          }}
                        >
                          <CopyPlus className="h-4 w-4" />
                          <span className="sr-only">{text("复制模板", "Copy template")}</span>
                        </Button>
                        <Button className="h-8 w-8 px-0 text-app-danger hover:text-app-danger" title={text("删除", "Delete")} type="button" variant="ghost" onClick={() => deleteTemplate(template)}>
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">{text("删除", "Delete")}</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <TemplateDialog
        imageOptions={imageOptions}
        initialValue={editingTemplate}
        open={dialogOpen}
        username={username}
        onClose={() => {
          setDialogOpen(false);
          setEditingTemplate(null);
        }}
        onSave={saveTemplate}
      />
      {confirmDialog}
    </div>
  );
}
