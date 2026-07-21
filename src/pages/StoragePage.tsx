import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Eye, FileText, Folder, FolderOpen, FolderPlus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import { EmptyState, ErrorState, FolderOpenIcon, SearchXIcon, TableSkeleton } from "../components/DataState";
import { Button, Dialog, Input, Panel, Select, TableRegion } from "../components/ui";
import { useDownloadQueue } from "../lib/download-queue-context";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { Locale } from "../lib/i18n-text";
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
import { createUploadQueueItems, finalizeUploadQueueResult, summarizeUploadQueue } from "../lib/upload-queue";
import { clearUploadResume, loadUploadResume, makeFileKey, saveUploadResume } from "../lib/upload-resume";
import type { StorageEntry, UploadQueueItem } from "../lib/types";
import { browserRuntime } from "../lib/runtime";
import { useConfirmAction } from "../lib/use-confirm-action";
import { errorMessage, useRunLogger } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

type StorageSortField = "name" | "size" | "modified" | "type";
type StorageSortDirection = "asc" | "desc";

const uploadStatusText: Record<UploadQueueItem["status"], { zh: string; en: string }> = {
  queued: { zh: "排队中", en: "Queued" },
  uploading: { zh: "上传中", en: "Uploading" },
  done: { zh: "已完成", en: "Done" },
  failed: { zh: "失败", en: "Failed" },
  skipped: { zh: "已跳过", en: "Skipped" },
  cancelled: { zh: "已取消", en: "Cancelled" },
};

function getUploadStatusText(status: UploadQueueItem["status"], locale: Locale) {
  const entry = uploadStatusText[status];
  return locale === "en-US" ? entry.en : entry.zh;
}

function compareText(left: string, right: string, locale: Locale) {
  return left.localeCompare(right, locale, { numeric: true, sensitivity: "base" });
}

function getDirectoryDownloadName(entry: StorageEntry) {
  return entry.name.toLowerCase().endsWith(".zip") ? entry.name : `${entry.name}.zip`;
}

