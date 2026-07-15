import {
  ArrowUp,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderCog,
  FolderUp,
  HardDriveDownload,
  HardDriveUpload,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { browserRuntime } from "../../lib/runtime";
import { useI18n } from "../../lib/i18n";
import type { SftpEntry, SftpProgress } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button, Input } from "../ui";

type SftpPanelProps = {
  sessionId: string;
};

function joinPath(base: string, name: string): string {
  if (base.endsWith("/")) return `${base}${name}`;
  return `${base}/${name}`;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SftpPanel({ sessionId }: SftpPanelProps) {
  const { t } = useI18n();
  const [path, setPath] = useState<string>("~");
  const [pathInput, setPathInput] = useState<string>("~");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<SftpProgress | null>(null);

  const refresh = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        const list = await browserRuntime.sftpList(sessionId, target);
        list.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });
        setEntries(list);
        setPath(target);
        setPathInput(target);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void refresh(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void browserRuntime.onSftpProgress(sessionId, (p) => {
      if (!active) return;
      setProgress(p);
    }).then((fn) => {
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [sessionId]);

  const handleParent = useCallback(() => {
    void refresh(parentPath(path));
  }, [path, refresh]);

  const handlePathSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = pathInput.trim();
      if (trimmed && trimmed !== path) void refresh(trimmed);
    },
    [pathInput, path, refresh],
  );

  const handleEntryClick = useCallback((entry: SftpEntry) => {
    setSelected((prev) => (prev === entry.name ? null : entry.name));
  }, []);

  const handleEntryDoubleClick = useCallback(
    (entry: SftpEntry) => {
      if (entry.isDir) {
        void refresh(joinPath(path, entry.name));
      }
    },
    [path, refresh],
  );

  const handleUpload = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const localPath = await open({ multiple: false });
      if (!localPath || typeof localPath !== "string") return;
      const filename = localPath.split(/[/\\]/).pop() ?? "upload";
      const remotePath = joinPath(path, filename);
      setBusy(`upload:${filename}`);
      setProgress({ transferred: 0, total: 0 });
      await browserRuntime.sftpUpload(sessionId, localPath, remotePath);
      await refresh(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [sessionId, path, refresh]);

  const handleDownload = useCallback(async () => {
    if (!selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry || !entry.isFile) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const localPath = await save({ defaultPath: entry.name });
      if (!localPath) return;
      const remotePath = joinPath(path, entry.name);
      setBusy(`download:${entry.name}`);
      setProgress({ transferred: 0, total: entry.size });
      await browserRuntime.sftpDownload(sessionId, remotePath, localPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [sessionId, path, selected, entries]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry) return;
    if (!window.confirm(t("sftp.deleteConfirm"))) return;
    try {
      setBusy(`delete:${entry.name}`);
      await browserRuntime.sftpDelete(sessionId, joinPath(path, entry.name));
      await refresh(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [sessionId, path, selected, entries, t, refresh]);

  const handleRename = useCallback(async () => {
    if (!selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry) return;
    const newName = window.prompt(t("sftp.namePrompt"), entry.name);
    if (!newName || newName === entry.name) return;
    try {
      setBusy(`rename:${entry.name}`);
      await browserRuntime.sftpRename(sessionId, joinPath(path, entry.name), joinPath(path, newName));
      await refresh(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [sessionId, path, selected, entries, t, refresh]);

  const handleMkdir = useCallback(async () => {
    const name = window.prompt(t("sftp.mkdirPrompt"));
    if (!name?.trim()) return;
    try {
      setBusy(`mkdir:${name}`);
      await browserRuntime.sftpMkdir(sessionId, joinPath(path, name.trim()));
      await refresh(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [sessionId, path, t, refresh]);

  const selectedEntry = entries.find((e) => e.name === selected) ?? null;
  const progressPct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-surface">
      <div className="flex items-center gap-1 border-b border-app-border px-2 py-1.5">
        <Button variant="ghost" className="h-7 w-7 p-0" onClick={handleParent} title={t("sftp.parentDir")} disabled={loading}>
          <FolderUp className="h-4 w-4" />
        </Button>
        <Button variant="ghost" className="h-7 w-7 p-0" onClick={handleUpload} title={t("sftp.upload")} disabled={!!busy}>
          <HardDriveUpload className="h-4 w-4" />
        </Button>
        <Button variant="ghost" className="h-7 w-7 p-0" onClick={handleDownload} title={t("sftp.download")} disabled={!!busy || !selectedEntry?.isFile}>
          <HardDriveDownload className="h-4 w-4" />
        </Button>
        <Button variant="ghost" className="h-7 w-7 p-0" onClick={handleMkdir} title={t("sftp.mkdir")} disabled={!!busy}>
          <FilePlus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" className="h-7 w-7 p-0" onClick={handleRename} title={t("sftp.rename")} disabled={!!busy || !selected}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" className="h-7 w-7 p-0" onClick={handleDelete} title={t("sftp.delete")} disabled={!!busy || !selected}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <form className="flex items-center gap-1 border-b border-app-border px-2 py-1.5" onSubmit={handlePathSubmit}>
        <FolderCog className="h-3.5 w-3.5 shrink-0 text-app-muted" />
        <Input
          className="h-7 flex-1 text-xs"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder={t("sftp.path")}
          spellCheck={false}
        />
        <Button variant="secondary" className="h-7 px-2 text-xs" type="submit">
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
      </form>
      {progressPct !== null && (
        <div className="border-b border-app-border px-2 py-1">
          <div className="flex items-center justify-between text-xs text-app-muted">
            <span>{busy?.startsWith("upload") ? t("sftp.uploading") : t("sftp.downloading")}</span>
            <span>{progressPct}%</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-app-border">
            <div className="h-full bg-app-accent transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}
      {error && (
        <div className="border-b border-app-border bg-app-danger/10 px-2 py-1 text-xs text-app-danger">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-app-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("sftp.loading")}
          </div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-sm text-app-muted">{t("sftp.empty")}</div>
        ) : (
          <ul className="divide-y divide-app-border">
            {entries.map((entry) => (
              <li
                key={entry.name}
                role="button"
                tabIndex={0}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-app-panel",
                  selected === entry.name && "bg-app-panel",
                )}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (entry.isDir) handleEntryDoubleClick(entry);
                    else handleEntryClick(entry);
                  }
                }}
              >
                {entry.isDir ? (
                  <Folder className="h-4 w-4 shrink-0 text-app-accent" />
                ) : entry.isSymlink ? (
                  <FolderCog className="h-4 w-4 shrink-0 text-app-muted" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0 text-app-muted" />
                )}
                <span className="min-w-0 flex-1 truncate" title={entry.name}>
                  {entry.name}
                </span>
                {entry.isFile && (
                  <span className="shrink-0 text-xs text-app-muted">{formatSize(entry.size)}</span>
                )}
                <span className="hidden shrink-0 text-xs text-app-muted sm:inline">
                  {formatTime(entry.modifiedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
