import { CalendarClock, Flag, Hand } from "lucide-react";

import { getReleaseConditionText } from "../lib/format";
import { useI18n } from "../lib/i18n";

const icons = { 1: Hand, 2: CalendarClock, 3: Flag } as const;

// A squared neutral tag: release is a setting, not a state, so it carries no color.
// The icon tells the three conditions apart without borrowing the status hues.
export function ReleaseConditionBadge({ condition }: { condition?: number }) {
  const { locale } = useI18n();
  const value = Number(condition);
  const Icon = value === 1 || value === 2 || value === 3 ? icons[value] : null;

  return (
    <span className="inline-flex min-w-20 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] bg-app-neutralSoft px-2 py-0.5 text-xs font-medium leading-5 text-app-text">
      {Icon ? <Icon className="h-3 w-3 shrink-0 text-app-muted" aria-hidden="true" /> : null}
      {getReleaseConditionText(condition, locale)}
    </span>
  );
}