export function StoragePage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { locale, text } = useI18n();
  const runLogger = useRunLogger();
  const downloadQueue = useDownloadQueue();
  const { confirm, confirmDialog } = useConfirmAction();
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadCancelledRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [path, setPath] = useState("/");
  const [mkdirName, setMkdirName] = useState("");
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [sortField, setSortField] = useState<StorageSortField>("name");
  const [sortDirection, setSortDirection] = useState<StorageSortDirection>("asc");
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [preview, setPreview] = useState<{ title: string; content: string; path: string; truncated: boolean; size: number; binary: boolean } | null>(null);
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
        if (sortField === "name") result = compareText(left.name, right.name, locale);
        if (sortField === "type") result = compareText(leftDirectory ? "directory" : "file", rightDirectory ? "directory" : "file", locale) || compareText(left.name, right.name, locale);
        if (sortField === "size") result = entrySizeForSort(left) - entrySizeForSort(right) || compareText(left.name, right.name, locale);
        if (sortField === "modified") result = getStorageEntryModifiedTime(left) - getStorageEntryModifiedTime(right) || compareText(left.name, right.name, locale);
        return sortDirection === "asc" ? result : -result;
      });
  }, [directorySizes, entries, locale, path, searchKeyword, sortDirection, sortField]);

  const mkdirMutation = useMutation({
    mutationFn: () => remoteStorage.createDirectory(joinStoragePath(path, mkdirName)),
    onSuccess: () => {
      setMkdirName("");
      void runLogger.log({
        source: "storage",
        level: "info",
        action: "storage.mkdir",
        result: "success",
        title: text("远程文件夹已创建", "Remote folder created"),
        targetName: joinStoragePath(path, mkdirName),
      });
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: StorageEntry) => remoteStorage.remove(getStorageEntryPath(entry, path), isStorageDirectory(entry, path)),
    onSuccess: (_data, entry) => {
      toast.success(text("远程文件已删除", "Remote file deleted"), entry.name);
      void runLogger.log({
        source: "storage",
        level: "info",
        action: "storage.delete",
        result: "success",
        title: text("远程文件已删除", "Remote file deleted"),
        targetName: getStorageEntryPath(entry, path),
      });
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (error, entry) => {
      toast.error(text("远程删除失败", "Remote delete failed"), `${entry.name}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
      void runLogger.log({
        source: "storage",
        level: "error",
        action: "storage.delete",
        result: "failure",
        title: text("远程删除失败", "Remote delete failed"),
        targetName: getStorageEntryPath(entry, path),
        error: errorMessage(error, text("远程删除失败", "Remote delete failed")),
      });
    },
  });

  const previewMutation = useMutation({
    mutationFn: (entry: StorageEntry) => remoteStorage.readTextFile(getStorageEntryPath(entry, path), { limitBytes: 1024 * 1024 }),
    onSuccess: (result, entry) => {
      const entryPath = getStorageEntryPath(entry, path);
      setPreview({ title: entry.name, path: entryPath, ...result });
      if (result.binary) {
        toast.error(text("文件看起来是二进制内容", "This file appears to be binary"), text("请下载后在本地打开。", "Download it and open it locally."));
      }
    },
    onError: (error, entry) => {
      toast.error(text("读取远程文件失败", "Failed to read remote file"), `${entry.name}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
      void runLogger.log({
        source: "storage",
        level: "error",
        action: "storage.preview",
        result: "failure",
        title: text("读取远程文件失败", "Failed to read remote file"),
        targetName: getStorageEntryPath(entry, path),
        error: errorMessage(error, text("读取远程文件失败", "Failed to read remote file")),
      });
    },
  });

  async function runUploadQueue(items: UploadQueueItem[]) {
    uploadCancelledRef.current = false;
    let latestItems = items.map((item) => ({ ...item }));
    setUploadQueue(latestItems);
    const patchQueue = (updater: (current: UploadQueueItem[]) => UploadQueueItem[]) => {
      latestItems = updater(latestItems);
      setUploadQueue(latestItems);
    };
    try {
      const directories = [...new Set(latestItems.filter((item) => item.status !== "skipped").map((item) => item.remoteDirectory))]
        .filter((directory) => directory !== "/")
        .sort((left, right) => left.split("/").length - right.split("/").length);
      for (const directory of directories) {
        try {
          await remoteStorage.createDirectory(directory);
        } catch {
          // Existing directories can be reused during recursive uploads.
        }
      }
      for (const item of [...latestItems]) {
        if (item.status === "skipped") continue;
        if (uploadCancelledRef.current) {
          patchQueue((current) =>
            current.map((queueItem) => (queueItem.status === "queued" ? { ...queueItem, status: "cancelled" } : queueItem)),
          );
          break;
        }
        patchQueue((current) =>
          current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, status: "uploading", progress: 1, error: undefined } : queueItem)),
        );

        const fileKey = makeFileKey(item.file);
        const resumeRecord = item.resumeFromUploadId ? { uploadId: item.resumeFromUploadId, fileKey } : await loadUploadResume(browserRuntime.storage, fileKey);
        const resumeFromUploadId = resumeRecord?.uploadId;
        let capturedUploadId: string | null = resumeFromUploadId ?? null;

        try {
          const abortController = new AbortController();
          uploadAbortRef.current = abortController;
          await remoteStorage.uploadLocalFile(
            item.file,
            item.remoteDirectory,
            (progress) => {
              patchQueue((current) =>
                current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, progress: progress.percent } : queueItem)),
              );
            },
            abortController.signal,
            resumeFromUploadId,
            (uploadId) => {
              capturedUploadId = uploadId;
            },
            async (checkpoint) => {
              capturedUploadId = checkpoint.uploadId;
              await saveUploadResume(browserRuntime.storage, {
                fileKey,
                uploadId: checkpoint.uploadId,
                uploadedChunks: checkpoint.completedIndices,
                createdAt: new Date().toISOString(),
              });
            },
          );
          await clearUploadResume(browserRuntime.storage, fileKey);
          patchQueue((current) =>
            current.map((queueItem) => (queueItem.id === item.id ? { ...queueItem, status: "done", progress: 100 } : queueItem)),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : text("上传失败", "Upload failed");
          if (capturedUploadId) {
            await saveUploadResume(browserRuntime.storage, {
              fileKey,
              uploadId: capturedUploadId,
              uploadedChunks: [],
              createdAt: new Date().toISOString(),
            }).catch(() => undefined);
          }
          patchQueue((current) =>
            current.map((queueItem) =>
              queueItem.id === item.id
                ? { ...queueItem, status: uploadCancelledRef.current ? "cancelled" : "failed", error: uploadCancelledRef.current ? text("已取消", "Cancelled") : message }
                : queueItem,
            ),
          );
        } finally {
          uploadAbortRef.current = null;
        }
      }
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      const result = finalizeUploadQueueResult(latestItems);
      if (result.failed > 0 || result.cancelled > 0) {
        toast.error(
          text("上传队列未全部成功", "Upload queue finished with errors"),
          text(`成功 ${result.succeeded}，失败 ${result.failed}，取消 ${result.cancelled}`, `${result.succeeded} succeeded, ${result.failed} failed, ${result.cancelled} cancelled`),
        );
      } else {
        toast.success(text("上传队列已处理", "Upload queue processed"), text(`${result.succeeded} 个文件`, `${result.succeeded} files`));
      }
      void runLogger.log({
        source: "storage",
        level: result.failed > 0 ? "error" : "info",
        action: "storage.upload",
        result: result.failed > 0 ? "failure" : "success",
        title: result.failed > 0 ? text("上传队列未全部成功", "Upload queue finished with errors") : text("上传队列已处理", "Upload queue processed"),
        metadata: { count: result.items.length, failed: result.failed, cancelled: result.cancelled, succeeded: result.succeeded, path },
      });
      return result;
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
    uploadAbortRef.current?.abort();
    setUploadQueue((items) => items.map((item) => (item.status === "queued" ? { ...item, status: "cancelled" } : item)));
  }

  function copyPath(value: string) {
    void browserRuntime.copyText(value).then(
      () => toast.success(text("路径已复制", "Path copied"), value),
      () => toast.error(text("复制失败", "Copy failed")),
    );
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
          [entryPath]: { status: "error", error: error instanceof Error ? error.message : text("计算失败", "Calculation failed") },
        }));
      });
  }

  function confirmDeleteEntry(entry: StorageEntry) {
    const entryPath = getStorageEntryPath(entry, path);
    confirm({
      title: text("确认删除远程路径", "Confirm Remote Path Deletion"),
      description: text(`将删除 ${entryPath}，此操作不可从 EasyConsole 撤销。`, `This will delete ${entryPath}. EasyConsole cannot undo this operation.`),
      confirmLabel: text("删除", "Delete"),
      tone: "danger",
      run: () => deleteMutation.mutateAsync(entry),
    });
  }

  function downloadEntry(entry: StorageEntry, entryPath: string) {
    const directory = isStorageDirectory(entry, path);
    const filename = directory ? getDirectoryDownloadName(entry) : entry.name;
    downloadQueue.enqueue({
      source: "storage",
      sourceLabel: directory ? text("远程文件夹", "Remote folder") : text("远程文件", "Remote file"),
      filename,
      targetName: entryPath,
      successTitle: text("远程文件已下载", "Remote file downloaded"),
      failureTitle: text("远程下载失败", "Remote download failed"),
      action: "storage.download",
      request: ({ signal, onProgress }) =>
        directory
          ? remoteStorage.downloadRemotePath(entryPath, { signal, onProgress })
          : remoteStorage.downloadRemoteFile(entryPath, { signal, onProgress }),
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
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <Button variant="secondary" onClick={() => copyPath(path)}>
            <Copy className="h-4 w-4" />
            {text("复制路径", "Copy path")}
          </Button>
          <div className="relative w-full sm:w-auto">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
            <Input className="w-full pl-9 sm:w-52" placeholder={text("搜索文件或文件夹", "Search files or folders")} value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} />
          </div>
          <Select className="w-32" value={sortField} onChange={(event) => setSortField(event.target.value as StorageSortField)}>
            <option value="name">{text("按名称", "By name")}</option>
            <option value="size">{text("按大小", "By size")}</option>
            <option value="modified">{text("按时间", "By time")}</option>
            <option value="type">{text("按类型", "By type")}</option>
          </Select>
          <Select className="w-28" value={sortDirection} onChange={(event) => setSortDirection(event.target.value as StorageSortDirection)}>
            <option value="asc">{text("升序", "Ascending")}</option>
            <option value="desc">{text("降序", "Descending")}</option>
          </Select>
          <Button variant="secondary" onClick={() => setMkdirOpen(true)}>
            <FolderPlus className="h-4 w-4" />
            {text("新建", "New")}
          </Button>
          <label className="app-interactive inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-app-accent px-3 text-sm font-medium text-app-onAccent hover:brightness-95 [@media(pointer:coarse)]:min-h-11">
            <Upload className="h-4 w-4" />
            {text("上传到远程", "Upload to remote")}
            <input className="sr-only" type="file" onChange={(event) => void upload(event)} />
          </label>
          {browserRuntime.isMobile ? null : (
            <Button type="button" variant="secondary" onClick={openFolderUploadDialog}>
              <FolderOpen className="h-4 w-4" />
              {text("上传文件夹", "Upload folder")}
            </Button>
          )}
          <input
            ref={folderInputRef}
            className="sr-only"
            multiple
            type="file"
            onChange={(event) => void uploadFolder(event)}
          />
          <Button variant="secondary" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            {text("刷新", "Refresh")}
          </Button>
        </div>
      </div>

      {uploadQueue.length > 0 ? (
        <Panel className="space-y-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="text-app-muted">
              {text(
                `上传队列 ${uploadSummary.completed}/${uploadSummary.total}，失败 ${uploadSummary.failed}，跳过 ${uploadSummary.skipped}`,
                `Upload queue ${uploadSummary.completed}/${uploadSummary.total}, failed ${uploadSummary.failed}, skipped ${uploadSummary.skipped}`,
              )}
              {uploadSummary.cancelled ? text(`，取消 ${uploadSummary.cancelled}`, `, cancelled ${uploadSummary.cancelled}`) : ""}
            </div>
            <div className="flex items-center gap-2">
              <Button disabled={!uploadSummary.active} type="button" variant="secondary" onClick={cancelPendingUploads}>
                {text("取消后续", "Cancel remaining")}
              </Button>
              <Button disabled={uploadSummary.failed === 0 || uploadSummary.active} type="button" variant="secondary" onClick={retryFailedUploads}>
                {text("重试失败", "Retry failed")}
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
                <span className="text-app-muted">{getUploadStatusText(item.status, locale)}</span>
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
          <EmptyState icon={SearchXIcon} title={text("未找到匹配文件", "No matching files")} action={<Button variant="secondary" onClick={() => setSearchKeyword("")}>{text("清空搜索", "Clear search")}</Button>} />
        ) : entries.length === 0 ? (
          <EmptyState icon={FolderOpenIcon} title={text("当前目录为空", "Current directory is empty")} />
        ) : (
          <>
          {browserRuntime.isMobile ? (
          <div className="divide-y divide-app-border">
            {visibleEntries.map((entry, index) => {
              const directory = isStorageDirectory(entry, path);
              const entryPath = getStorageEntryPath(entry, path);
              const entryCardId = `storage-card-${index}`;
              const directSize = getStorageEntrySize(entry);
              const directorySize = directorySizes[entryPath];
              const entrySize = directory ? directorySize?.size ?? directSize : directSize;
              const entrySizeText =
                directory && directorySize?.status === "loading"
                  ? text("计算中", "Calculating")
                  : directory && directorySize?.status === "error"
                    ? text("计算失败", "Calculation failed")
                    : entrySize === null
                      ? "-"
                      : formatBytes(entrySize);
              return (
                <article key={entryPath} className="space-y-3 px-3 py-3" aria-labelledby={entryCardId}>
                  <div className="flex items-start gap-3">
                    {directory ? <Folder className="mt-0.5 h-4 w-4 shrink-0 text-app-accent" /> : <FileText className="mt-0.5 h-4 w-4 shrink-0 text-app-muted" />}
                    <div className="min-w-0 flex-1">
                      <button
                        id={entryCardId}
                        className="block max-w-full truncate text-left text-sm font-semibold text-app-text hover:text-app-accent disabled:cursor-default disabled:text-app-text"
                        disabled={!directory}
                        onClick={() => setPath(entryPath)}
                      >
                        {entry.name}
                      </button>
                      <div className="mt-1 truncate font-mono text-xs text-app-muted">{entryPath}</div>
                    </div>
                    <Button
                      aria-label={text(`复制远程路径 ${entryPath}`, `Copy remote path ${entryPath}`)}
                      className="h-9 w-9 shrink-0 px-0"
                      type="button"
                      title={text("复制远程路径", "Copy remote path")}
                      variant="ghost"
                      onClick={() => copyPath(entryPath)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div>
                      <dt className="text-app-muted">{text("类型", "Type")}</dt>
                      <dd className="mt-0.5 text-app-text">{directory ? text("目录", "Directory") : text("文件", "File")}</dd>
                    </div>
                    <div>
                      <dt className="text-app-muted">{text("大小", "Size")}</dt>
                      <dd className="mt-0.5 text-app-text">{entrySizeText}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-app-muted">{text("更新时间", "Updated")}</dt>
                      <dd className="mt-0.5 text-app-text">{getStorageEntryModified(entry)}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-1.5">
                    {directory ? (
                      <>
                        <Button className="h-9 px-2" variant="ghost" title={text("打开远程目录", "Open remote directory")} onClick={() => setPath(entryPath)}>
                          <FolderOpen className="h-4 w-4" />
                          {text("打开", "Open")}
                        </Button>
                        <Button className="h-9 px-2" variant="ghost" title={text("整体下载远程文件夹", "Download remote folder")} onClick={() => downloadEntry(entry, entryPath)}>
                          <Download className="h-4 w-4" />
                          {text("下载", "Download")}
                        </Button>
                        <Button className="h-9 px-2" disabled={directorySize?.status === "loading"} type="button" variant="ghost" onClick={() => calculateDirectorySize(entryPath)}>
                          {directorySize?.status === "error" ? text("重试", "Retry") : text("计算", "Calculate")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button className="h-9 px-2" variant="ghost" title={text("下载远程文件到本地", "Download remote file locally")} onClick={() => downloadEntry(entry, entryPath)}>
                          <Download className="h-4 w-4" />
                          {text("下载", "Download")}
                        </Button>
                        <Button className="h-9 px-2" variant="ghost" title={text("读取远程文件内容", "Read remote file content")} onClick={() => previewMutation.mutate(entry)}>
                          <Eye className="h-4 w-4" />
                          {text("读取", "Read")}
                        </Button>
                      </>
                    )}
                    <Button className="h-9 px-2 text-app-danger hover:text-app-danger" variant="ghost" title={text("删除远程文件或目录", "Delete remote file or directory")} onClick={() => confirmDeleteEntry(entry)}>
                      <Trash2 className="h-4 w-4" />
                      {text("删除", "Delete")}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
          ) : (
          <TableRegion label={text("远程文件表格", "Remote files table")}>
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("名称", "Name")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("类型", "Type")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("大小", "Size")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("更新时间", "Updated")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium" scope="col">{text("远程操作", "Remote actions")}</th>
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
                    ? text("计算中", "Calculating")
                    : directory && directorySize?.status === "error"
                      ? text("计算失败", "Calculation failed")
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
                        {directory ? <Folder className="h-4 w-4 text-app-accent" /> : <FileText className="h-4 w-4 text-app-text" />}
                        {entry.name}
                      </button>
                      <button
                        aria-label={text(`复制远程路径 ${entryPath}`, `Copy remote path ${entryPath}`)}
                        className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded text-app-muted hover:bg-app-panel hover:text-app-text"
                        type="button"
                        title={text("复制远程路径", "Copy remote path")}
                        onClick={() => copyPath(entryPath)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        <span className="sr-only">{text("复制远程路径", "Copy remote path")}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-app-text">{directory ? text("目录", "Directory") : text("文件", "File")}</td>
                    <td className="px-3 py-2 text-app-text">
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
                            {directorySize?.status === "error" ? text("重试", "Retry") : text("计算", "Calculate")}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-app-text">{getStorageEntryModified(entry)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {directory ? (
                          <>
                            <Button className="h-8 px-2" variant="ghost" title={text("打开远程目录", "Open remote directory")} onClick={() => setPath(entryPath)}>
                              <FolderOpen className="h-4 w-4" />
                              {text("打开", "Open")}
                            </Button>
                            <Button
                              className="h-8 px-2"
                              variant="ghost"
                              title={text("整体下载远程文件夹", "Download remote folder")}
                              onClick={() => downloadEntry(entry, entryPath)}
                            >
                              <Download className="h-4 w-4" />
                              {text("下载", "Download")}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              className="h-8 px-2"
                              variant="ghost"
                              title={text("下载远程文件到本地", "Download remote file locally")}
                              onClick={() => downloadEntry(entry, entryPath)}
                            >
                              <Download className="h-4 w-4" />
                              {text("下载", "Download")}
                            </Button>
                            <Button className="h-8 px-2" variant="ghost" title={text("读取远程文件内容", "Read remote file content")} onClick={() => previewMutation.mutate(entry)}>
                              <Eye className="h-4 w-4" />
                              {text("读取", "Read")}
                            </Button>
                          </>
                        )}
                        <Button className="h-8 px-2" variant="ghost" title={text("删除远程文件或目录", "Delete remote file or directory")} onClick={() => confirmDeleteEntry(entry)}>
                          <Trash2 className="h-4 w-4 text-app-danger" />
                          {text("删除", "Delete")}
                        </Button>
                      </div>
                    </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableRegion>
          )}
          </>
        )}
      </Panel>

      <Dialog open={Boolean(preview)} title={text(`远程文件 ${preview?.title ?? ""}`, `Remote File ${preview?.title ?? ""}`)} onClose={() => setPreview(null)} width="max-w-5xl">
        <div className="space-y-3 p-3">
          {preview?.truncated ? <div className="rounded-md bg-app-warningSoft px-3 py-2 text-sm text-app-warning">{text(`文件较大，仅显示前 1 MiB。大小：${formatBytes(preview.size)}`, `Large file. Showing the first 1 MiB only. Size: ${formatBytes(preview.size)}`)}</div> : null}
          {preview?.binary ? <div className="rounded-md bg-app-warningSoft px-3 py-2 text-sm text-app-warning">{text("二进制文件不支持文本预览，请下载后打开。", "Binary files cannot be previewed as text. Download to open locally.")}</div> : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-app-muted">
            <span className="font-mono">{preview?.path}</span>
            <Button type="button" variant="secondary" onClick={() => preview?.path && copyPath(preview.path)}>
              <Copy className="h-4 w-4" />
              {text("复制路径", "Copy path")}
            </Button>
          </div>
        <pre className="max-h-[60vh] overflow-auto bg-app-codeBg p-4 font-mono text-xs leading-5 text-app-codeText">
          {preview?.content || text("文件为空", "File is empty")}
        </pre>
        </div>
      </Dialog>
      <Dialog open={mkdirOpen} title={text("新建文件夹", "New Folder")} onClose={() => setMkdirOpen(false)} width="max-w-md">
        <div className="space-y-4 p-4">
          <label className="block text-sm">
            <span className="mb-1 block text-app-muted">{text("文件夹名称", "Folder name")}</span>
            <Input
              autoFocus
              className="w-full"
              placeholder={text("输入新文件夹名称", "Enter a new folder name")}
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
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={!mkdirName.trim() || mkdirMutation.isPending} type="button" onClick={createDirectory}>
              {text("创建", "Create")}
            </Button>
          </div>
        </div>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
