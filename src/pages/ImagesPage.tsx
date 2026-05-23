import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Star } from "lucide-react";

import { EmptyState, ErrorState, TableSkeleton } from "../components/DataState";
import { Button, Panel } from "../components/ui";
import { imageApi } from "../lib/api";
import { saveBlob } from "../lib/download";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useToast } from "../lib/use-toast";

export function ImagesPage() {
  const toast = useToast();
  const { confirm, confirmDialog } = useConfirmAction();
  const custom = useQuery({ queryKey: ["images"], queryFn: () => imageApi.list({ page: 1, page_size: 100 }) });
  const system = useQuery({ queryKey: ["images", "system"], queryFn: () => imageApi.system({}) });
  const images = [...(custom.data?.items ?? []), ...(system.data?.items ?? [])];

  const refetchImages = () => {
    void custom.refetch();
    void system.refetch();
  };

  const imageName = (image: (typeof images)[number]) => String(image.name ?? image.image_name ?? image.id);

  const setDefaultImage = (image: (typeof images)[number]) => {
    confirm({
      title: "确认设置默认镜像",
      description: `将 ${imageName(image)} 设置为默认镜像。`,
      confirmLabel: "设为默认",
      run: async () => {
        await imageApi.setDefault(image.id);
        toast.success("默认镜像已更新", imageName(image));
        refetchImages();
      },
    });
  };

  const downloadImage = (image: (typeof images)[number]) => {
    const filename = `${imageName(image)}.tar`;
    void imageApi
      .download(image.id)
      .then((blob) => saveBlob(blob, filename))
      .then(() => toast.success("镜像已下载", filename))
      .catch((error) => {
        toast.error("镜像下载失败", error instanceof Error ? error.message : "请稍后重试");
      });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          className="w-full sm:w-auto"
          variant="secondary"
          onClick={refetchImages}
        >
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>
      <Panel className="overflow-hidden">
        {custom.isLoading || system.isLoading ? (
          <TableSkeleton columns={4} />
        ) : custom.isError ? (
          <ErrorState error={custom.error} />
        ) : images.length === 0 ? (
          <EmptyState title="暂无镜像" />
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="border-b border-app-border px-3 py-2 font-medium">名称</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">标签</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">说明</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {images.map((image) => (
                  <tr key={String(image.id)} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="px-3 py-2 font-medium">{imageName(image)}</td>
                    <td className="px-3 py-2 text-app-muted">{image.tag ?? "-"}</td>
                    <td className="max-w-xl truncate px-3 py-2 text-app-muted">{image.description ?? "-"}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
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
