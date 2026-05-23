import { cn } from "../lib/utils";
import { getStatusText } from "../lib/format";
import type { TaskStatus } from "../lib/types";

export function StatusBadge({ status }: { status?: TaskStatus }) {
  const value = Number(status);
  const tone = value === 2 ? "running" : value === 6 ? "success" : value === 7 || value === 8 ? "danger" : value === 1 || value === 3 ? "warning" : "neutral";
  return (
    <span
      className={cn(
        "inline-flex min-w-16 items-center justify-center rounded-md px-2 py-1 text-xs font-medium",
        tone === "running" && "bg-app-infoSoft text-app-info ring-1 ring-app-infoRing",
        tone === "success" && "bg-app-successSoft text-app-success ring-1 ring-app-successRing",
        tone === "danger" && "bg-app-dangerSoft text-app-danger ring-1 ring-app-dangerRing",
        tone === "warning" && "bg-app-warningSoft text-app-warning ring-1 ring-app-warningRing",
        tone === "neutral" && "bg-app-neutralSoft text-app-muted ring-1 ring-app-neutralRing",
      )}
    >
      {getStatusText(status)}
    </span>
  );
}
