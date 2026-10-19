import { Code2, Copy, KeyRound, KeySquare, Server, Terminal } from "lucide-react";
import { useMemo, useState } from "react";

import { getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { browserRuntime } from "../../lib/runtime";
import { buildTaskSshInfo, findSshConnectionIssue, resolveSshConnectionRequest, toSshConnectionRequest } from "../../lib/ssh-info";
import { canConnectTaskSsh } from "../../lib/task-terminal";
import type { SshConnectionRequest, Task } from "../../lib/types";
import { useAuth } from "../../lib/use-auth";
import { useConfirmAction } from "../../lib/use-confirm-action";
import { useSshWorkspace } from "../../lib/use-ssh-workspace";
import { useToast } from "../../lib/use-toast";
import { Button } from "../ui";

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
      <div className="text-xs font-medium text-app-muted">{label}</div>
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

export function TaskSshPanel({
  task,
  onOpenAppSsh,
}: {
  task: Task;
  onOpenAppSsh?: (request: SshConnectionRequest) => void;
}) {
  const toast = useToast();
  const confirmAction = useConfirmAction();
  const { text } = useI18n();
  const auth = useAuth();
  const sshWorkspace = useSshWorkspace();
  const [isOpeningVscode, setIsOpeningVscode] = useState(false);
  const loginUsername = auth.user?.username ?? "";
  const sshInfo = useMemo(
    () => buildTaskSshInfo(task, { loginUsername }),
    [task, loginUsername],
  );
  const canConnect = canConnectTaskSsh(sshInfo);
  // The command text is composed only from validated fields; when an API
  // field fails validation the entries stay disabled and this explains why.
  const connectionIssue = useMemo(() => {
    if (sshInfo.host === "-" || sshInfo.command !== "-") return null;
    return findSshConnectionIssue(toSshConnectionRequest(sshInfo));
  }, [sshInfo]);
  // One resolver for every entry (in-app, system terminal, VS Code): task
  // fields win, SSH settings fill the gaps, so all three open the same target.
  const buildRequest = () => resolveSshConnectionRequest(toSshConnectionRequest(sshInfo));
  // Name the fallback honestly: the "password" row may hold the settings default
  // or the login username, and the copy toast repeats this label verbatim.
  const passwordLabel =
    sshInfo.passwordKind === "login-username"
      ? text("密码（回退为登录名）", "Password (fallback to login username)")
      : sshInfo.passwordKind === "settings-default"
        ? text("密码（来自设置默认值）", "Password (default from settings)")
        : text("密码", "Password");

  const copyValue = (value: string, label: string) => {
    if (!value || value === "-") return;
    void browserRuntime
      .copyText(value)
      .then(() => toast.success(text("已复制", "Copied"), label))
      .catch(() => toast.error(text("复制失败", "Copy failed"), text("当前浏览器不允许写入剪贴板", "The current browser does not allow clipboard writes")));
  };

  const openAppSsh = () => {
    if (!canConnect) return;
    const request = buildRequest();
    if (onOpenAppSsh) {
      onOpenAppSsh(request);
      return;
    }
    sshWorkspace.openTarget(request);
  };

  const openSystemSsh = () => {
    if (!canConnect) return;
    const request = buildRequest();
    void browserRuntime
      .openSystemSshTerminal(request)
      .then(() => toast.success(text("已打开系统终端", "System terminal opened"), sshInfo.taskName))
      .catch((error) => {
        const message = error instanceof Error ? error.message : text("请确认桌面端 SSH 能力已配置", "Confirm desktop SSH support is configured");
        toast.error(text("系统终端打开失败", "Failed to open system terminal"), message);
      });
  };

  const openVscodeSsh = () => {
    if (!canConnect || isOpeningVscode) return;
    const request = buildRequest();
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

  const revokeVscodeSsh = () => {
    if (!canConnect) return;
    const request = buildRequest();
    confirmAction.confirm({
      title: text("撤销 VS Code 免密配置", "Revoke VS Code passwordless setup"),
      description: text(
        "将从该主机 ~/.ssh/authorized_keys 中删除 EasyConsole 安装的公钥，并删除本机 SSH 配置块和专用私钥。若主机不可达，撤销会失败。",
        "This deletes the EasyConsole public key from the host's ~/.ssh/authorized_keys and removes the local SSH config block and dedicated key. The revoke fails if the host is unreachable.",
      ),
      confirmLabel: text("撤销", "Revoke"),
      tone: "danger",
      run: () => {
        void browserRuntime
          .revokeVscodeSsh(request, true)
          .then(() => toast.success(text("已撤销 VS Code 免密配置", "VS Code setup revoked"), sshInfo.taskName))
          .catch((error) => {
            const message = error instanceof Error ? error.message : text("撤销失败", "Revoke failed");
            toast.error(text("撤销 VS Code 免密配置失败", "Failed to revoke the VS Code setup"), message);
          });
      },
    });
  };

  return (
    <>
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
                  <Button disabled={!canConnect} type="button" variant="secondary" onClick={revokeVscodeSsh}>
                    <KeySquare className="h-4 w-4" />
                    {text("撤销免密", "Revoke key")}
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
          <InfoRow label={text("主机", "Host")} value={sshInfo.host} onCopy={copyValue} />
          <InfoRow label={text("端口", "Port")} value={sshInfo.port} onCopy={copyValue} />
          <InfoRow label={text("用户名", "Username")} value={sshInfo.username} onCopy={copyValue} />
          <InfoRow label={passwordLabel} value={sshInfo.password} sensitive onCopy={copyValue} />
          <InfoRow label={text("SSH 命令", "SSH Command")} value={sshInfo.command} onCopy={copyValue} />
        </div>

        {connectionIssue ? (
          <p className="rounded-lg border border-app-warning/40 bg-app-warning-soft p-3 text-sm leading-5 text-app-warning-text">
            {text("SSH 信息未通过连接校验，连接入口已禁用：", "SSH details failed connection validation; connect actions are disabled: ")}
            {connectionIssue}
          </p>
        ) : null}

        <div className="grid gap-3 rounded-lg border border-app-border bg-app-panel p-3 text-sm text-app-muted sm:grid-cols-[auto_1fr]">
          <KeyRound className="h-4 w-4 text-app-warning" />
          <p className="leading-5">
            {text("SSH 信息来自实例列表返回字段。未返回密码时优先使用当前账号设置中的默认密码，否则使用登录用户名。若主机或端口为空，请刷新实例列表或查看原始 JSON。", "SSH information comes from fields returned by the instance list. When no password is returned, the current account's default password setting is used, otherwise the login username. If host or port is empty, refresh the instance list or inspect the raw JSON.")}
          </p>
          <Terminal className="h-4 w-4 text-app-accent" />
          <p className="leading-5">
            {browserRuntime.supportsInAppSsh || browserRuntime.supportsSystemTerminal
              ? text("桌面端和平板可选择应用内 SSH 自动登录；桌面端还可通过 VS Code Remote-SSH 或系统终端连接。产品不提供浏览器 WebSSH 终端。", "Desktop and tablet can use in-app SSH auto sign-in. Desktop also supports VS Code Remote-SSH or system terminal. The product does not provide a browser WebSSH terminal.")
              : text("当前环境不能直接建立 SSH 连接，请复制 SSH 命令后在本机终端中执行。产品不提供浏览器 WebSSH 终端。", "This environment cannot establish SSH directly. Copy the SSH command and run it in your local terminal. The product does not provide a browser WebSSH terminal.")}
          </p>
        </div>
      </div>
      {confirmAction.confirmDialog}
    </>
  );
}
