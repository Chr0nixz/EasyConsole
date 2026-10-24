import {
  File as FileIcon,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderUp,
  HardDriveDownload,
  HardDriveUpload,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { browserRuntime } from "../../lib/runtime";
import { useI18n } from "../../lib/i18n";
import { useConfirmAction } from "../../lib/use-confirm-action";
import { useToast } from "../../lib/use-toast";
import type { SftpEntry, SftpProgress } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button, Input, ProgressBar } from "../ui";

type SftpPanelProps = {
  sessionId: string;
};

type TextFn = (zh: string, en: string) => string;

type SftpErrorState = {
  /** Localized, actionable message shown in the banner. */
  message: string;
  /** Original russh/io error string, kept inspectable via the banner tooltip. */
  raw: string;
  retry?: () => void;
} | null;

type PromptState =
  | {
      kind: "rename";
      initial: string;
      submit: (value: string) => void;
    }
  | {
      kind: "mkdir";
      submit: (value: string) => void;
    }
  | null;

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

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps common russh/sftp failure strings to bilingual, actionable copy.
 * Unrecognized errors fall through as the raw string; the banner tooltip
 * always keeps the original message inspectable.
 */
function describeSftpError(raw: string, text: TextFn): string {
  const lower = raw.toLowerCase();
  if (lower.includes("no such file") || lower.includes("nosuchfile") || lower.includes("not found")) {
    return text("路径不存在：请检查路径拼写后重试。", "Path not found: check the spelling and try again.");
  }
  if (lower.includes("permission denied")) {
    return text("权限不足：当前账号无权访问该路径。", "Permission denied: this account cannot access the path.");
  }
  if (
    lower.includes("disconnect") ||
    lower.includes("broken pipe") ||
    (lower.includes("connection") && (lower.includes("closed") || lower.includes("reset") || lower.includes("lost")))
  ) {
    return text("SSH 连接已断开：请重连会话后重试。", "SSH connection lost: reconnect the session and retry.");
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return text("操作超时：远端响应过慢，可稍后重试。", "The remote end was too slow; retry shortly.");
  }
  return raw;
}

