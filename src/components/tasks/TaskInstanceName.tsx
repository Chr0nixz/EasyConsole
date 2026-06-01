import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n } from "../../lib/i18n";
import { parseTemplateTaskName } from "../../lib/task-templates";

type TaskInstanceNameProps = {
  name: string;
  className?: string;
  compact?: boolean;
};

export function TaskInstanceName({ name, className = "", compact = false }: TaskInstanceNameProps) {
  const { text } = useI18n();
  const parsed = useMemo(() => parseTemplateTaskName(name), [name]);
  const [expanded, setExpanded] = useState(false);

  if (!parsed) {
    return <span className={className}>{name}</span>;
  }

  const displayName = expanded ? parsed.full : parsed.suffix;
  const toggleLabel = expanded
    ? text("收起模板前缀", "Collapse template prefix")
    : text(`展开完整名称（模板前缀：${parsed.prefix}）`, `Expand full name (template prefix: ${parsed.prefix})`);

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={toggleLabel}
      title={toggleLabel}
      className={[
        "group inline-flex max-w-full items-start gap-1 text-left",
        compact ? "text-sm font-semibold text-app-text" : "font-medium text-app-text",
        className,
      ].join(" ")}
      onClick={() => setExpanded((current) => !current)}
    >
      {expanded ? (
        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-muted" aria-hidden="true" />
      ) : (
        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-muted" aria-hidden="true" />
      )}
      <span className="min-w-0 break-all">{displayName}</span>
    </button>
  );
}
