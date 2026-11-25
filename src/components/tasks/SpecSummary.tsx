import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The footer summary every instance form ends on (create, clone, template, scheduled plan):
 * one line of what the submit commits to, a detail line, and the billing consequence. One
 * shape, so the cost of a template or a plan never reads lighter than a create's.
 */
export function SpecSummary({
  label,
  headline,
  detail,
  note,
  noteId,
  warning = false,
}: {
  label: string;
  /** Short facts, in reading order: count, rate, GPUs, release. Empty entries are skipped. */
  headline: Array<ReactNode | null | false | undefined>;
  detail?: ReactNode;
  note?: ReactNode;
  /** Lets the submit button point its description at the note. */
  noteId?: string;
  warning?: boolean;
}) {
  const parts = headline.filter((part) => part !== null && part !== false && part !== undefined && part !== "");
  return (
    <div className="min-w-0 flex-1 text-xs text-app-muted" role="group" aria-label={label}>
      <p className="app-numeric flex flex-wrap gap-x-3 gap-y-1 font-medium text-app-text">
        {parts.map((part, index) => <span key={index}>{part}</span>)}
      </p>
      {detail ? <div className="mt-1 truncate">{detail}</div> : null}
      {note ? (
        <p id={noteId} className={cn("mt-1 flex gap-1.5 leading-5", warning && "text-app-warningText")}>
          {warning ? (
            <>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{note}</span>
            </>
          ) : note}
        </p>
      ) : null}
    </div>
  );
}

/** The footer bar itself: pinned under a scrolling form body, summary on the left, actions on the right. */
export const SPEC_FOOTER_CLASS =
  "flex shrink-0 flex-col gap-3 border-t border-app-border bg-app-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between";
