import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "../DataState";
import { Button, Dialog, Select } from "../ui";
import { formatBytes } from "../../lib/format";
import { useI18n, type Locale } from "../../lib/i18n";
import {
  getStorageBreadcrumbs,
  getStorageEntryModifiedTime,
  getStorageEntryPath,
  getStorageEntrySize,
  getStorageParentPath,
  isStorageDirectory,
  normalizeStoragePath,
  remoteStorage,
  type RemoteStoragePickMode,
} from "../../lib/remote-storage";
import type { StorageEntry } from "../../lib/types";
import { cn } from "../../lib/utils";

type RemoteStoragePickerProps = {
  open: boolean;
  title?: string;
  mode: RemoteStoragePickMode;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

type StoragePickerSortField = "name" | "size" | "modified" | "type";
type StoragePickerSortDirection = "asc" | "desc";

function compareText(left: string, right: string, locale: Locale) {
  return left.localeCompare(right, locale, { numeric: true, sensitivity: "base" });
}

function defaultTitle(mode: RemoteStoragePickMode, text: (zh: string, en: string) => string) {
  return mode === "directory" ? text("选择远程文件夹", "Select Remote Folder") : text("选择远程文件", "Select Remote File");
}

export function RemoteStoragePicker({
  open,
  title,
  mode,
  initialPath = "/",
  onClose,
  onSelect,
}: RemoteStoragePickerProps) {
  const { locale, text } = useI18n();
  const [path, setPath] = useState(() => normalizeStoragePath(initialPath));
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sortField, setSortField] = useState<StoragePickerSortField>("name");
  const [sortDirection, setSortDirection] = useState<StoragePickerSortDirection>("asc");
  const crumbs = useMemo(() => getStorageBreadcrumbs(path), [path]);
  const query = useQuery({
    queryKey: ["remote-storage-picker", path],
    queryFn: () => remoteStorage.list({ path }),
    enabled: open,
  });
  const entries = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const visibleEntries = useMemo(() => {
    return [...entries].sort((left, right) => {
      const leftDirectory = isStorageDirectory(left, path);
      const rightDirectory = isStorageDirectory(right, path);
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;

      let result = 0;
      if (sortField === "name") result = compareText(left.name, right.name, locale);
      if (sortField === "type") result = compareText(leftDirectory ? "directory" : "file", rightDirectory ? "directory" : "file", locale) || compareText(left.name, right.name, locale);
      if (sortField === "size") result = (getStorageEntrySize(left) ?? -1) - (getStorageEntrySize(right) ?? -1) || compareText(left.name, right.name, locale);
      if (sortField === "modified") result = getStorageEntryModifiedTime(left) - getStorageEntryModifiedTime(right) || compareText(left.name, right.name, locale);
      return sortDirection === "asc" ? result : -result;
    });
  }, [entries, locale, path, sortDirection, sortField]);

  useEffect(() => {
    if (!open) return;
    setPath(normalizeStoragePath(initialPath));
    setSelectedFile(null);
  }, [initialPath, open]);

  function openDirectory(entry: StorageEntry) {
    setPath(getStorageEntryPath(entry, path));
    setSelectedFile(null);
  }

  function selectEntry(entry: StorageEntry) {
    const nextPath = getStorageEntryPath(entry, path);
    if (isStorageDirectory(entry, path)) {
      openDirectory(entry);
      return;
    }
    if (mode === "file") setSelectedFile(nextPath);
  }

  function commitSelection() {
    onSelect(mode === "directory" ? path : selectedFile ?? "");
    onClose();
  }

  return (
    <Dialog open={open} title={title ?? defaultTitle(mode, text)} onClose={onClose} width="max-w-3xl">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            {crumbs.map((crumb, index) => (
              <button
                key={crumb.path}
                className="rounded px-2 py-1 text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                onClick={() => {
                  setPath(crumb.path);
                  setSelectedFile(null);
                }}
              >
                {index > 0 ? "/ " : ""}
                {crumb.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select className="h-8 w-28 text-xs" value={sortField} onChange={(event) => setSortField(event.target.value as StoragePickerSortField)}>
              <option value="name">{text("按名称", "By name")}</option>
              <option value="size">{text("按大小", "By size")}</option>
              <option value="modified">{text("按时间", "By time")}</option>
              <option value="type">{text("按类型", "By type")}</option>
            </Select>
            <Select className="h-8 w-24 text-xs" value={sortDirection} onChange={(event) => setSortDirection(event.target.value as StoragePickerSortDirection)}>
              <option value="asc">{text("升序", "Ascending")}</option>
              <option value="desc">{text("降序", "Descending")}</option>
            </Select>
            <Button
              className="h-8 px-2"
              disabled={path === "/"}
              type="button"
              variant="secondary"
              onClick={() => {
                setPath(getStorageParentPath(path));
                setSelectedFile(null);
              }}
            >
              <ChevronLeft className="h-4 w-4" />
              {text("上级", "Up")}
            </Button>
            <Button className="h-8 px-2" type="button" variant="secondary" onClick={() => query.refetch()}>
              <RefreshCw className="h-4 w-4" />
              {text("刷新", "Refresh")}
            </Button>
          </div>
        </div>

        <div className="max-h-[50vh] overflow-auto rounded-md border border-app-border">
          {query.isLoading ? (
            <LoadingState />
          ) : query.isError ? (
            <ErrorState error={query.error} />
          ) : visibleEntries.length === 0 ? (
            <EmptyState title={text("当前目录为空", "Current directory is empty")} />
          ) : (
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead className="bg-app-panel text-left text-xs text-app-muted">
                <tr>
                  <th className="border-b border-app-border px-3 py-2 font-medium">{text("名称", "Name")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">{text("类型", "Type")}</th>
                  <th className="border-b border-app-border px-3 py-2 font-medium">{text("大小", "Size")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((entry) => {
                  const entryPath = getStorageEntryPath(entry, path);
                  const directory = isStorageDirectory(entry, path);
                  const selected = selectedFile === entryPath;
                  return (
                    <tr
                      key={entryPath}
                      className={cn(
                        "cursor-pointer border-b border-app-border last:border-0 hover:bg-app-panel/60",
                        selected && "bg-app-infoSoft",
                      )}
                      onClick={() => selectEntry(entry)}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 font-medium text-app-text">
                          {directory ? <Folder className="h-4 w-4 text-app-accent" /> : <FileText className="h-4 w-4 text-app-muted" />}
                          {entry.name}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-app-muted">{directory ? text("目录", "Directory") : text("文件", "File")}</td>
                      <td className="px-3 py-2 text-app-muted">{directory ? "-" : formatBytes(getStorageEntrySize(entry) ?? undefined)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-app-border pt-3">
          <div className="flex min-w-0 items-center gap-2 text-sm text-app-muted">
            <FolderOpen className="h-4 w-4" />
            <span className="truncate font-mono text-xs">{mode === "directory" ? path : selectedFile ?? text("请选择文件", "Select a file")}</span>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {text("取消", "Cancel")}
            </Button>
            <Button disabled={mode === "file" && !selectedFile} type="button" onClick={commitSelection}>
              {text("选择", "Select")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
