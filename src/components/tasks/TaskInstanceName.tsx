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
  /**
   * Stretch the link's hit area over the nearest positioned ancestor, so a whole
   * mobile card opens the detail page. Controls in that card need `relative z-10`.
   */
  stretched?: boolean;
};

function nameLinkClass(compact: boolean, stretched: boolean) {
  return [
    // Wrap at hyphens first and mid-word only when a segment cannot fit. On touch screens the
    // padding gives the one-line link a ~40px hit area; the negative margins keep it out of layout.
    // A stretched link already covers its card, so it needs no padding of its own.
    "min-w-0 wrap-anywhere text-app-accent hover:underline",
    stretched
      ? "after:absolute after:inset-0 after:content-['']"
      : "[@media(pointer:coarse)]:-my-3 [@media(pointer:coarse)]:py-3",
    compact ? "text-sm font-semibold" : "font-medium",
  ].join(" ");
}

export function TaskInstanceName({ name, taskId, className = "", compact = false, stretched = false }: TaskInstanceNameProps) {
  const { text } = useI18n();
  const parsed = useMemo(() => parseTemplateTaskName(name), [name]);
  const [expanded, setExpanded] = useState(false);
  const detailHref = taskId !== undefined && taskId !== null && String(taskId) !== "" ? `/tasks/${taskId}` : null;
  const detailLabel = text(`查看实例 ${name} 详情`, `View details for ${name}`);

  if (!parsed) {
    if (detailHref) {
      return (
        <Link to={detailHref} className={[nameLinkClass(compact, stretched), className].join(" ")} title={detailLabel} aria-label={detailLabel}>
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
        className={["mt-0.5 shrink-0 rounded text-app-muted hover:text-app-text", stretched ? "relative z-10" : ""].join(" ")}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      {detailHref ? (
        <Link to={detailHref} className={nameLinkClass(compact, stretched)} title={detailLabel} aria-label={detailLabel}>
          {displayName}
        </Link>
      ) : (
        <span className="min-w-0 wrap-anywhere">{displayName}</span>
      )}
    </span>
  );
}
