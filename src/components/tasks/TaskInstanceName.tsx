import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useI18n } from "../../lib/i18n";
import { parseTemplateTaskName } from "../../lib/task-templates";

type TaskInstanceNameProps = {
  name: string;
  /** When set, the display name links to the task detail page. */
  taskId?: string | number;
  className?: string;
  compact?: boolean;
};

function nameLinkClass(compact: boolean) {
  return [
    "min-w-0 break-all text-app-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40",
    compact ? "text-sm font-semibold" : "font-medium",
  ].join(" ");
}

export function TaskInstanceName({ name, taskId, className = "", compact = false }: TaskInstanceNameProps) {
  const { text } = useI18n();
  const parsed = useMemo(() => parseTemplateTaskName(name), [name]);
  const [expanded, setExpanded] = useState(false);
  const detailHref = taskId !== undefined && taskId !== null && String(taskId) !== "" ? `/tasks/${taskId}` : null;
  const detailLabel = text(`查看实例 ${name} 详情`, `View details for ${name}`);

  if (!parsed) {
    if (detailHref) {
      return (
        <Link to={detailHref} className={[nameLinkClass(compact), className].join(" ")} title={detailLabel} aria-label={detailLabel}>
          {name}
        </Link>
      );
    }
    return <span className={className}>{name}</span>;
  }

  const displayName = expanded ? parsed.full : parsed.suffix;
  const toggleLabel = expanded
    ? text("收起模板前缀", "Collapse template prefix")
    : text(`展开完整名称（模板前缀：${parsed.prefix}）`, `Expand full name (template prefix: ${parsed.prefix})`);

  return (
    <span
      className={[
        "group inline-flex max-w-full items-start gap-1 text-left",
        compact ? "text-sm font-semibold text-app-text" : "font-medium text-app-text",
        className,
      ].join(" ")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={toggleLabel}
        title={toggleLabel}
        className="mt-0.5 shrink-0 rounded text-app-muted hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      {detailHref ? (
        <Link to={detailHref} className={nameLinkClass(compact)} title={detailLabel} aria-label={detailLabel}>
          {displayName}
        </Link>
      ) : (
        <span className="min-w-0 break-all">{displayName}</span>
      )}
    </span>
  );
}
