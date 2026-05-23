import { getReleaseConditionText } from "../lib/format";
import { cn } from "../lib/utils";

export function ReleaseConditionBadge({ condition }: { condition?: number }) {
  const value = Number(condition);
  const tone = value === 1 ? "manual" : value === 2 ? "timed" : value === 3 ? "finished" : "neutral";

  return (
    <span
      className={cn(
        "inline-flex min-w-20 items-center justify-center rounded-md px-2 py-1 text-xs font-medium",
        tone === "manual" && "bg-app-infoSoft text-app-info ring-1 ring-app-infoRing",
        tone === "timed" && "bg-app-releaseTimedSoft text-app-releaseTimed ring-1 ring-app-releaseTimedRing",
        tone === "finished" && "bg-app-releaseFinishedSoft text-app-releaseFinished ring-1 ring-app-releaseFinishedRing",
        tone === "neutral" && "bg-app-neutralSoft text-app-muted ring-1 ring-app-neutralRing",
      )}
    >
      {getReleaseConditionText(condition)}
    </span>
  );
}
