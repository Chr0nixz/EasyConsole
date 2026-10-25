import { useEffect, useState } from "react";

import { isPendingReviewEntry, listExecutionLedger, subscribeExecutionLedgerChanges } from "./execution-ledger";
import { browserRuntime } from "./runtime";

/** Route that opens the scheduled tasks page on its execution ledger. */
export const EXECUTION_LEDGER_ROUTE = "/scheduled-tasks?view=ledger";

/**
 * Scheduled executions whose remote result is uncertain and not yet reconciled.
 * Re-reads on every ledger write in this process and on window focus, so a run
 * recorded overnight shows up in the shell without opening the ledger.
 */
export function useExecutionReviewCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listExecutionLedger(browserRuntime.storage)
        .then((entries) => {
          if (!cancelled) setCount(entries.filter(isPendingReviewEntry).length);
        })
        .catch(() => {
          // The ledger page shows read errors; a badge just stays at its last value.
        });
    };
    refresh();
    const unsubscribe = subscribeExecutionLedgerChanges(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return count;
}
