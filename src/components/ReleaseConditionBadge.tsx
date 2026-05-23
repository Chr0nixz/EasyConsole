import { getReleaseConditionText } from "../lib/format";
import { cn } from "../lib/utils";

export function ReleaseConditionBadge({ condition }: { condition?: number }) {
  const value = Number(condition);
  const tone = value === 1 ? "manual" : value === 2 ? "timed" : value === 3 ? "finished" : "neutral";

  return (
    <span
      className={cn(
        "inline-flex min-w-20 items-center justify-center rounded-md px-2 py-1 text-xs font-medium",
        tone === "manual" && "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
        tone === "timed" && "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
        tone === "finished" && "bg-teal-50 text-teal-700 ring-1 ring-teal-200",
        tone === "neutral" && "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
      )}
    >
      {getReleaseConditionText(condition)}
    </span>
  );
}
