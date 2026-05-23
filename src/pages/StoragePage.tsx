import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileText, Folder, FolderOpen, FolderPlus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import { EmptyState, ErrorState, TableSkeleton } from "../components/DataState";
import { Button, Dialog, Input, Panel, Select } from "../components/ui";
import { saveBlob } from "../lib/download";
import { formatBytes } from "../lib/format";
import {
  getStorageBreadcrumbs,
  getStorageEntryPath,
  getStorageEntryModified,
  getStorageEntryModifiedTime,
  getStorageEntrySize,
  isStorageDirectory,
  joinStoragePath,
  remoteStorage,
} from "../lib/remote-storage";
import { createUploadQueueItems, summarizeUploadQueue } from "../lib/upload-queue";
import type { StorageEntry, UploadQueueItem } from "../lib/types";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useToast } from "../lib/use-toast";

type StorageSortField = "name" | "size" | "modified" | "type";
type StorageSortDirection = "asc" | "desc";

function compareText(left: string, right: string) {
  return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
}

function getDirectoryDownloadName(entry: StorageEntry) {
  return entry.name.toLowerCase().endsWith(".zip") ? entry.name : `${entry.name}.zip`;
}

export function StoragePage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { confirm, confirmDialog } = useConfirmAction();
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadCancelledRef = useRef(false);
  const [path, setPath] = useState("/");
  const [mkdirName, setMkdirName] = useState("");
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [sortField, setSortField] = useState<StorageSortField>("name");
  const [sortDirection, setSortDirection] = useState<StorageSortDirection>("asc");
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const [directorySizes, setDirectorySizes] = useState<Record<string, { status: "done" | "loading" | "error"; size?: number; error?: string }>>({});
  const crumbs = useMemo(() => getStorageBreadcrumbs(path), [path]);
  const query = useQuery({ queryKey: ["storage", path], queryFn: () => remoteStorage.list({ path }) });
  const entries = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const uploadSummary = useMemo(() => summarizeUploadQueue(uploadQueue), [uploadQueue]);
  const visibleEntries = useMemo(() => {
    const normalizedKeyword = searchKeyword.trim().toLowerCase();
    const entrySizeForSort = (entry: StorageEntry) => {
      const entryPath = getStorageEntryPath(entry, path);
      if (isStorageDirectory(entry, path)) return directorySizes[entryPath]?.size ?? getStorageEntrySize(entry) ?? -1;
      return getStorageEntrySize(entry) ?? -1;
    };
    return entries
      .filter((entry) => {
        if (!normalizedKeyword) return true;
        return [entry.name, entry.path].some((value) => String(value ?? "").toLowerCase().includes(normalizedKeyword));
      })
      .sort((left, right) => {
        const leftDirectory = isStorageDirectory(left, path);
        const rightDirectory = isStorageDirectory(right, path);
        if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;

        let result = 0;
        if (sortField === "name") result = compareText(left.name, right.name);
        if (sortField === "type") result = compareText(leftDirectory ? "目录" : "文件", rightDirectory ? "目录" : "文件") || compareText(left.name, right.name);
        if (sortField === "size") result = entrySizeForSort(left) - entrySizeForSort(right) || compareText(left.name, right.name);
        if (sortField === "modified") result = getStorageEntryModifiedTime(left) - getStorageEntryModifiedTime(right) || compareText(left.name, right.name);
        return sortDirection === "asc" ? result : -result;
      });
  }, [directorySizes, entries, path, searchKeyword, sortDirection, sortField]);

  const mkdirMutation = useMutation({
    mutationFn: () => remoteStorage.createDirectory(joinStoragePath(path, mkdirName)),
    onSuccess: () => {
      setMkdirName("");
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: StorageEntry) => remoteStorage.remove(getStorageEntryPath(entry, path), isStorageDirectory(entry, path)),
    onSuccess: (_data, entry) => {
      toast.success("远程文件已删除", entry.name);
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (error, entry) => {
      toast.error("远程删除失败", `${entry.name}：${error instanceof Error ? error.message : "请稍后重试"}`);
    },
  });

  const previewMutation = useMutation({
    mutationFn: (entry: StorageEntry) => remoteStorage.readTextFile(getStorageEntryPath(entry, path)),
    onSuccess: (content, entry) => setPreview({ title: entry.name, content }),
    onError: (error, entry) => {
      toast.error("读取远程文件失败", `${entry.name}：${error instanceof Error ? error.message : "请稍后重试"}`);
    },
  });

  async function runUploadQueue(items: UploadQueueItem[]) {
    uploadCancelledRef.current = false;
    setUploadQueue(items);
    try {
      const directories = [...new Set(items.filter((item) => item.status !== "skipped").map((item) => item.remoteDirectory))]
        .filter((directory) => directory !== "/")
        .sort((left, right) => left.split("/").length - right.split("/").length);
      for (const directory of directories) {
        try {
          await remoteStorage.createDirectory(directory);
        } catch {
          // Existing directories can be reused during recursive uploads.
        }
      }
      for (const item of items) {
        if (item.status === "skipped") continue;
        if (uploadCancelledRef.current) {
          setUploadQueue((current) =>
            current.map((queueItem) => (queueItem.status === "queued" ? { ...queueItem, status: "cancelled" } : queueItem)),
          );
          break;
        }
        setUploadQueue((current) =>
          current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, status: "uploading", progress: 1, error: undefined } : queueItem)),
        );
        try {
          await remoteStorage.uploadLocalFile(item.file, item.remoteDirectory, (progress) => {
            setUploadQueue((current) =>
              current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, progress: progress.percent } : queueItem)),
            );
          });
          setUploadQueue((current) =>
            current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, status: "done", progress: 100 } : queueItem)),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "上传失败";
          setUploadQueue((current) =>
            current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, status: "failed", error: message } : queueItem)),
          );
        }
      }
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      toast.success("上传队列已处理", `${items.length} 个文件`);
    } finally {
      uploadCancelledRef.current = false;
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await runUploadQueue(createUploadQueueItems([file], path));
    } finally {
      event.target.value = "";
    }
  }

  async function uploadFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    try {
      await runUploadQueue(createUploadQueueItems(files, path));
    } finally {
      event.target.value = "";
    }
  }

  function retryFailedUploads() {
    const failed = uploadQueue.filter((item) => item.status === "failed").map((item) => ({ ...item, status: "queued" as const, progress: 0, error: undefined }));
    if (failed.length === 0) return;
    void runUploadQueue(failed);
  }

  function cancelPendingUploads() {
    uploadCancelledRef.current = true;
    setUploadQueue((items) => items.map((item) => (item.status === "queued" ? { ...item, status: "cancelled" } : item)));
  }

  function openFolderUploadDialog() {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.click();
  }

  function createDirectory() {
    if (!mkdirName.trim()) return;
    mkdirMutation.mutate(undefined, {
      onSuccess: () => setMkdirOpen(false),
    });
  }

  function calculateDirectorySize(entryPath: string) {
    setDirectorySizes((current) => ({ ...current, [entryPath]: { status: "loading" } }));
    void remoteStorage
      .getDirectorySize(entryPath)
      .then((size) => {
        setDirectorySizes((current) => ({ ...current, [entryPath]: { status: "done", size } }));
      })
      .catch((error) => {
        setDirectorySizes((current) => ({
          ...current,
          [entryPath]: { status: "error", error: error instanceof Error ? error.message : "计算失败" },
        }));
      });
  }

  function confirmDeleteEntry(entry: StorageEntry) {
    const entryPath = getStorageEntryPath(entry, path);
    confirm({
      title: "确认删除远程路径",
      description: `将删除 ${entryPath}，此操作不可从 EasyConsole 撤销。`,
      confirmLabel: "删除",
      tone: "danger",
      run: () => deleteMutation.mutateAsync(entry),
    });
  }

  function downloadEntry(entry: StorageEntry, entryPath: string) {
    const directory = isStorageDirectory(entry, path);
    const download = directory ? remoteStorage.downloadRemotePath(entryPath) : remoteStorage.downloadRemoteFile(entryPath);
    const filename = directory ? getDirectoryDownloadName(entry) : entry.name;
    void download
      .then((blob) => saveBlob(blob, filename))
      .then(() => toast.success("远程文件已下载", filename))
      .catch((error) => {
        toast.error("远程下载失败", error instanceof Error ? error.message : "请稍后重试");
      });
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input className="w-52 pl-9" placeholder="搜索文件或文件夹" value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} />
          </div>
          <Select className="w-32" value={sortField} onChange={(event) => setSortField(event.target.value as StorageSortField)}>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
            <option value="modified">按时间</option>
            <option value="type">按类型</option>
          </Select>
          <Select className="w-28" value={sortDirection} onChange={(event) => setSortDirection(event.target.value as StorageSortDirection)}>
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </Select>
          <Button variant="secondary" onClick={() => setMkdirOpen(true)}>
            <FolderPlus className="h-4 w-4" />
            新建
          </Button>
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-app-accent px-3 text-sm font-medium text-white hover:brightness-95">
            <Upload className="h-4 w-4" />
            上传到远程
            <input className="sr-only" type="file" onChange={(event) => void upload(event)} />
          </label>
          <Button type="button" variant="secondary" onClick={openFolderUploadDialog}>
            <FolderOpen className="h-4 w-4" />
            上传文件夹
          </Button>
          <input
            ref={folderInputRef}
            className="sr-only"
            multiple
            type="file"
            onChange={(event) => void uploadFolder(event)}
          />
          <Button variant="secondary" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      {uploadQueue.length > 0 ? (
        <Panel className="space-y-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="text-app-muted">
              上传队列 {uploadSummary.completed}/{uploadSummary.total}，失败 {uploadSummary.failed}，跳过 {uploadSummary.skipped}
              {uploadSummary.cancelled ? `，取消 ${uploadSummary.cancelled}` : ""}
            </div>
            <div className="flex items-center gap-2">
              <Button disabled={!uploadSummary.active} type="button" variant="secondary" onClick={cancelPendingUploads}>
                取消后续
              </Button>
              <Button disabled={uploadSummary.failed === 0 || uploadSummary.active} type="button" variant="secondary" onClick={retryFailedUploads}>
                重试失败
              </Button>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded bg-app-panel">
            <div className="h-full bg-app-accent transition-all" style={{ width: `${uploadSummary.percent}%` }} />
          </div>
          <div className="max-h-40 overflow-auto rounded-md border border-app-border">
            {uploadQueue.map((item) => (
              <div key={item.id} className="grid gap-2 border-b border-app-border px-3 py-2 text-xs last:border-0 sm:grid-cols-[1fr_6rem_4rem]">
                <span className="truncate font-mono text-app-text">{item.relativePath}</span>
                <span className="text-app-muted">{item.status}</span>
                <span className={item.status === "failed" ? "text-app-danger" : "text-app-muted"}>
                  {item.error ?? item.skipReason ?? `${item.progress}%`}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <TableSkeleton columns={5} />
        ) : query.isError ? (
          <ErrorState error={query.error} />
        ) : visibleEntries.length === 0 && searchKeyword.trim() ? (
          <EmptyState title="未找到匹配文件" action={<Button variant="secondary" onClick={() => setSearchKeyword("")}>清空搜索</Button>} />
        ) : visibleEntries.length === 0 ? (
          <EmptyState title="当前目录为空" />
        ) : (
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="bg-app-panel text-left text-xs text-app-muted">
              <tr>
                <th className="border-b border-app-border px-3 py-2 font-medium">名称</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">类型</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">大小</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">更新时间</th>
                <th className="border-b border-app-border px-3 py-2 font-medium">远程操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => {
                const directory = isStorageDirectory(entry, path);
                const entryPath = getStorageEntryPath(entry, path);
                const directSize = getStorageEntrySize(entry);
                const directorySize = directorySizes[entryPath];
                const entrySize = directory ? directorySize?.size ?? directSize : directSize;
                const entrySizeText =
                  directory && directorySize?.status === "loading"
                    ? "计算中"
                    : directory && directorySize?.status === "error"
                      ? "计算失败"
                      : entrySize === null
                        ? "-"
                        : formatBytes(entrySize);
                return (
                  <tr key={entryPath} className="border-b border-app-border last:border-0 hover:bg-app-panel/60">
                    <td className="px-3 py-2">
                      <button
                        className="inline-flex items-center gap-2 font-medium text-app-text hover:text-app-accent disabled:cursor-default disabled:text-app-text"
                        disabled={!directory}
                        onClick={() => setPath(entryPath)}
                      >
                        {directory ? <Folder className="h-4 w-4 text-app-accent" /> : <FileText className="h-4 w-4 text-app-muted" />}
                        {entry.name}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-app-muted">{directory ? "目录" : "文件"}</td>
                    <td className="px-3 py-2 text-app-muted">
                      <div className="flex items-center gap-2">
                        <span>{entrySizeText}</span>
                        {directory ? (
                          <Button
                            className="h-7 px-2 text-xs"
                            disabled={directorySize?.status === "loading"}
                            type="button"
                            variant="ghost"
                            onClick={() => calculateDirectorySize(entryPath)}
                          >
                            {directorySize?.status === "error" ? "重试" : "计算"}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-app-muted">{getStorageEntryModified(entry)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {directory ? (
                          <>
                            <Button className="h-8 px-2" variant="ghost" title="打开远程目录" onClick={() => setPath(entryPath)}>
                              <FolderOpen className="h-4 w-4" />
                              打开
                            </Button>
                            <Button
                              className="h-8 px-2"
                              variant="ghost"
                              title="整体下载远程文件夹"
                              onClick={() => downloadEntry(entry, entryPath)}
                            >
                              <Download className="h-4 w-4" />
                              下载
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              className="h-8 px-2"
                              variant="ghost"
                              title="下载远程文件到本地"
                              onClick={() => downloadEntry(entry, entryPath)}
                            >
                              <Download className="h-4 w-4" />
                              下载
                            </Button>
                            <Button className="h-8 px-2" variant="ghost" title="读取远程文件内容" onClick={() => previewMutation.mutate(entry)}>
                              <Eye className="h-4 w-4" />
                              读取
                            </Button>
                          </>
                        )}
                        <Button className="h-8 px-2" variant="ghost" title="删除远程文件或目录" onClick={() => confirmDeleteEntry(entry)}>
                          <Trash2 className="h-4 w-4 text-app-danger" />
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Dialog open={Boolean(preview)} title={`远程文件 ${preview?.title ?? ""}`} onClose={() => setPreview(null)} width="max-w-5xl">
        <pre className="max-h-[70vh] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
          {preview?.content || "文件为空"}
        </pre>
      </Dialog>
      <Dialog open={mkdirOpen} title="新建文件夹" onClose={() => setMkdirOpen(false)} width="max-w-md">
        <div className="space-y-4 p-4">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">文件夹名称</span>
            <Input
              autoFocus
              className="w-full"
              placeholder="输入新文件夹名称"
              value={mkdirName}
              onChange={(event) => setMkdirName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createDirectory();
              }}
            />
          </label>
          {mkdirMutation.isError ? <ErrorState error={mkdirMutation.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setMkdirOpen(false)}>
              取消
            </Button>
            <Button disabled={!mkdirName.trim() || mkdirMutation.isPending} type="button" onClick={createDirectory}>
              创建
            </Button>
          </div>
        </div>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
