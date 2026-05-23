import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyPlus, Edit2, FolderOpen, Plus, Rocket, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { RemoteStoragePicker } from "../components/storage/RemoteStoragePicker";
import { Button, Dialog, Input, Panel, Select, Textarea } from "../components/ui";
import { imageApi, instanceApi } from "../lib/api";
import { BATCH_REQUEST_DELAY_MS, runSequentiallyWithDelay } from "../lib/batch";
import { getReleaseConditionText } from "../lib/format";
import { normalizeStoragePath } from "../lib/remote-storage";
import { browserRuntime } from "../lib/runtime";
import {
  createTaskTemplate,
  loadTaskTemplates,
  MAX_TEMPLATE_BATCH_COUNT,
  saveTaskTemplates,
  taskTemplateToPayloads,
  updateTaskTemplate,
  type EditableTaskTemplate,
} from "../lib/task-templates";
import type { ImageItem, TaskTemplate } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";

type StoragePickerTarget = "storage" | "workDirectory" | "scriptPath";

const DEFAULT_CPU = 4;
const DEFAULT_GPU = 0;
const DEFAULT_MEMORY = 16;

function getImageOptionLabel(image: ImageItem) {
  const name = image.name ?? image.image_name ?? String(image.id);
  return image.tag ? `${name}:${image.tag}` : name;
}

function getImageName(images: ImageItem[], imageId: string) {
  const image = images.find((item) => String(item.id) === imageId);
  return image ? getImageOptionLabel(image) : `镜像 #${imageId}`;
}

