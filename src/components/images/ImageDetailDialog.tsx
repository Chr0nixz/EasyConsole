import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { ErrorState, LoadingState } from "../DataState";
import { Dialog } from "../ui";
import { imageApi } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import type { ImageItem, UnknownRecord } from "../../lib/types";

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isPlainKey(key: string) {
  return !["id", "name", "image_name", "tag", "description", "source"].includes(key);
}

export function ImageDetailDialog({ imageId, imageName, onClose }: { imageId: string | number | null; imageName?: string; onClose: () => void }) {
  const { text } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const query = useQuery({
    queryKey: ["image-detail", imageId],
    queryFn: () => imageApi.detail(imageId!),
    enabled: imageId !== null,
  });

  const detail: ImageItem | undefined = query.data;
  const extraEntries = detail ? Object.entries(detail as UnknownRecord).filter(([key]) => isPlainKey(key)) : [];

  return (
    <Dialog open={imageId !== null} title={text(`镜像详情 ${imageName ?? ""}`, `Image Detail ${imageName ?? ""}`)} onClose={onClose} width="max-w-3xl">
      {query.isLoading ? (
        <LoadingState label={text("正在加载镜像详情", "Loading image detail")} />
      ) : query.isError ? (
        <ErrorState error={query.error} />
      ) : detail ? (
        <div className="space-y-4 p-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-app-muted">{text("名称", "Name")}</dt>
              <dd className="mt-0.5 text-sm text-app-text">{formatValue(detail.name ?? detail.image_name)}</dd>
            </div>
            <div>
              <dt className="text-xs text-app-muted">{text("ID", "ID")}</dt>
              <dd className="mt-0.5 text-sm text-app-text">{formatValue(detail.id)}</dd>
            </div>
            <div>
              <dt className="text-xs text-app-muted">{text("标签", "Tag")}</dt>
              <dd className="mt-0.5 text-sm text-app-text">{formatValue(detail.tag)}</dd>
            </div>
            <div>
              <dt className="text-xs text-app-muted">{text("说明", "Description")}</dt>
              <dd className="mt-0.5 text-sm text-app-text">{formatValue(detail.description)}</dd>
            </div>
            <div>
              <dt className="text-xs text-app-muted">{text("创建时间", "Created")}</dt>
              <dd className="mt-0.5 text-sm text-app-text">{formatValue(detail.create_time ?? detail.created_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-app-muted">{text("更新时间", "Updated")}</dt>
              <dd className="mt-0.5 text-sm text-app-text">{formatValue(detail.update_time)}</dd>
            </div>
          </dl>

          {extraEntries.length > 0 ? (
            <div>
              <button className="flex items-center gap-1 text-xs font-medium text-app-muted hover:text-app-text" type="button" onClick={() => setShowRaw((value) => !value)}>
                {showRaw ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {text("更多字段", "More fields")}
              </button>
              {showRaw ? (
                <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                  {extraEntries.map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-xs text-app-muted">{key}</dt>
                      <dd className="mt-0.5 break-all text-sm text-app-text">{formatValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
