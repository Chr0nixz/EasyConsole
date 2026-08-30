import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useState } from "react";

import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { useToast } from "../lib/use-toast";
import { cn } from "../lib/utils";

type MobileLongTextProps = {
  value: string | null | undefined;
  className?: string;
  copyValue?: string;
  copyable?: boolean;
  mono?: boolean;
  tone?: "default" | "muted" | "danger";
};

/**
 * Compact-list disclosure for paths, server messages, and operator notes.
 * Desktop tables retain their dense one-line presentation; mobile cards make
 * the complete value available without pushing every row open by default.
 */
export function MobileLongText({ value, className, copyValue, copyable = false, mono = false, tone = "default" }: MobileLongTextProps) {
  const { text } = useI18n();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const content = value ?? "";
  const canExpand = content.length > 88 || content.includes("\n");

  const toneClass = tone === "danger" ? "text-app-danger" : tone === "muted" ? "text-app-muted" : "text-app-text";

  if (!content.trim()) return <span className={cn("text-app-muted", className)}>-</span>;

  const copy = () => {
    void browserRuntime.copyText(copyValue ?? content).then(
      () => toast.success(text("已复制", "Copied"), copyValue ?? content),
      () => toast.error(text("复制失败", "Copy failed"), text("当前环境不允许写入剪贴板。", "The current environment cannot write to the clipboard.")),
    );
  };

  return (
    <div className={cn("min-w-0", toneClass, className)}>
      <div className={cn("break-words leading-5", !expanded && canExpand && "app-mobile-long-text-summary", mono && "font-mono text-xs")}>
        {content}
      </div>
      {(canExpand || copyable) ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {canExpand ? (
            <button
              className="inline-flex h-11 items-center gap-1 rounded px-2 text-xs font-medium text-app-accent hover:bg-app-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? text("收起", "Collapse") : text("展开", "Expand")}
            </button>
          ) : null}
          {copyable ? (
            <button
              className="inline-flex h-11 w-11 items-center justify-center rounded text-app-muted hover:bg-app-panel hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
              type="button"
              title={text("复制", "Copy")}
              aria-label={text("复制", "Copy")}
              onClick={copy}
            >
              <Copy className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
