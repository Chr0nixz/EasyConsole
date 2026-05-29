import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState, ErrorState, TableSkeleton } from "../components/DataState";
import { Button, Input, Panel, Select, TableRegion } from "../components/ui";
import { imageApi } from "../lib/api";
import { useDownloadQueue } from "../lib/download-queue-context";
import { useI18n } from "../lib/i18n";
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
  const { text } = useI18n();
  const runLogger = useRunLogger();
  const downloadQueue = useDownloadQueue();
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
      title: text("确认设置默认镜像", "Confirm Default Image"),
      description: text(`将 ${imageName(image)} 设置为默认镜像。新建任务选择镜像时会优先使用它。`, `Set ${imageName(image)} as the default image. It will be preferred when creating tasks.`),
      confirmLabel: text("设为默认", "Set default"),
      run: async () => {
        try {
          await imageApi.setDefault(image.id);
          toast.success(text("默认镜像已更新", "Default image updated"), imageName(image));
          void runLogger.log({
            source: "image",
            level: "info",
            action: "image.setDefault",
            result: "success",
            title: text("默认镜像已更新", "Default image updated"),
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
            title: text("默认镜像更新失败", "Failed to update default image"),
            targetName: imageName(image),
            targetId: image.id,
            error: errorMessage(error, text("默认镜像更新失败", "Failed to update default image")),
          });
          throw error;
        }
      },
    });
  };

  const downloadImage = (image: ImageRow) => {
    const filename = `${imageName(image)}.tar`;
    downloadQueue.enqueue({
      source: "image",
      sourceLabel: text("镜像", "Image"),
      filename,
      targetName: imageName(image),
      targetId: image.id,
      successTitle: text("镜像已下载", "Image downloaded"),
      failureTitle: text("镜像下载失败", "Image download failed"),
      action: "image.download",
      request: ({ signal, onProgress }) => imageApi.download(image.id, { signal, onProgress }),
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
              <div className="text-xs text-app-muted">{text("自定义镜像", "Custom images")}</div>
              <div className="mt-1 text-xl font-semibold text-app-text">{customCount}</div>
            </div>
            <div>
              <div className="text-xs text-app-muted">{text("系统镜像", "System images")}</div>
              <div className="mt-1 text-xl font-semibold text-app-text">{systemCount}</div>
            </div>
            <div>
              <div className="text-xs text-app-muted">{text("默认标记", "Default markers")}</div>
              <div className="mt-1 text-xl font-semibold text-app-text">{defaultCount}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-b border-app-border bg-app-panel/50 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,360px)_160px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-muted" />
              <Input
                aria-label={text("搜索镜像名称、标签或说明", "Search image name, tag, or description")}
                className="w-full pl-9"
                placeholder={text("搜索名称、标签或说明", "Search name, tag, or description")}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <Select aria-label={text("镜像来源", "Image source")} value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
              <option value="all">{text("全部来源", "All sources")}</option>
              <option value="custom">{text("自定义镜像", "Custom images")}</option>
              <option value="system">{text("系统镜像", "System images")}</option>
            </Select>
          </div>
          <Button className="w-full sm:w-auto" variant="secondary" onClick={refetchImages} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            {text("刷新", "Refresh")}
          </Button>
        </div>

        {isLoading ? (
          <TableSkeleton columns={6} />
        ) : custom.isError ? (
          <ErrorState error={custom.error} action={<Button variant="secondary" onClick={() => void custom.refetch()}>{text("重试自定义镜像", "Retry custom images")}</Button>} />
        ) : system.isError ? (
          <ErrorState error={system.error} action={<Button variant="secondary" onClick={() => void system.refetch()}>{text("重试系统镜像", "Retry system images")}</Button>} />
        ) : images.length === 0 ? (
          <EmptyState title={text("暂无镜像", "No images")} action={<Button variant="secondary" onClick={refetchImages}>{text("重新加载", "Reload")}</Button>} />
        ) : filteredImages.length === 0 ? (
          <EmptyState title={text("没有匹配的镜像", "No matching images")} action={<Button variant="secondary" onClick={() => setKeyword("")}>{text("清空搜索", "Clear search")}</Button>} />
        ) : (
          <TableRegion label={text("镜像表格", "Images table")}>
            <table className="w-full min-w-[980px] border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("名称", "Name")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("来源", "Source")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("标签", "Tag")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("说明", "Description")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("更新时间", "Updated")}</th>
                  <th className="sticky right-0 border-b border-app-border bg-app-panel px-3 py-2 text-right font-medium" scope="col">{text("操作", "Actions")}</th>
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
                            {text("默认", "Default")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-app-muted">ID: {String(image.id)}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <span className="inline-flex rounded-md border border-app-border bg-app-surface px-2 py-0.5 text-xs text-app-muted">
                        {image.source === "system" ? text("系统镜像", "System image") : text("自定义镜像", "Custom image")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{imageVersion(image)}</td>
                    <td className="max-w-xl px-3 py-2 align-middle text-app-muted">
                      <div className="truncate" title={imageDescription(image)}>
                        {imageDescription(image)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-muted">{getImageUpdatedAt(image)}</td>
                    <td className="sticky right-0 bg-app-surface px-3 py-2 align-middle shadow-stickyColumnSubtle">
                      <div className="flex justify-end gap-1">
                        <Button aria-label={text(`将 ${imageName(image)} 设为默认镜像`, `Set ${imageName(image)} as default image`)} variant="ghost" title={text("设为默认", "Set default")} onClick={() => setDefaultImage(image)}>
                          <Star className="h-4 w-4" />
                        </Button>
                        <Button aria-label={text(`下载镜像 ${imageName(image)}`, `Download image ${imageName(image)}`)} variant="ghost" title={text("下载", "Download")} onClick={() => downloadImage(image)}>
                          <Download className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        )}
      </Panel>
      {confirmDialog}
    </div>
  );
}
