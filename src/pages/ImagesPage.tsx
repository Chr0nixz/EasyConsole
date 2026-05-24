import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState, ErrorState, TableSkeleton } from "../components/DataState";
import { Button, Input, Panel, Select } from "../components/ui";
import { imageApi } from "../lib/api";
import { saveBlob } from "../lib/download";
import type { ImageItem } from "../lib/types";
import { cn } from "../lib/utils";
import { useConfirmAction } from "../lib/use-confirm-action";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

type ImageSource = "custom" | "system";
type SourceFilter = "all" | ImageSource;

type ImageRow = ImageItem & {
  source: ImageSource;
};

function imageName(image: ImageItem) {
  return String(image.name ?? image.image_name ?? image.id);
}

function imageVersion(image: ImageItem) {
  return image.tag ? String(image.tag) : "-";
}

function imageDescription(image: ImageItem) {
  return typeof image.description === "string" && image.description.trim() ? image.description : "-";
}

function isDefaultImage(image: ImageItem) {
  return image.is_default === true || image.default === true || image.isDefault === true;
}

function getImageUpdatedAt(image: ImageItem) {
  const value = image.update_time ?? image.updated_at ?? image.create_time ?? image.created_at;
  return typeof value === "string" && value.trim() ? value : "-";
}

function getImageKeyword(image: ImageItem) {
  return [imageName(image), imageVersion(image), imageDescription(image), image.id].join(" ").toLowerCase();
}

