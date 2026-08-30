import { getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import type { Task } from "../../lib/types";
import { Drawer } from "../ui";
import { TaskLogPanel } from "./TaskLogPanel";

export function TaskLogDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { text } = useI18n();
  return (
    <Drawer
      open={Boolean(task)}
      title={text(`任务日志 ${task ? getTaskName(task) : ""}`, `Task Log ${task ? getTaskName(task) : ""}`)}
      onClose={onClose}
      width="max-w-5xl"
      mobileMode="fullscreen"
    >
      {task ? <TaskLogPanel task={task} /> : null}
    </Drawer>
  );
}
