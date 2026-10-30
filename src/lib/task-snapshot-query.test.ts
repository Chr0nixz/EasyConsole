import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { resetAccountScope, setActiveAccountScope } from "./account-scope";
import {
  invalidateTaskQueries,
  nextNotificationPollInterval,
  taskSnapshotQueryKey,
  taskSnapshotQueryOptions,
  TASK_SNAPSHOT_POLL_INTERVAL,
  TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX,
} from "./task-snapshot-query";

afterEach(() => {
  resetAccountScope();
});

describe("nextNotificationPollInterval", () => {
  it("returns foreground interval when visible", () => {
    expect(nextNotificationPollInterval(120_000, false)).toBe(TASK_SNAPSHOT_POLL_INTERVAL);
  });

  it("exponentially backs off while hidden up to the max", () => {
    const first = nextNotificationPollInterval(TASK_SNAPSHOT_POLL_INTERVAL, true);
    expect(first).toBeGreaterThanOrEqual(60_000);
    const capped = nextNotificationPollInterval(TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX, true);
    expect(capped).toBe(TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX);
  });
});

describe("taskSnapshotQueryKey", () => {
  it("scopes the snapshot key to the active account", () => {
    setActiveAccountScope({ key: "alice@console", displayName: "Alice" });
    expect(taskSnapshotQueryKey()).toEqual(["account", "alice@console", "task-notification-watch"]);
  });

  it("changes when the account switches", () => {
    setActiveAccountScope({ key: "a@console", displayName: "A" });
    const before = taskSnapshotQueryKey();
    setActiveAccountScope({ key: "b@console", displayName: "B" });
    expect(taskSnapshotQueryKey()).not.toEqual(before);
  });

  it("uses the scoped key in the shared query options", () => {
    setActiveAccountScope({ key: "alice@console", displayName: "Alice" });
    const api = { tasks: async () => ({ items: [], raw: null }) } as unknown as Parameters<typeof taskSnapshotQueryOptions>[0];
    expect(taskSnapshotQueryOptions(api).queryKey).toEqual(["account", "alice@console", "task-notification-watch"]);
  });
});

describe("invalidateTaskQueries", () => {
  it("invalidates only the active account's task queries", async () => {
    setActiveAccountScope({ key: "a@console", displayName: "A" });
    const queryClient = new QueryClient();
    const accountAList = ["account", "a@console", "tasks", "list", 1, 20, "", "", "", ""] as const;
    const accountBList = ["account", "b@console", "tasks", "list", 1, 20, "", "", "", ""] as const;
    const accountBSnapshot = ["account", "b@console", "task-notification-watch"] as const;
    queryClient.setQueryData([...accountAList], { items: [] });
    queryClient.setQueryData([...accountBList], { items: [] });
    queryClient.setQueryData(taskSnapshotQueryKey(), { items: [] });
    queryClient.setQueryData([...accountBSnapshot], { items: [] });

    await invalidateTaskQueries(queryClient);

    expect(queryClient.getQueryState([...accountAList])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(taskSnapshotQueryKey())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState([...accountBList])?.isInvalidated).toBeFalsy();
  });
});
