import { cn } from "../lib/utils";
import { getStatusText } from "../lib/format";
import type { TaskStatus } from "../lib/types";

export function StatusBadge({ status }: { status?: TaskStatus }) {
  const value = Number(status);
  const tone = value === 2 || value === 6 ? "success" : value === 7 || value === 8 ? "danger" : value === 1 || value === 3 ? "warning" : "neutral";
  return (
    <span
      className={cn(
        "inline-flex min-w-16 items-center justify-center rounded-md px-2 py-1 text-xs font-medium",
        tone === "success" && "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
        tone === "danger" && "bg-red-50 text-red-700 ring-1 ring-red-200",
        tone === "warning" && "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
        tone === "neutral" && "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
      )}
    >
      {getStatusText(status)}
    </span>
  );
}
