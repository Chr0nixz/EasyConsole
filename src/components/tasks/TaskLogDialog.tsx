import { useQuery } from "@tanstack/react-query";

import { ErrorState, LoadingState } from "../DataState";
import { Dialog } from "../ui";
import { instanceApi } from "../../lib/api";
import { getTaskName } from "../../lib/format";
import type { Task } from "../../lib/types";

export function TaskLogDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: ["task-log", task?.task_id ?? task?.id],
    queryFn: () => instanceApi.taskLog(task!),
    enabled: Boolean(task),
  });

  return (
    <Dialog open={Boolean(task)} title={`任务日志 ${task ? getTaskName(task) : ""}`} onClose={onClose} width="max-w-5xl">
      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} />
      ) : (
        <pre className="max-h-[70vh] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
          {query.data || "暂无日志输出"}
        </pre>
      )}
    </Dialog>
  );
}
