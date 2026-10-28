import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Download, Eye, Pencil, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, SearchXIcon, TableSkeleton } from "../components/DataState";
import { ImageDetailDialog } from "../components/images/ImageDetailDialog";
import { Button, Dialog, Input, Panel, Select, SettingTag, TableRegion } from "../components/ui";
import { imageApi } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { useDownloadQueue } from "../lib/use-download-queue";
import { loadFavoriteImages, toggleFavoriteImage } from "../lib/image-favorites";
import { useI18n } from "../lib/i18n";
import type { ImageItem } from "../lib/types";
import { useCompactLayout } from "../lib/use-compact-layout";
import { browserRuntime } from "../lib/runtime";
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
  const compactLayout = useCompactLayout();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [detailImage, setDetailImage] = useState<{ id: string | number; name: string } | null>(null);
  const [editImage, setEditImage] = useState<ImageRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const custom = useQuery({
    queryKey: queryKeys.images.list(),
    queryFn: ({ signal }) => imageApi.list({ page: 1, page_size: 100 }, { signal }),
  });
  const system = useQuery({
    queryKey: queryKeys.images.system(),
    queryFn: ({ signal }) => imageApi.system({}, { signal }),
  });

  useEffect(() => {
    void loadFavoriteImages(browserRuntime.storage).then(setFavorites);
  }, []);

  async function handleToggleFavorite(image: ImageRow) {
    const next = await toggleFavoriteImage(browserRuntime.storage, image.id);
    setFavorites(next);
  }

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
      const matchesFavorite = !favoritesOnly || favorites.includes(String(image.id));
      return matchesSource && matchesKeyword && matchesFavorite;
    });
  }, [images, keyword, sourceFilter, favoritesOnly, favorites]);

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
          toast.error(text("默认镜像更新失败", "Failed to update default image"), errorMessage(error, text("请稍后重试", "Try again later")));
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

  const deleteImageRow = (image: ImageRow) => {
    confirm({
      title: text("确认删除镜像", "Confirm Image Deletion"),
      description: text(
        `将删除自定义镜像 ${imageName(image)}。使用该镜像创建实例的能力将一并移除，此操作不可从 EasyConsole 撤销。`,
        `Delete the custom image ${imageName(image)}. Instances can no longer be created from it; EasyConsole cannot undo this.`,
      ),
      confirmLabel: text("删除镜像", "Delete image"),
      tone: "danger",
      run: async () => {
        try {
          await imageApi.deleteImage(image.id);
          toast.success(text("镜像已删除", "Image deleted"), imageName(image));
          void runLogger.log({
            source: "image",
            level: "info",
            action: "image.delete",
            result: "success",
            title: text("镜像已删除", "Image deleted"),
            targetName: imageName(image),
            targetId: image.id,
          });
          refetchImages();
        } catch (error) {
          void runLogger.log({
            source: "image",
            level: "error",
            action: "image.delete",
            result: "failure",
            title: text("镜像删除失败", "Failed to delete image"),
            targetName: imageName(image),
            targetId: image.id,
            error: errorMessage(error, text("镜像删除失败", "Failed to delete image")),
          });
          toast.error(text("镜像删除失败", "Failed to delete image"), errorMessage(error, text("请稍后重试", "Try again later")));
        }
      },
    });
  };

  const openEditImage = (image: ImageRow) => {
    setEditImage(image);
    setEditName(typeof image.name === "string" ? image.name : imageName(image));
    setEditDescription(typeof image.description === "string" ? image.description : "");
  };

  const submitEditImage = async () => {
    if (!editImage || editSaving) return;
    const trimmedName = editName.trim();
    if (!trimmedName) {
      toast.error(text("请填写镜像名称", "Enter an image name"));
      return;
    }
    setEditSaving(true);
    try {
      await imageApi.updateImage(editImage.id, { name: trimmedName, description: editDescription.trim() });
      toast.success(text("镜像已更新", "Image updated"), trimmedName);
      void runLogger.log({
        source: "image",
        level: "info",
        action: "image.update",
        result: "success",
        title: text("镜像已更新", "Image updated"),
        targetName: trimmedName,
        targetId: editImage.id,
      });
      setEditImage(null);
      refetchImages();
    } catch (error) {
      toast.error(
        text("镜像更新失败", "Failed to update image"),
        `${trimmedName}: ${errorMessage(error, text("镜像更新失败", "Failed to update image"))}`,
      );
      void runLogger.log({
        source: "image",
        level: "error",
        action: "image.update",
        result: "failure",
        title: text("镜像更新失败", "Failed to update image"),
        targetName: trimmedName,
        targetId: editImage.id,
        error: errorMessage(error, text("镜像更新失败", "Failed to update image")),
      });
    } finally {
      setEditSaving(false);
    }
  };

  const isLoading = custom.isLoading || system.isLoading;
  const isFetching = custom.isFetching || system.isFetching;
  const customCount = custom.data?.items.length ?? 0;
  const systemCount = system.data?.items.length ?? 0;
  const defaultCount = images.filter(isDefaultImage).length;

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-app-border bg-app-panel/50 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="app-numeric shrink-0 whitespace-nowrap text-sm text-app-muted">
            {text(
              `自定义 ${customCount} · 系统 ${systemCount} · 默认 ${defaultCount}`,
              `Custom ${customCount} · system ${systemCount} · default ${defaultCount}`,
            )}
          </p>
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(180px,360px)_150px_auto]">
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
            <label className="app-interactive inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-app-borderStrong bg-app-surface px-3 text-sm text-app-text shadow-raised hover:border-app-muted">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-app-accent"
                checked={favoritesOnly}
                onChange={(event) => setFavoritesOnly(event.target.checked)}
              />
              <Star className={cn("h-4 w-4", favoritesOnly ? "fill-current text-app-text" : "text-app-muted")} />
              <span className="whitespace-nowrap">{text("仅看收藏", "Favorites only")}</span>
            </label>
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
          <EmptyState icon={SearchXIcon} title={text("没有匹配的镜像", "No matching images")} action={<Button variant="secondary" onClick={() => setKeyword("")}>{text("清空搜索", "Clear search")}</Button>} />
        ) : (
          <>
          {compactLayout ? (
          <div className="divide-y divide-app-border">
            {filteredImages.map((image) => {
              const cardId = `image-card-${String(image.id)}`;
              return (
                <article key={`${image.source}-${String(image.id)}`} className="space-y-3 px-3 py-3" aria-labelledby={cardId}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span id={cardId} className="truncate text-sm font-semibold text-app-text">{imageName(image)}</span>
                        {isDefaultImage(image) ? (
                          <SettingTag className="shrink-0" icon={BadgeCheck}>{text("默认", "Default")}</SettingTag>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-app-muted">ID: {String(image.id)}</div>
                    </div>
                    <span className="inline-flex shrink-0 rounded-md border border-app-border bg-app-surface px-2 py-0.5 text-xs text-app-muted">
                      {image.source === "system" ? text("系统镜像", "System image") : text("自定义镜像", "Custom image")}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div>
                      <dt className="text-app-muted">{text("标签", "Tag")}</dt>
                      <dd className="mt-0.5 text-app-text">{imageVersion(image)}</dd>
                    </div>
                    <div>
                      <dt className="text-app-muted">{text("更新时间", "Updated")}</dt>
                      <dd className="app-numeric mt-0.5 text-app-text">{getImageUpdatedAt(image)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-app-muted">{text("说明", "Description")}</dt>
                      <dd className="mt-0.5 truncate text-app-text" title={imageDescription(image)}>{imageDescription(image)}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      aria-label={text(`收藏 ${imageName(image)}`, `Favorite ${imageName(image)}`)}
                      aria-pressed={favorites.includes(String(image.id))}
                      variant="ghost"
                      title={favorites.includes(String(image.id)) ? text("取消收藏", "Unfavorite") : text("收藏", "Favorite")}
                      onClick={() => void handleToggleFavorite(image)}
                    >
                      <Star className={cn("h-4 w-4", favorites.includes(String(image.id)) && "fill-current text-app-text")} />
                      {favorites.includes(String(image.id)) ? text("已收藏", "Favorited") : text("收藏", "Favorite")}
                    </Button>
                    <Button
                      aria-label={text(`查看 ${imageName(image)} 详情`, `View ${imageName(image)} details`)}
                      variant="ghost"
                      title={text("详情", "Details")}
                      onClick={() => setDetailImage({ id: image.id, name: imageName(image) })}
                    >
                      <Eye className="h-4 w-4" />
                      {text("详情", "Details")}
                    </Button>
                    <Button
                      aria-label={text(`将 ${imageName(image)} 设为默认镜像`, `Set ${imageName(image)} as default image`)}
                      disabled={isDefaultImage(image)}
                      disabledReason={text("已是默认镜像", "Already the default image")}
                      variant="ghost"
                      title={text("设为默认", "Set default")}
                      onClick={() => setDefaultImage(image)}
                    >
                      <BadgeCheck className="h-4 w-4" />
                      {text("设为默认", "Set default")}
                    </Button>
                    <Button
                      aria-label={text(`下载镜像 ${imageName(image)}`, `Download image ${imageName(image)}`)}
                      variant="ghost"
                      title={text("下载", "Download")}
                      onClick={() => downloadImage(image)}
                    >
                      <Download className="h-4 w-4" />
                      {text("下载", "Download")}
                    </Button>
                    {image.source === "custom" ? (
                      <>
                        <Button
                          aria-label={text(`编辑镜像 ${imageName(image)}`, `Edit image ${imageName(image)}`)}
                          variant="ghost"
                          title={text("编辑", "Edit")}
                          onClick={() => openEditImage(image)}
                        >
                          <Pencil className="h-4 w-4" />
                          {text("编辑", "Edit")}
                        </Button>
                        <Button
                          aria-label={text(`删除镜像 ${imageName(image)}`, `Delete image ${imageName(image)}`)}
                          className="hover:bg-app-dangerSoft hover:text-app-danger focus-visible:text-app-danger"
                          variant="ghost"
                          title={text("删除", "Delete")}
                          onClick={() => deleteImageRow(image)}
                        >
                          <Trash2 className="h-4 w-4" />
                          {text("删除", "Delete")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
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
                          <SettingTag className="shrink-0" icon={BadgeCheck}>{text("默认", "Default")}</SettingTag>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-app-text">ID: {String(image.id)}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <span className="inline-flex rounded-md border border-app-border bg-app-surface px-2 py-0.5 text-xs text-app-text">
                        {image.source === "system" ? text("系统镜像", "System image") : text("自定义镜像", "Custom image")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-app-text">{imageVersion(image)}</td>
                    <td className="max-w-xl px-3 py-2 align-middle text-app-text">
                      <div className="truncate" title={imageDescription(image)}>
                        {imageDescription(image)}
                      </div>
                    </td>
                    <td className="app-numeric whitespace-nowrap px-3 py-2 align-middle text-app-text">{getImageUpdatedAt(image)}</td>
                    <td className="sticky right-0 bg-app-surface px-3 py-2 align-middle shadow-stickyColumnSubtle">
                      <div className="flex justify-end gap-1">
                        <Button
                          aria-label={text(`收藏 ${imageName(image)}`, `Favorite ${imageName(image)}`)}
                          aria-pressed={favorites.includes(String(image.id))}
                          variant="ghost"
                          title={favorites.includes(String(image.id)) ? text("取消收藏", "Unfavorite") : text("收藏", "Favorite")}
                          onClick={() => void handleToggleFavorite(image)}
                        >
                          <Star className={cn("h-4 w-4", favorites.includes(String(image.id)) && "fill-current text-app-text")} />
                        </Button>
                        <Button
                          aria-label={text(`查看 ${imageName(image)} 详情`, `View ${imageName(image)} details`)}
                          variant="ghost"
                          title={text("详情", "Details")}
                          onClick={() => setDetailImage({ id: image.id, name: imageName(image) })}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button aria-label={text(`将 ${imageName(image)} 设为默认镜像`, `Set ${imageName(image)} as default image`)} disabled={isDefaultImage(image)} disabledReason={text("已是默认镜像", "Already the default image")} variant="ghost" title={text("设为默认", "Set default")} onClick={() => setDefaultImage(image)}>
                          <BadgeCheck className="h-4 w-4" />
                        </Button>
                        <Button aria-label={text(`下载镜像 ${imageName(image)}`, `Download image ${imageName(image)}`)} variant="ghost" title={text("下载", "Download")} onClick={() => downloadImage(image)}>
                          <Download className="h-4 w-4" />
                        </Button>
                        {image.source === "custom" ? (
                          <>
                            <Button aria-label={text(`编辑镜像 ${imageName(image)}`, `Edit image ${imageName(image)}`)} variant="ghost" title={text("编辑", "Edit")} onClick={() => openEditImage(image)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button aria-label={text(`删除镜像 ${imageName(image)}`, `Delete image ${imageName(image)}`)} className="hover:bg-app-dangerSoft hover:text-app-danger focus-visible:text-app-danger" variant="ghost" title={text("删除", "Delete")} onClick={() => deleteImageRow(image)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
          )}
          </>
        )}
      </Panel>
      {confirmDialog}
      <ImageDetailDialog imageId={detailImage?.id ?? null} imageName={detailImage?.name} onClose={() => setDetailImage(null)} />
      <Dialog
        open={Boolean(editImage)}
        title={text("编辑镜像", "Edit image")}
        onClose={() => { if (!editSaving) setEditImage(null); }}
        width="max-w-md"
        describedBy="image-edit-description"
      >
        <form
          className="space-y-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitEditImage();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-app-text">{text("名称", "Name")}</span>
            <Input className="w-full" value={editName} onChange={(event) => setEditName(event.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-app-text">{text("说明", "Description")}</span>
            <Input className="w-full" value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder={text("可选", "Optional")} />
          </label>
          <p id="image-edit-description" className="text-xs leading-5 text-app-muted">
            {text(
              "修改自定义镜像的名称和说明。保存失败时会保留输入，便于重试。",
              "Change the custom image's name and description. Failed saves keep your input so you can retry.",
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button disabled={editSaving} type="button" variant="ghost" onClick={() => setEditImage(null)}>
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={editSaving} type="submit">
              {editSaving ? text("保存中…", "Saving…") : text("保存", "Save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
