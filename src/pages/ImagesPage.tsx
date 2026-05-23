import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Star } from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { Button, Panel } from "../components/ui";
import { imageApi } from "../lib/api";
import { saveBlob } from "../lib/download";

export function ImagesPage() {
  const custom = useQuery({ queryKey: ["images"], queryFn: () => imageApi.list({ page: 1, page_size: 100 }) });
  const system = useQuery({ queryKey: ["images", "system"], queryFn: () => imageApi.system({}) });
  const images = [...(custom.data?.items ?? []), ...(system.data?.items ?? [])];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="secondary"
          onClick={() => {
            void custom.refetch();
            void system.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>
      <Panel className="overflow-hidden">
        {custom.isLoading || system.isLoading ? (
          <LoadingState />
        ) : custom.isError ? (
          <ErrorState error={custom.error} />
        ) : images.length === 0 ? (
          <EmptyState title="暂无镜像" />
        ) : (
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
                  <td className="px-3 py-2 font-medium">{image.name ?? image.image_name ?? image.id}</td>
                  <td className="px-3 py-2 text-app-muted">{image.tag ?? "-"}</td>
                  <td className="max-w-xl truncate px-3 py-2 text-app-muted">{image.description ?? "-"}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button variant="ghost" title="设为默认" onClick={() => void imageApi.setDefault(image.id)}>
                        <Star className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        title="下载"
                        onClick={() =>
                          void imageApi.download(image.id).then((blob) => saveBlob(blob, `${image.name ?? image.image_name ?? image.id}.tar`))
                        }
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
