import { AlarmClock, CalendarClock, Flag, Hand } from "lucide-react";
import { useEffect, useState } from "react";

import { getRuntimeSettings } from "../lib/app-settings";
import { getReleaseConditionText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { formatReleaseCountdown, formatReleaseTimeInput } from "../lib/task-release-notifications";
import { cn } from "../lib/utils";

const icons = { 1: Hand, 2: CalendarClock, 3: Flag } as const;

// A squared neutral tag: release is a setting, not a state, so it carries no color.
// The icon tells the three conditions apart without borrowing the status hues.
// A live timed release passes `releaseAt` and the tag says how long is left instead.
export function ReleaseConditionBadge({ condition, releaseAt }: { condition?: number; releaseAt?: number | null }) {
  const { locale } = useI18n();
  const value = Number(condition);
  const Icon = value === 1 || value === 2 || value === 3 ? icons[value] : null;

  if (value === 2 && typeof releaseAt === "number") return <ReleaseCountdownTag releaseAt={releaseAt} />;

  return (
    <span className="inline-flex min-w-20 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] bg-app-neutralSoft px-2 py-0.5 text-xs font-medium leading-5 text-app-text">
      {Icon ? <Icon className="h-3 w-3 shrink-0 text-app-muted" aria-hidden="true" /> : null}
      {getReleaseConditionText(condition, locale)}
    </span>
  );
}

// Inside the reminder window the countdown is the one thing worth color: the release
// destroys container-local data, and this is the moment an extension still helps.
function ReleaseCountdownTag({ releaseAt }: { releaseAt: number }) {
  const { locale, text } = useI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = releaseAt - nowMs;
  const urgent = remaining <= getRuntimeSettings().timedReleaseReminderLeadMs;
  const when = formatReleaseTimeInput(new Date(releaseAt));

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 py-0.5 text-xs font-medium leading-5",
        urgent ? "bg-app-warningSoft text-app-warningText" : "bg-app-neutralSoft text-app-text",
      )}
      title={text(`定时释放：${when}`, `Timed release: ${when}`)}
    >
      {/* Urgency changes the icon too, so it never rests on the warning hue alone. */}
      {urgent
        ? <AlarmClock className="h-3 w-3 shrink-0 text-app-warningText" aria-hidden="true" />
        : <CalendarClock className="h-3 w-3 shrink-0 text-app-muted" aria-hidden="true" />}
      {urgent ? <span className="sr-only">{text("即将释放：", "Releasing soon: ")}</span> : null}
      <span className="app-numeric">{formatReleaseCountdown(remaining, locale)}</span>
    </span>
  );
}
