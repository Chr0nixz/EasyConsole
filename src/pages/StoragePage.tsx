import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileText, Folder, FolderOpen, FolderPlus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import { EmptyState, ErrorState, LoadingState } from "../components/DataState";
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
import type { StorageEntry } from "../lib/types";

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
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [path, setPath] = useState("/");
  const [mkdirName, setMkdirName] = useState("");
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [sortField, setSortField] = useState<StorageSortField>("name");
  const [sortDirection, setSortDirection] = useState<StorageSortDirection>("asc");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<unknown | null>(null);
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const crumbs = useMemo(() => getStorageBreadcrumbs(path), [path]);
  const query = useQuery({ queryKey: ["storage", path], queryFn: () => remoteStorage.list({ path }) });
  const entries = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const directoryEntries = useMemo(() => entries.filter((entry) => isStorageDirectory(entry, path)), [entries, path]);
  const directorySizeQuery = useQuery({
    queryKey: ["storage-directory-sizes", path, directoryEntries.map((entry) => getStorageEntryPath(entry, path)).join("|")],
    queryFn: async () => {
      const sizes: Record<string, number | null> = {};
      for (const entry of directoryEntries) {
        const entryPath = getStorageEntryPath(entry, path);
        try {
          sizes[entryPath] = await remoteStorage.getDirectorySize(entryPath);
        } catch {
          sizes[entryPath] = null;
        }
      }
      return sizes;
    },
    enabled: directoryEntries.length > 0,
    retry: 1,
    staleTime: 30_000,
  });
  const directorySizeMap = useMemo(() => directorySizeQuery.data ?? {}, [directorySizeQuery.data]);
  const visibleEntries = useMemo(() => {
    const normalizedKeyword = searchKeyword.trim().toLowerCase();
    const entrySizeForSort = (entry: StorageEntry) => {
      const entryPath = getStorageEntryPath(entry, path);
      if (isStorageDirectory(entry, path)) return typeof directorySizeMap[entryPath] === "number" ? directorySizeMap[entryPath] : -1;
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
  }, [directorySizeMap, entries, path, searchKeyword, sortDirection, sortField]);

  const mkdirMutation = useMutation({
    mutationFn: () => remoteStorage.createDirectory(joinStoragePath(path, mkdirName)),
    onSuccess: () => {
      setMkdirName("");
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: StorageEntry) => remoteStorage.remove(getStorageEntryPath(entry, path), isStorageDirectory(entry, path)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storage"] }),
  });

  const previewMutation = useMutation({
    mutationFn: (entry: StorageEntry) => remoteStorage.readTextFile(getStorageEntryPath(entry, path)),
    onSuccess: (content, entry) => setPreview({ title: entry.name, content }),
  });

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadPercent(1);
    try {
      await remoteStorage.uploadLocalFile(file, path, (progress) => setUploadPercent(progress.percent));
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    } catch (error) {
      setUploadError(error);
    } finally {
      setUploadPercent(null);
      event.target.value = "";
    }
  }

  async function uploadFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    setUploadError(null);
    setUploadPercent(1);
    try {
      await remoteStorage.uploadLocalFiles(files, path, (progress) => setUploadPercent(progress.percent));
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    } catch (error) {
      setUploadError(error);
    } finally {
      setUploadPercent(null);
      event.target.value = "";
    }
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

      {uploadPercent !== null ? (
        <div className="rounded-md border border-app-border bg-app-surface px-3 py-2 text-sm text-app-muted">上传进度 {uploadPercent}%</div>
      ) : null}

      {uploadError ? <ErrorState error={uploadError} /> : null}

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <LoadingState />
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
                const directorySize = directorySizeMap[entryPath];
                const entrySize = directory ? directorySize : directSize;
                const entrySizeText =
                  entrySize === undefined || entrySize === null
                    ? directory && directorySizeQuery.isFetching
                      ? "计算中"
                      : "-"
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
                    <td className="px-3 py-2 text-app-muted">{entrySizeText}</td>
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
                              onClick={() => void remoteStorage.downloadRemotePath(entryPath).then((blob) => saveBlob(blob, getDirectoryDownloadName(entry)))}
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
                              onClick={() => void remoteStorage.downloadRemoteFile(entryPath).then((blob) => saveBlob(blob, entry.name))}
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
                        <Button className="h-8 px-2" variant="ghost" title="删除远程文件或目录" onClick={() => deleteMutation.mutate(entry)}>
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
    </div>
  );
}