export function SftpPanel({ sessionId }: SftpPanelProps) {
  const { t, text } = useI18n();
  const toast = useToast();
  const confirmAction = useConfirmAction();
  const [path, setPath] = useState<string>("~");
  const [pathInput, setPathInput] = useState<string>("~");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<SftpErrorState>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<SftpProgress | null>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [promptValue, setPromptValue] = useState<string>("");
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  // Latest refresh identity, so the retry thunk inside refresh can re-invoke it
  // without listing refresh in its own dependency array.
  const refreshRef = useRef<((target: string) => Promise<void>) | undefined>(undefined);

  const refresh = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await browserRuntime.sftpList(sessionId, target);
        list.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });
        setEntries(list);
        setPath(target);
        setPathInput(target);
        setSelected(null);
      } catch (e) {
        const raw = rawErrorMessage(e);
        // A failed navigation keeps the previous listing so one bad path does
        // not wipe the working view; the user retries or walks back up.
        setError({
          message: describeSftpError(raw, text),
          raw,
          retry: () => void refreshRef.current?.(target),
        });
      } finally {
        setLoading(false);
      }
    },
    [sessionId, text],
  );

  useEffect(() => {
    refreshRef.current = refresh;
  });

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

  const failWith = (e: unknown, retry: () => void) => {
    const raw = rawErrorMessage(e);
    setError({ message: describeSftpError(raw, text), raw, retry });
  };

  const openContainingFolder = (localPath: string) => {
    void browserRuntime.revealLocalPath(localPath).catch((e) => {
      toast.error(
        text("打开所在文件夹失败", "Failed to open containing folder"),
        rawErrorMessage(e) || text("请确认文件仍然存在。", "Check that the file still exists."),
      );
    });
  };

  const handleParent = useCallback(() => {
    void refresh(parentPath(path));
  }, [path, refresh]);

  const handlePathSubmit = useCallback(
    (e: ReactFormEvent) => {
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

  // Every local path the renderer sends to native must live under a
  // directory the user picked in a dialog (native enforces this), so each
  // pick registers its parent directory as an allowed root first. Awaited:
  // the following upload/download must not race the registration.
  const registerLocalRoot = async (localPath: string) => {
    const parent = localPath.replace(/[/\\][^/\\]+$/, "");
    if (!parent) return;
    try {
      await browserRuntime.sftpRegisterLocalRoot(sessionId, parent);
    } catch {
      // A failure surfaces on the next upload/download attempt.
    }
  };

  const runUpload = async (localPath: string, filename: string) => {
    try {
      setBusy(`upload:${filename}`);
      setProgress({ transferred: 0, total: 0 });
      const outcome = await browserRuntime.sftpUpload(sessionId, localPath, joinPath(path, filename));
      if (outcome.status === "canceled") {
        toast.info(text("传输已取消", "Transfer canceled"), filename);
        return;
      }
      toast.success(text("上传完成", "Upload complete"), filename);
      await refresh(path);
    } catch (e) {
      failWith(e, () => void runUpload(localPath, filename));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const handleUpload = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const localPath = await open({ multiple: false });
      if (!localPath || typeof localPath !== "string") return;
      await registerLocalRoot(localPath);
      const filename = localPath.split(/[/\\]/).pop() ?? "upload";
      // sftp.create truncates; confirm before clobbering an existing remote file.
      if (entries.some((entry) => entry.name === filename)) {
        confirmAction.confirm({
          title: text("确认覆盖远程文件", "Confirm Overwrite Remote File"),
          description: text(
            `远端已存在 ${filename}，上传将覆盖该文件。`,
            `${filename} already exists remotely; uploading will overwrite it.`,
          ),
          confirmLabel: text("上传", "Upload"),
          tone: "danger",
          run: () => void runUpload(localPath, filename),
        });
        return;
      }
      await runUpload(localPath, filename);
    } catch (e) {
      failWith(e, handleUpload);
    }
  };

  const runDownload = async (entry: SftpEntry, localPath: string) => {
    try {
      setBusy(`download:${entry.name}`);
      setProgress({ transferred: 0, total: entry.size });
      const outcome = await browserRuntime.sftpDownload(sessionId, joinPath(path, entry.name), localPath);
      if (outcome.status === "canceled") {
        toast.info(text("传输已取消", "Transfer canceled"), entry.name);
        return;
      }
      toast.success(text("下载完成", "Download complete"), localPath, {
        label: text("打开所在文件夹", "Open folder"),
        onClick: () => openContainingFolder(localPath),
      });
    } catch (e) {
      failWith(e, () => void runDownload(entry, localPath));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const handleDownload = async () => {
    if (!selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry || !entry.isFile) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const localPath = await save({ defaultPath: entry.name });
      if (!localPath) return;
      await registerLocalRoot(localPath);
      await runDownload(entry, localPath);
    } catch (e) {
      failWith(e, handleDownload);
    }
  };

  const runDelete = async (name: string) => {
    try {
      setBusy(`delete:${name}`);
      await browserRuntime.sftpDelete(sessionId, joinPath(path, name));
      await refresh(path);
    } catch (e) {
      failWith(e, () => void runDelete(name));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = () => {
    if (!selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry) return;
    confirmAction.confirm({
      title: text("删除文件", "Delete file"),
      description: text(
        `确定要删除 ${entry.name} 吗？`,
        `Delete ${entry.name}?`,
      ),
      confirmLabel: text("删除", "Delete"),
      tone: "danger",
      run: () => void runDelete(entry.name),
    });
  };

  const openPrompt = (next: Exclude<PromptState, null>) => {
    setPrompt(next);
    setPromptValue(next.kind === "rename" ? next.initial : "");
    setTimeout(() => promptInputRef.current?.focus(), 0);
  };

  const handleRename = () => {
    if (!selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry) return;
    openPrompt({
      kind: "rename",
      initial: entry.name,
      submit: async (newName) => {
        if (!newName || newName === entry.name) return;
        try {
          setBusy(`rename:${entry.name}`);
          await browserRuntime.sftpRename(sessionId, joinPath(path, entry.name), joinPath(path, newName));
          await refresh(path);
        } catch (e) {
          failWith(e, () => {
            setBusy(`rename:${entry.name}`);
            void browserRuntime
              .sftpRename(sessionId, joinPath(path, entry.name), joinPath(path, newName))
              .then(() => refreshRef.current?.(path))
              .catch(() => {});
          });
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const handleMkdir = () => {
    openPrompt({
      kind: "mkdir",
      submit: async (name) => {
        if (!name?.trim()) return;
        try {
          setBusy(`mkdir:${name}`);
          await browserRuntime.sftpMkdir(sessionId, joinPath(path, name.trim()));
          await refresh(path);
        } catch (e) {
          const trimmed = name.trim();
          failWith(e, () => {
            setBusy(`mkdir:${trimmed}`);
            void browserRuntime
              .sftpMkdir(sessionId, joinPath(path, trimmed))
              .then(() => refreshRef.current?.(path))
              .catch(() => {});
          });
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const closePrompt = useCallback(() => {
    setPrompt(null);
    setPromptValue("");
  }, []);

  const handlePromptSubmit = useCallback(
    (event: ReactFormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!prompt) return;
      const value = promptValue.trim();
      if (!value) return;
      const submit = prompt.submit;
      closePrompt();
      void submit(value);
    },
    [prompt, promptValue, closePrompt],
  );

  const handlePromptKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePrompt();
      }
    },
    [closePrompt],
  );

  const handleCancelTransfer = useCallback(() => {
    // The active progress event carries its transfer id, so canceling hits
    // exactly that upload/download rather than whichever started last.
    void browserRuntime.sftpCancel(sessionId, progress?.transferId).catch(() => {});
  }, [sessionId, progress?.transferId]);

  const selectedEntry = entries.find((e) => e.name === selected) ?? null;
  const progressPct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
    : null;

  const sftpToolButtonClass = "h-7 gap-1 px-1.5 text-xs";

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-app-surface">
      <form className="flex items-center gap-1 border-b border-app-border px-2 py-1.5" onSubmit={handlePathSubmit}>
        <Button variant="ghost" className={sftpToolButtonClass} type="button" onClick={handleParent} disabled={loading}>
          <FolderUp className="h-3.5 w-3.5" />
          {text("上级目录", "Parent directory")}
        </Button>
        <Input
          className="h-7 min-w-0 flex-1 text-xs"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder={text("路径", "Path")}
          spellCheck={false}
        />
        <Button variant="secondary" className="h-7 px-2 text-xs" type="submit">
          {text("打开", "Open")}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1 border-b border-app-border px-2 py-1.5">
        <Button variant="ghost" className={sftpToolButtonClass} onClick={handleUpload} disabled={!!busy}>
          <HardDriveUpload className="h-3.5 w-3.5" />
          {text("上传", "Upload")}
        </Button>
        <Button variant="ghost" className={sftpToolButtonClass} onClick={handleDownload} disabled={!!busy || !selectedEntry?.isFile}>
          <HardDriveDownload className="h-3.5 w-3.5" />
          {text("下载", "Download")}
        </Button>
        <Button variant="ghost" className={sftpToolButtonClass} onClick={handleMkdir} disabled={!!busy}>
          <FolderPlus className="h-3.5 w-3.5" />
          {text("新建目录", "New directory")}
        </Button>
        <Button variant="ghost" className={sftpToolButtonClass} onClick={handleRename} disabled={!!busy || !selected}>
          <Pencil className="h-3.5 w-3.5" />
          {text("重命名", "Rename")}
        </Button>
        <Button variant="ghost" className={sftpToolButtonClass} onClick={handleDelete} disabled={!!busy || !selected}>
          <Trash2 className="h-3.5 w-3.5" />
          {text("删除", "Delete")}
        </Button>
      </div>
      {progressPct !== null && (
        <div className="border-b border-app-border px-2 py-1">
          <div className="flex items-center justify-between text-xs text-app-muted">
            <span>{busy?.startsWith("upload") ? text("上传中...", "Uploading...") : text("下载中...", "Downloading...")}</span>
            <span className="flex items-center gap-2">
              <span>{progressPct}%</span>
              <button
                className="rounded px-1.5 py-0.5 underline-offset-2 hover:bg-app-panel"
                type="button"
                onClick={handleCancelTransfer}
              >
                {text("取消传输", "Cancel transfer")}
              </button>
            </span>
          </div>
          <ProgressBar
            className="mt-1 h-1"
            label={busy?.startsWith("upload") ? text("上传进度", "Upload progress") : text("下载进度", "Download progress")}
            value={progressPct}
          />
        </div>
      )}
      {error && (
        <div className="border-b border-app-border bg-app-dangerSoft px-2 py-1.5 text-xs text-app-danger" title={error.raw}>
          <div className="flex items-start justify-between gap-1">
            <span className="min-w-0 break-all">{error.message}</span>
            <button
              className="shrink-0 rounded px-1 hover:bg-app-danger/10"
              type="button"
              aria-label={text("关闭错误提示", "Dismiss error")}
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
          {error.retry ? (
            <button
              className="mt-1 rounded px-1.5 py-0.5 underline underline-offset-2 hover:bg-app-danger/10"
              type="button"
              onClick={error.retry}
            >
              {text("重试", "Retry")}
            </button>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-app-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {text("加载中...", "Loading...")}
          </div>
        ) : entries.length === 0 ? (
          error ? null : (
            <div className="py-8 text-center text-sm text-app-muted">{text("空目录", "Empty directory")}</div>
          )
        ) : (
          <ul className="divide-y divide-app-border">
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-app-panel focus-visible:-outline-offset-2",
                    selected === entry.name && "bg-app-panel",
                  )}
                  type="button"
                  aria-pressed={selected === entry.name}
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (entry.isDir) handleEntryDoubleClick(entry);
                      else handleEntryClick(entry);
                    }
                    if (event.key === " ") {
                      event.preventDefault();
                      handleEntryClick(entry);
                    }
                  }}
                >
                  {entry.isDir ? (
                    <Folder className="h-4 w-4 shrink-0 text-app-accent" />
                  ) : entry.isSymlink ? (
                    <FileSymlink className="h-4 w-4 shrink-0 text-app-muted" />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-app-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-app-muted" title={entry.longName}>
                    {entry.permissions}
                  </span>
                  {entry.isFile && (
                    <span className="shrink-0 text-xs text-app-muted">{formatSize(entry.size)}</span>
                  )}
                  <span className="hidden shrink-0 text-xs text-app-muted sm:inline">
                    {formatTime(entry.modifiedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {prompt ? (
        <div
          className="app-scrim absolute inset-0 z-30 flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-label={prompt.kind === "rename" ? text("重命名", "Rename") : text("新建目录", "New directory")}
          onKeyDown={handlePromptKeyDown}
        >
          <form
            className="w-full max-w-sm space-y-3 rounded-lg border border-app-border bg-app-elevated p-4 shadow-popover"
            onSubmit={handlePromptSubmit}
          >
            <h3 className="text-sm font-semibold text-app-text">
              {prompt.kind === "rename" ? text("重命名", "Rename") : text("新建目录", "New directory")}
            </h3>
            <input
              ref={promptInputRef}
              className="h-8 w-full rounded-md border border-app-borderStrong bg-app-surface px-2 text-sm text-app-text hover:border-app-muted"
              value={promptValue}
              onChange={(event) => setPromptValue(event.target.value)}
              placeholder={prompt.kind === "rename" ? text("输入新名称", "Enter new name") : text("输入目录名称", "Enter directory name")}
              spellCheck={false}
              autoFocus
            />
            <div className="flex flex-col-reverse gap-2 border-t border-app-border pt-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" type="button" onClick={closePrompt}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!promptValue.trim()}>
                {t("common.confirm")}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      {confirmAction.confirmDialog}
    </div>
  );
}
