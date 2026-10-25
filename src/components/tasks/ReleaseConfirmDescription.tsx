import { formatCost, formatSecondsDuration, getTaskName } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import type { Task } from "../../lib/types";

/**
 * What releasing this instance costs the user, shown in every release confirm (table row,
 * detail page, command palette): which job, how long it ran, what it has billed so far,
 * and what does not survive the release.
 */
export function ReleaseConfirmDescription({ task }: { task: Task }) {
  const { locale, text } = useI18n();
  const name = getTaskName(task);
  const runtime = Number(task.use_time);
  const cost = Number(task.cost);
  const storagePath = typeof task.storage_path === "string" && task.storage_path.trim() ? task.storage_path.trim() : "";

  return (
    <div className="space-y-3">
      <p>
        {text("将释放 ", "Release ")}
        <span className="font-medium text-app-text">{name}</span>
        {text("：停止实例、回收计算资源，计费随之停止。", ": the instance stops, its compute is reclaimed, and billing stops.")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md bg-app-panel px-3 py-2 text-xs leading-5">
        <dt>{text("已运行", "Running for")}</dt>
        <dd className="app-numeric text-app-text">{Number.isFinite(runtime) && runtime > 0 ? formatSecondsDuration(runtime, locale) : "—"}</dd>
        <dt>{text("已产生费用", "Billed so far")}</dt>
        <dd className="app-numeric text-app-text">{Number.isFinite(cost) && cost > 0 ? formatCost(cost, locale) : "—"}</dd>
        {storagePath ? (
          <>
            <dt>{text("存储路径", "Storage path")}</dt>
            <dd className="truncate font-mono text-app-text" title={storagePath}>{storagePath}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs leading-5">
        {text(
          "容器内的本地临时数据会被清理，无法找回；需要保留的结果请先确认已写入存储路径。此操作不可从 EasyConsole 撤销。",
          "Local data inside the container is destroyed and cannot be recovered; make sure results you need are written to the storage path first. EasyConsole cannot undo this.",
        )}
      </p>
    </div>
  );
}

function sumField(tasks: Task[], field: "gpu" | "cost") {
  return tasks.reduce((total, task) => {
    const value = Number(task[field]);
    return Number.isFinite(value) && value > 0 ? total + value : total;
  }, 0);
}

/**
 * The batch counterpart of {@link ReleaseConfirmDescription}: the same consequences,
 * summed over the selection, so releasing many jobs never reads lighter than one.
 */
export function BatchReleaseImpact({ tasks }: { tasks: Task[] }) {
  const { locale, text } = useI18n();
  const gpus = sumField(tasks, "gpu");
  const cost = sumField(tasks, "cost");
  const longestRuntime = tasks.reduce((longest, task) => {
    const value = Number(task.use_time);
    return Number.isFinite(value) && value > longest ? value : longest;
  }, 0);
  const storagePaths = new Set(
    tasks.map((task) => (typeof task.storage_path === "string" ? task.storage_path.trim() : "")).filter(Boolean),
  );

  return (
    <div className="space-y-3">
      <p>
        {text("将释放 ", "Release ")}
        <span className="font-medium text-app-text">{text(`${tasks.length} 个实例`, `${tasks.length} instance${tasks.length === 1 ? "" : "s"}`)}</span>
        {text("：逐个停止实例、回收计算资源，计费随之停止。", ": each instance stops, its compute is reclaimed, and billing stops.")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md bg-app-panel px-3 py-2 text-xs leading-5">
        <dt>{text("合计 GPU", "GPUs in total")}</dt>
        <dd className="app-numeric text-app-text">{gpus > 0 ? gpus : "—"}</dd>
        <dt>{text("已产生费用（合计）", "Billed so far (total)")}</dt>
        <dd className="app-numeric text-app-text">{cost > 0 ? formatCost(cost, locale) : "—"}</dd>
        <dt>{text("最长已运行", "Longest running")}</dt>
        <dd className="app-numeric text-app-text">{longestRuntime > 0 ? formatSecondsDuration(longestRuntime, locale) : "—"}</dd>
        <dt>{text("存储路径", "Storage paths")}</dt>
        <dd className="app-numeric text-app-text">{storagePaths.size > 0 ? text(`${storagePaths.size} 个，逐项见下方`, `${storagePaths.size}, listed per item below`) : "—"}</dd>
      </dl>
      <p className="text-xs leading-5">
        {text(
          "每个容器内的本地临时数据都会被清理，无法找回；需要保留的结果请先确认已写入各自的存储路径。",
          "Local data inside every container is destroyed and cannot be recovered; make sure results you need are written to each storage path first.",
        )}
      </p>
    </div>
  );
}
