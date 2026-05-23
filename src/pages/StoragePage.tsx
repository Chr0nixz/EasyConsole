import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderPlus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useMemo, useState, type ChangeEvent } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
import { Button, Input, Panel } from "../components/ui";
import { storageApi } from "../lib/api";
import { saveBlob } from "../lib/download";
import { formatBytes } from "../lib/format";
import type { StorageEntry } from "../lib/types";

function isDir(entry: StorageEntry) {
  return entry.is_dir || entry.type === "dir";
}

function joinPath(path: string, name: string) {
  if (path === "/") return `/${name}`;
  return `${path.replace(/\/$/, "")}/${name}`;
}

function breadcrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return [
    { label: "根目录", path: "/" },
    ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` })),
  ];
}

export function StoragePage() {
  const queryClient = useQueryClient();
  const [path, setPath] = useState("/");
  const [mkdirName, setMkdirName] = useState("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const crumbs = useMemo(() => breadcrumbs(path), [path]);
  const query = useQuery({ queryKey: ["storage", path], queryFn: () => storageApi.list({ path }) });
  const entries = query.data?.items ?? [];

  const mkdirMutation = useMutation({
    mutationFn: () => storageApi.mkdir(joinPath(path, mkdirName)),
    onSuccess: () => {
      setMkdirName("");
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: StorageEntry) => storageApi.delete(entry.path ?? joinPath(path, entry.name)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storage"] }),
  });

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadPercent(0);
    await storageApi.uploadFile(file, path, (progress) => setUploadPercent(progress.percent));
    setUploadPercent(null);
    queryClient.invalidateQueries({ queryKey: ["storage"] });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs.map((crumb, index) => (
            <button key={crumb.path} className="rounded px-2 py-1 text-app-muted hover:bg-app-panel hover:text-app-text" onClick={() => setPath(crumb.path)}>
              {index > 0 ? "/ " : ""}
              {crumb.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input className="w-40" placeholder="新目录名" value={mkdirName} onChange={(event) => setMkdirName(event.target.value)} />
          <Button variant="secondary" disabled={!mkdirName || mkdirMutation.isPending} onClick={() => mkdirMutation.mutate()}>
            <FolderPlus className="h-4 w-4" />
            新建
          </Button>
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-app-accent px-3 text-sm font-medium text-white hover:brightness-95">
            <Upload className="h-4 w-4" />
            上传
            <input className="sr-only" type="file" onChange={(event) => void upload(event)} />
          </label>
          <Button variant="secondary" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      {uploadPercent !== null ? (
        <div className="rounded-md border border-app-border bg-app-surface px-3 py-2 text-sm text-app-muted">上传进度 {uploadPercent}%</div>
      ) : null}

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} />
        ) : entries.length === 0 ? (
          <EmptyState title="当前目录为空" />
        ) : (
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="bg-app-panel text-left text-xs text-app-muted">
              <tr>
                <th className="border-b border-app-border px-3 py-2 font-medium">名称</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">类型</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">大小</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">更新时间</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path ?? entry.name} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                  <td className="px-3 py-2">
                    <button
                      className="font-medium text-app-text hover:text-app-accent disabled:cursor-default disabled:text-app-text"
                      disabled={!isDir(entry)}
                      onClick={() => setPath(entry.path ?? joinPath(path, entry.name))}
                    >
                      {entry.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-app-muted">{isDir(entry) ? "目录" : "文件"}</td>
                  <td className="px-3 py-2 text-app-muted">{formatBytes(entry.size)}</td>
                  <td className="px-3 py-2 text-app-muted">{entry.modified ?? "-"}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        title="下载"
                        onClick={() =>
                          void storageApi
                            .transmit({ path: entry.path ?? joinPath(path, entry.name) })
                            .then((blob) => {
                              if (blob instanceof Blob) saveBlob(blob, entry.name);
                            })
                        }
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" title="删除" onClick={() => deleteMutation.mutate(entry)}>
                        <Trash2 className="h-4 w-4 text-app-danger" />
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
