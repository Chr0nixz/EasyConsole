import { useIdleEvidence } from "../lib/idle-instance-state";
import { useI18n } from "../lib/i18n";
import type { Task } from "../lib/types";
import { StatePill } from "./ui";

/**
 * "Possibly idle" beside a running instance's status, for as long as the idle watcher
 * still judges it idle. A state, so it takes the pill shape; warning, because an idle
 * GPU is money spent on nothing. The title says how sure the judgement is.
 */
export function IdleInstancePill({ task, className }: { task: Pick<Task, "id" | "task_id" | "status">; className?: string }) {
  const { text } = useI18n();
  const evidence = useIdleEvidence(task);
  if (!evidence || Number(task.status) !== 2) return null;
  const detail = evidence === "gpu"
    ? text("GPU 利用率、CPU 与网络持续偏低（GPU 数据来自 SSH 会话采样）", "GPU utilization, CPU and network have stayed low (GPU sampled over SSH)")
    : text("CPU 与网络持续偏低；平台不提供 GPU 利用率，释放前请先查看监控", "CPU and network have stayed low; the platform exposes no GPU utilization, so check the monitor before releasing");
  return (
    <span className={className} title={detail}>
      <StatePill tone="warning">{text("可能闲置", "Possibly idle")}</StatePill>
      <span className="sr-only">{detail}</span>
    </span>
  );
}