function getDefaultTemplate(username: string, imageId = ""): EditableTaskTemplate {
  return {
    name: "默认开发环境",
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
      setFormError("模板名称不能为空");
      return;
    }
    if (!taskNamePrefix) {
      setFormError("实例名称前缀不能为空");
      return;
    }
    if (!imageId) {
      setFormError("请选择镜像");
      return;
    }
    if (form.cpu <= 0) {
      setFormError("CPU 必须大于 0");
      return;
    }
    if (!Number.isInteger(form.gpu) || form.gpu < 0) {
      setFormError("GPU 必须是非负整数");
      return;
    }
    if (!Number.isInteger(form.memory) || form.memory <= 0) {
      setFormError("内存必须是正整数");
      return;
    }
    if (!Number.isInteger(form.batchCount) || form.batchCount < 1 || form.batchCount > MAX_TEMPLATE_BATCH_COUNT) {
      setFormError(`创建数量必须在 1-${MAX_TEMPLATE_BATCH_COUNT} 之间`);
      return;
    }
    if (form.releaseCondition === 2 && (!form.releaseAfterHours || form.releaseAfterHours <= 0)) {
      setFormError("定时释放小时数必须大于 0");
      return;
    }
    if (form.releaseCondition === 3 && (!form.workDirectory?.trim() || !form.scriptPath?.trim())) {
      setFormError("任务结束释放需要填写工作目录和脚本路径");
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
    storagePickerTarget === "storage" ? "选择存储目录" : storagePickerTarget === "workDirectory" ? "选择工作目录" : "选择脚本文件";

  const dialogTitle = initialValue?.id ? "编辑实例模板" : initialValue ? "复制实例模板" : "新建实例模板";

  return (
    <Dialog open={open} title={dialogTitle} onClose={onClose} width="max-w-4xl">
      <form className="space-y-4 p-4" onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">模板名称</span>
            <Input className="w-full" value={form.name} onChange={(event) => update("name", event.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">实例名称前缀</span>
            <Input className="w-full" value={form.taskNamePrefix} onChange={(event) => update("taskNamePrefix", event.target.value)} required />
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-app-muted">说明</span>
          <Textarea className="min-h-20 w-full" value={form.description ?? ""} onChange={(event) => update("description", event.target.value)} />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">镜像</span>
            <Select className="w-full" value={form.imageId} onChange={(event) => update("imageId", event.target.value)} required>
              <option value="">请选择镜像</option>
              {imageOptions.map((image) => (
                <option key={String(image.id)} value={String(image.id)}>
                  {getImageOptionLabel(image)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">创建数量</span>
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
            <span className="mb-1 block text-app-muted">内存 (GiB)</span>
            <Input className="w-full" min="1" step="1" type="number" value={form.memory} onChange={(event) => update("memory", parseFormNumber(event.target.value, DEFAULT_MEMORY))} required />
          </label>
        </div>
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <span className="mb-1 block text-app-muted">存储路径</span>
            <div className="flex gap-2">
              <Input className="w-full font-mono text-xs" value={form.storagePath} onChange={(event) => update("storagePath", event.target.value)} />
              <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("storage")}>
                <FolderOpen className="h-4 w-4" />
                选择
              </Button>
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-app-muted">挂载路径</span>
            <Input className="w-full font-mono text-xs" value={form.mountPath} onChange={(event) => update("mountPath", event.target.value)} />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">释放条件</span>
            <Select className="w-full" value={form.releaseCondition} onChange={(event) => update("releaseCondition", Number(event.target.value) as 1 | 2 | 3)}>
              <option value={1}>手动释放</option>
              <option value={2}>定时释放</option>
              <option value={3}>任务结束释放</option>
            </Select>
          </label>
          {form.releaseCondition === 2 ? (
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">创建后释放小时数</span>
              <Input className="w-full" min="0.1" step="0.1" type="number" value={form.releaseAfterHours ?? 24} onChange={(event) => update("releaseAfterHours", parseFormNumber(event.target.value, 24))} required />
            </label>
          ) : null}
        </div>
        {form.releaseCondition === 3 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="block text-sm">
              <span className="mb-1 block text-app-muted">工作目录</span>
              <div className="flex gap-2">
                <Input className="w-full font-mono text-xs" value={form.workDirectory ?? ""} onChange={(event) => update("workDirectory", event.target.value)} required />
                <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("workDirectory")}>
                  <FolderOpen className="h-4 w-4" />
                  选择
                </Button>
              </div>
            </div>
            <div className="block text-sm">
              <span className="mb-1 block text-app-muted">脚本路径</span>
              <div className="flex gap-2">
                <Input className="w-full font-mono text-xs" value={form.scriptPath ?? ""} onChange={(event) => update("scriptPath", event.target.value)} required />
                <Button className="shrink-0" type="button" variant="secondary" onClick={() => setStoragePickerTarget("scriptPath")}>
                  <FolderOpen className="h-4 w-4" />
                  选择
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {formError ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{formError}</div> : null}
        <div className="flex justify-end gap-2 border-t border-app-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button>{initialValue ? "保存" : "创建模板"}</Button>
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

  useEffect(() => {
    void loadTaskTemplates(browserRuntime.storage)
      .then((items) => {
        setTemplates(items);
        setLoadError(null);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error : new Error("模板读取失败"));
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
      const description = payloads.length > 1 ? `${payloads[0]?.name} 等 ${payloads.length} 个实例，间隔 ${BATCH_REQUEST_DELAY_MS}ms` : String(payloads[0]?.name ?? "");
      toast.success(`已按模板创建：${template.name}`, description);
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error, template) => {
      toast.error(`模板创建失败：${template.name}`, error instanceof Error ? error.message : "请检查模板配置或稍后重试");
    },
  });

  const storageMutation = useMutation({
    mutationFn: persist,
    onSuccess: () => toast.success("模板已保存"),
    onError: (error) => toast.error("模板保存失败", error instanceof Error ? error.message : "请稍后重试"),
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
      title: "删除实例模板",
      description: `将删除模板 ${template.name}。已创建的实例不受影响。`,
      confirmLabel: "删除",
      tone: "danger",
      run: async () => persist(templates.filter((item) => item.id !== template.id)),
    });
  }

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">实例模板</h2>
          <p className="mt-1 text-sm text-app-muted">保存常用资源、镜像和路径配置，从模板直接提交新实例。</p>
        </div>
        <Button className="w-full sm:w-auto" onClick={openCreateDialog}>
          <Plus className="h-4 w-4" />
          新建模板
        </Button>
      </div>

      {loadError ? <ErrorState error={loadError} action={<Button variant="secondary" onClick={() => window.location.reload()}>重新加载</Button>} /> : null}
      {imageQuery.isError ? <ErrorState error={imageQuery.error} action={<Button variant="secondary" onClick={() => imageQuery.mutate()}>重试镜像列表</Button>} /> : null}

      {templates.length === 0 ? (
        <Panel>
          <EmptyState
            title="还没有实例模板。为常用开发、训练或批处理环境保存一套参数，之后可以一键创建。"
            action={<Button onClick={openCreateDialog}>新建模板</Button>}
          />
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <div className="overflow-auto">
            <table className="w-max min-w-full table-auto border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">模板</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">镜像</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">资源</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">路径</th>
                  <th className="whitespace-nowrap border-b border-app-border px-3 py-2 font-medium">释放</th>
                  <th className="sticky right-0 z-20 whitespace-nowrap border-b border-app-border bg-app-panel px-3 py-2 text-center font-medium shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <tr key={template.id} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <div className="font-medium">{template.name}</div>
                      <div className="mt-0.5 max-w-72 truncate text-xs text-app-muted">
                        {template.description || `${template.taskNamePrefix}，每次 ${template.batchCount} 个`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{getImageName(imageOptions, template.imageId)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{formatResource(template)}</td>
                    <td className="px-3 py-2 align-middle">
                      <div className="max-w-72 truncate font-mono text-xs text-app-muted">{template.storagePath}</div>
                      <div className="mt-1 max-w-72 truncate font-mono text-xs text-app-muted">{template.mountPath}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">
                      {getReleaseConditionText(template.releaseCondition)}
                      {template.releaseCondition === 2 ? `，${template.releaseAfterHours ?? 24} 小时后` : ""}
                    </td>
                    <td className="sticky right-0 z-10 bg-app-surface px-3 py-2 align-middle shadow-[-10px_0_16px_-16px_rgb(15_23_42_/_0.45)]">
                      <div className="flex justify-end gap-1">
                        <Button
                          className="h-8 px-2"
                          disabled={createMutation.isPending}
                          title="一键新建"
                          onClick={() => createMutation.mutate(template)}
                        >
                          <Rocket className="h-4 w-4" />
                          新建
                        </Button>
                        <Button className="h-8 w-8 px-0" title="编辑" type="button" variant="ghost" onClick={() => openEditDialog(template)}>
                          <Edit2 className="h-4 w-4" />
                          <span className="sr-only">编辑</span>
                        </Button>
                        <Button
                          className="h-8 w-8 px-0"
                          title="复制模板"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setEditingTemplate({
                              ...template,
                              id: "",
                              name: `${template.name} 副本`,
                              createdAt: "",
                              updatedAt: "",
                            });
                            setDialogOpen(true);
                          }}
                        >
                          <CopyPlus className="h-4 w-4" />
                          <span className="sr-only">复制模板</span>
                        </Button>
                        <Button className="h-8 w-8 px-0 text-app-danger hover:text-app-danger" title="删除" type="button" variant="ghost" onClick={() => deleteTemplate(template)}>
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
