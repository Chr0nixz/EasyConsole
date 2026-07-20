import { Code2, Copy, KeyRound, Server, Terminal } from "lucide-react";
import { useMemo, useState } from "react";

import { getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { browserRuntime } from "../../lib/runtime";
import { buildTaskSshInfo, toSshConnectionRequest } from "../../lib/ssh-info";
import type { SshConnectionRequest, Task } from "../../lib/types";
import { useAuth } from "../../lib/use-auth";
import { useToast } from "../../lib/use-toast";
import { Button, Dialog } from "../ui";
import { AppSshTerminalDialog } from "./AppSshTerminalDialog";

function InfoRow({
  label,
  value,
  sensitive,
  onCopy,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
  onCopy: (value: string, label: string) => void;
}) {
  const { text } = useI18n();
  const hasValue = value && value !== "-";

  return (
    <div className="grid gap-2 border-b border-app-border px-4 py-3 last:border-0 sm:grid-cols-[7rem_1fr_auto] sm:items-center">
      <div className="text-xs font-medium uppercase tracking-wide text-app-muted">{label}</div>
      <code className="min-w-0 overflow-x-auto whitespace-nowrap rounded-md bg-app-panel px-2.5 py-2 font-mono text-xs text-app-text">
        {sensitive && hasValue ? "••••••••" : value}
      </code>
      <Button
        className="h-8 px-2"
        disabled={!hasValue}
        type="button"
        variant="secondary"
        onClick={() => onCopy(value, label)}
      >
        <Copy className="h-4 w-4" />
        {text("复制", "Copy")}
      </Button>
    </div>
  );
}

export function TerminalDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const toast = useToast();
  const { text } = useI18n();
  const auth = useAuth();
  const [appSshRequest, setAppSshRequest] = useState<SshConnectionRequest | null>(null);
  const [isOpeningVscode, setIsOpeningVscode] = useState(false);
  const loginUsername = auth.user?.username ?? "";
  const sshInfo = useMemo(
    () => (task ? buildTaskSshInfo(task, { loginUsername }) : null),
    [task, loginUsername],
  );
  const canConnect = Boolean(sshInfo && sshInfo.host !== "-" && sshInfo.command !== "-");

  const copyValue = (value: string, label: string) => {
    if (!value || value === "-") return;
    void browserRuntime
      .copyText(value)
      .then(() => toast.success(text("已复制", "Copied"), label))
      .catch(() => toast.error(text("复制失败", "Copy failed"), text("当前浏览器不允许写入剪贴板", "The current browser does not allow clipboard writes")));
  };

  const openAppSsh = () => {
    if (!sshInfo || !canConnect) return;
    setAppSshRequest(toSshConnectionRequest(sshInfo));
  };

  const openSystemSsh = () => {
    if (!sshInfo || !canConnect) return;
    const request = toSshConnectionRequest(sshInfo);
    void browserRuntime
      .openSystemSshTerminal(request)
      .then(() => toast.success(text("已打开系统终端", "System terminal opened"), sshInfo.taskName))
      .catch((error) => {
        const message = error instanceof Error ? error.message : text("请确认桌面端 SSH 能力已配置", "Confirm desktop SSH support is configured");
        toast.error(text("系统终端打开失败", "Failed to open system terminal"), message);
      });
  };

  const openVscodeSsh = () => {
    if (!sshInfo || !canConnect || isOpeningVscode) return;
    const request = toSshConnectionRequest(sshInfo);
    setIsOpeningVscode(true);
    void browserRuntime
      .openVscodeSsh(request)
      .then(() => toast.success(text("已打开 VS Code", "VS Code opened"), sshInfo.taskName))
      .catch((error) => {
        const message = error instanceof Error ? error.message : text("请确认已安装 VS Code 和 Remote - SSH 扩展", "Confirm VS Code and the Remote - SSH extension are installed");
        toast.error(text("VS Code 打开失败", "Failed to open VS Code"), message);
      })
      .finally(() => setIsOpeningVscode(false));
  };

  return (
    <>
      <Dialog
        open={Boolean(task)}
        title={text(`SSH 连接信息 ${task ? getTaskName(task) : ""}`, `SSH Connection ${task ? getTaskName(task) : ""}`)}
        onClose={onClose}
        width="max-w-3xl"
      >
        {task && sshInfo ? (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border pb-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-app-border bg-app-panel text-app-accent">
                  <Server className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-app-text">{getTaskName(task)}</div>
                  <div className="mt-1 font-mono text-xs text-app-muted">#{task.task_id ?? task.id}</div>
                </div>
              </div>
              {browserRuntime.supportsInAppSsh || browserRuntime.supportsSystemTerminal ? (
                <div className="flex flex-wrap items-center gap-2">
                  {browserRuntime.supportsInAppSsh ? (
                    <Button disabled={!canConnect} type="button" variant="secondary" onClick={openAppSsh}>
                      <Terminal className="h-4 w-4" />
                      {text("应用内 SSH", "In-app SSH")}
                    </Button>
                  ) : null}
                  {browserRuntime.supportsSystemTerminal ? (
                    <>
                      <Button disabled={!canConnect || isOpeningVscode} type="button" variant="secondary" onClick={openVscodeSsh}>
                        <Code2 className="h-4 w-4" />
                        {isOpeningVscode ? text("配置中", "Configuring") : "VS Code"}
                      </Button>
                      <Button disabled={!canConnect} type="button" onClick={openSystemSsh}>
                        <Terminal className="h-4 w-4" />
                        {text("系统终端", "System terminal")}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-lg border border-app-border">
              <InfoRow label="Host" value={sshInfo.host} onCopy={copyValue} />
              <InfoRow label="Port" value={sshInfo.port} onCopy={copyValue} />
              <InfoRow label="Username" value={sshInfo.username} onCopy={copyValue} />
              <InfoRow label="Password" value={sshInfo.password} sensitive onCopy={copyValue} />
              <InfoRow label={text("SSH 命令", "SSH Command")} value={sshInfo.command} onCopy={copyValue} />
            </div>

            <div className="grid gap-3 rounded-lg border border-app-border bg-app-panel p-3 text-sm text-app-muted sm:grid-cols-[auto_1fr]">
              <KeyRound className="h-4 w-4 text-app-warning" />
              <p className="leading-5">
                {text("SSH 信息来自实例列表返回字段。未返回密码时优先使用当前账号设置中的默认密码，否则使用登录用户名。若 Host 或 Port 为空，请刷新实例列表或查看原始 JSON。", "SSH information comes from fields returned by the instance list. When no password is returned, the current account's default password setting is used, otherwise the login username. If Host or Port is empty, refresh the instance list or inspect the raw JSON.")}
              </p>
              <Terminal className="h-4 w-4 text-app-accent" />
              <p className="leading-5">
                {browserRuntime.supportsInAppSsh || browserRuntime.supportsSystemTerminal
                  ? text("桌面端和平板可选择应用内 SSH 自动登录；桌面端还可通过 VS Code Remote-SSH 或系统终端连接；网页端请复制 SSH 命令后在本机终端中执行。", "Desktop and tablet can use in-app SSH auto sign-in. Desktop also supports VS Code Remote-SSH or system terminal. On web, copy the SSH command and run it in your local terminal.")
                  : text("当前环境不能直接建立 SSH 连接，请复制 SSH 命令后在本机终端中执行。", "This environment cannot establish SSH directly. Copy the SSH command and run it in your local terminal.")}
              </p>
            </div>
          </div>
        ) : null}
      </Dialog>
      <AppSshTerminalDialog request={appSshRequest} onClose={() => setAppSshRequest(null)} />
    </>
  );
}
