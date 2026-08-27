import { getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import type { SshConnectionRequest, Task } from "../../lib/types";
import { Drawer } from "../ui";
import { TaskSshPanel } from "./TaskSshPanel";

export function TerminalDialog({
  task,
  onClose,
  onOpenAppSsh,
}: {
  task: Task | null;
  onClose: () => void;
  /** When provided, in-app SSH is opened via the parent instead of an internal dialog. */
  onOpenAppSsh?: (request: SshConnectionRequest) => void;
}) {
  const { text } = useI18n();

  return (
    <Drawer
      open={Boolean(task)}
      title={text(`SSH 连接信息 ${task ? getTaskName(task) : ""}`, `SSH Connection ${task ? getTaskName(task) : ""}`)}
      onClose={onClose}
      width="max-w-3xl"
    >
      {task ? <TaskSshPanel task={task} onOpenAppSsh={onOpenAppSsh} /> : null}
    </Drawer>
  );
}