export function ImagesPage() {
  const toast = useToast();
  const runLogger = useRunLogger();
  const { confirm, confirmDialog } = useConfirmAction();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [keyword, setKeyword] = useState("");
  const custom = useQuery({ queryKey: ["images"], queryFn: () => imageApi.list({ page: 1, page_size: 100 }) });
  const system = useQuery({ queryKey: ["images", "system"], queryFn: () => imageApi.system({}) });

  const images = useMemo<ImageRow[]>(
    () => [
      ...(custom.data?.items ?? []).map((image) => ({ ...image, source: "custom" as const })),
      ...(system.data?.items ?? []).map((image) => ({ ...image, source: "system" as const })),
    ],
    [custom.data?.items, system.data?.items],
  );

  const filteredImages = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return images.filter((image) => {
      const matchesSource = sourceFilter === "all" || image.source === sourceFilter;
      const matchesKeyword = !normalizedKeyword || getImageKeyword(image).includes(normalizedKeyword);
      return matchesSource && matchesKeyword;
    });
  }, [images, keyword, sourceFilter]);

  const refetchImages = () => {
    void custom.refetch();
    void system.refetch();
  };

  const setDefaultImage = (image: ImageRow) => {
    confirm({
      title: "确认设置默认镜像",
      description: `将 ${imageName(image)} 设置为默认镜像。新建任务选择镜像时会优先使用它。`,
      confirmLabel: "设为默认",
      run: async () => {
        try {
          await imageApi.setDefault(image.id);
          toast.success("默认镜像已更新", imageName(image));
          void runLogger.log({
            source: "image",
            level: "info",
            action: "image.setDefault",
            result: "success",
            title: "默认镜像已更新",
            targetName: imageName(image),
            targetId: image.id,
          });
          refetchImages();
        } catch (error) {
          void runLogger.log({
            source: "image",
            level: "error",
            action: "image.setDefault",
            result: "failure",
            title: "默认镜像更新失败",
            targetName: imageName(image),
            targetId: image.id,
            error: errorMessage(error, "默认镜像更新失败"),
          });
          throw error;
        }
      },
    });
  };

  const downloadImage = (image: ImageRow) => {
    const filename = `${imageName(image)}.tar`;
    void imageApi
      .download(image.id)
      .then((blob) => saveBlob(blob, filename))
      .then(() => {
        toast.success("镜像已下载", filename);
        void runLogger.log({
          source: "image",
          level: "info",
          action: "image.download",
          result: "success",
          title: "镜像已下载",
          targetName: imageName(image),
          targetId: image.id,
        });
      })
      .catch((error) => {
        toast.error("镜像下载失败", error instanceof Error ? error.message : "请稍后重试");
        void runLogger.log({
          source: "image",
          level: "error",
          action: "image.download",
          result: "failure",
          title: "镜像下载失败",
          targetName: imageName(image),
          targetId: image.id,
          error: errorMessage(error, "镜像下载失败"),
        });
      });
  };

  const isLoading = custom.isLoading || system.isLoading;
  const isFetching = custom.isFetching || system.isFetching;
  const customCount = custom.data?.items.length ?? 0;
  const systemCount = system.data?.items.length ?? 0;
  const defaultCount = images.filter(isDefaultImage).length;

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <div className="border-b border-app-border bg-app-surface px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-xs text-app-muted">自定义镜像</div>
              <div className="mt-1 text-xl font-semibold text-app-text">{customCount}</div>
            </div>
            <div>
              <div className="text-xs text-app-muted">系统镜像</div>
              <div className="mt-1 text-xl font-semibold text-app-text">{systemCount}</div>
            </div>
            <div>
              <div className="text-xs text-app-muted">默认标记</div>
              <div className="mt-1 text-xl font-semibold text-app-text">{defaultCount}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-b border-app-border bg-app-panel/50 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,360px)_160px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-muted" />
              <Input
                aria-label="搜索镜像名称、标签或说明"
                className="w-full pl-9"
                placeholder="搜索名称、标签或说明"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <Select aria-label="镜像来源" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
              <option value="all">全部来源</option>
              <option value="custom">自定义镜像</option>
              <option value="system">系统镜像</option>
            </Select>
          </div>
          <Button className="w-full sm:w-auto" variant="secondary" onClick={refetchImages} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            刷新
          </Button>
        </div>

        {isLoading ? (
          <TableSkeleton columns={6} />
        ) : custom.isError ? (
          <ErrorState error={custom.error} action={<Button variant="secondary" onClick={() => void custom.refetch()}>重试自定义镜像</Button>} />
        ) : system.isError ? (
          <ErrorState error={system.error} action={<Button variant="secondary" onClick={() => void system.refetch()}>重试系统镜像</Button>} />
        ) : images.length === 0 ? (
          <EmptyState title="暂无镜像" action={<Button variant="secondary" onClick={refetchImages}>重新加载</Button>} />
        ) : filteredImages.length === 0 ? (
          <EmptyState title="没有匹配的镜像" action={<Button variant="secondary" onClick={() => setKeyword("")}>清空搜索</Button>} />
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[980px] border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="border-b border-app-border px-3 py-2 font-medium">名称</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">来源</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">标签</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">说明</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">更新时间</th>
                  <th className="sticky right-0 border-b border-app-border bg-app-panel px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredImages.map((image) => (
                  <tr key={`${image.source}-${String(image.id)}`} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="px-3 py-2 align-middle">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-app-text">{imageName(image)}</span>
                        {isDefaultImage(image) ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-app-success/30 bg-app-success/10 px-2 py-0.5 text-xs font-medium text-app-success">
                            <Star className="h-3 w-3" />
                            默认
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-app-muted">ID: {String(image.id)}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <span className="inline-flex rounded-md border border-app-border bg-app-surface px-2 py-0.5 text-xs text-app-muted">
                        {image.source === "system" ? "系统镜像" : "自定义镜像"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{imageVersion(image)}</td>
                    <td className="max-w-xl px-3 py-2 align-middle text-app-muted">
                      <div className="truncate" title={imageDescription(image)}>
                        {imageDescription(image)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{getImageUpdatedAt(image)}</td>
                    <td className="sticky right-0 bg-app-surface px-3 py-2 align-middle shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.35)]">
                      <div className="flex justify-end gap-1">
                        <Button aria-label={`将 ${imageName(image)} 设为默认镜像`} variant="ghost" title="设为默认" onClick={() => setDefaultImage(image)}>
                          <Star className="h-4 w-4" />
                        </Button>
                        <Button aria-label={`下载镜像 ${imageName(image)}`} variant="ghost" title="下载" onClick={() => downloadImage(image)}>
                          <Download className="h-4 w-4" />
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
      {confirmDialog}
    </div>
  );
}
