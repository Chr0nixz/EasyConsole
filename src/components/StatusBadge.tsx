import { getStatusText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { TaskStatus } from "../lib/types";
import { StatePill, type StateTone } from "./ui";

export function StatusBadge({ status }: { status?: TaskStatus }) {
  const { locale } = useI18n();
  const value = Number(status);
  // Exhausted (5) ended on a quota or balance limit, so it reads as trouble, not as idle.
  const tone: StateTone = value === 2 ? "info" : value === 6 ? "success" : value === 7 || value === 8 ? "danger" : value === 1 || value === 3 || value === 5 ? "warning" : "neutral";
  // A still dot in every state: running is the normal case, so it does not get to move.
  // Colors ease between states, so a task that changes status on refresh visibly morphs.
  return (
    <StatePill tone={tone} className="min-w-16 justify-center transition-[background-color,color,box-shadow] duration-300 ease-out">
      {getStatusText(status, locale)}
    </StatePill>
  );
}
