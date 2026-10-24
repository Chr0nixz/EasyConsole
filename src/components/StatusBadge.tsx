import { cn } from "../lib/utils";
import { getStatusText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { TaskStatus } from "../lib/types";

export function StatusBadge({ status }: { status?: TaskStatus }) {
  const { locale } = useI18n();
  const value = Number(status);
  // Exhausted (5) ended on a quota or balance limit, so it reads as trouble, not as idle.
  const tone = value === 2 ? "running" : value === 6 ? "success" : value === 7 || value === 8 ? "danger" : value === 1 || value === 3 || value === 5 ? "warning" : "neutral";
  return (
    <span
      className={cn(
        // Colors ease between states, so a task that changes status on refresh visibly morphs.
        "inline-flex min-w-16 items-center justify-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-xs font-medium leading-5 transition-[background-color,color,box-shadow] duration-300 ease-out",
        tone === "running" && "bg-app-infoSoft text-app-info ring-1 ring-inset ring-app-infoRing",
        tone === "success" && "bg-app-successSoft text-app-success ring-1 ring-inset ring-app-successRing",
        tone === "danger" && "bg-app-dangerSoft text-app-danger ring-1 ring-inset ring-app-dangerRing",
        tone === "warning" && "bg-app-warningSoft text-app-warningText ring-1 ring-inset ring-app-warningRing",
        tone === "neutral" && "bg-app-neutralSoft text-app-muted ring-1 ring-inset ring-app-neutralRing",
      )}
    >
      {/* A still dot in every state: running is the normal case, so it does not get to move. */}
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {getStatusText(status, locale)}
    </span>
  );
}
