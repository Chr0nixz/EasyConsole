import { useEffect, useState } from "react";

import { formatRelativeUpdatedAt } from "../lib/format";
import { useI18n } from "../lib/i18n";

/**
 * Self-ticking "x seconds ago" label. Each instance owns its timer so pages no
 * longer need a shared `nowMs` state that re-renders the whole tree every few
 * seconds just to refresh one timestamp. `updatedAt` is clamped against `now`
 * so a clock hiccup can never render a negative age.
 */
export function RelativeUpdatedAt({
  updatedAt,
  intervalMs = 5_000,
  className,
}: {
  updatedAt: number;
  /** Tick rate; live feeds pass 1_000, idle labels 5_000–10_000. */
  intervalMs?: number;
  className?: string;
}) {
  const { locale } = useI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return <span className={className}>{formatRelativeUpdatedAt(updatedAt, Math.max(nowMs, updatedAt), locale)}</span>;
}
