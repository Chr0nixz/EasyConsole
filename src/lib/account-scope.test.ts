import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import {
  accountScopeKey,
  applyAccountQueryScope,
  makeAccountScope,
  normalizeApiRealm,
  resetAccountScope,
  setActiveAccountScope,
} from "./account-scope";
import { queryKeys } from "./query-keys";

afterEach(() => {
  resetAccountScope();
});

describe("account scope keys", () => {
  it("derives a stable, secret-free key from the username and API realm", () => {
    expect(accountScopeKey("  Alice ", "http://Console.Example/api/")).toBe("alice@console.example/api");
    // Scheme differences do not split the same console into two realms.
    expect(accountScopeKey("alice", "https://console.example/api/")).toBe("alice@console.example/api");
    expect(accountScopeKey("alice", "")).toBe("alice@default");
    expect(accountScopeKey("alice", "not a url")).toBe("alice@not a url");
  });

  it("separates the same username on different consoles", () => {
    expect(accountScopeKey("alice", "http://a.example/api")).not.toBe(accountScopeKey("alice", "http://b.example/api"));
  });

  it("normalizes API realms case-insensitively and drops trailing slashes", () => {
    expect(normalizeApiRealm("HTTP://Console.Example:28080/API//")).toBe("console.example:28080/api");
  });

  it("keeps a display name without leaking secrets into the key", () => {
    const scope = makeAccountScope("Alice", "Alice Zhang", "http://console.example/api");
    expect(scope).toEqual({ key: "alice@console.example/api", displayName: "Alice Zhang" });
    expect(scope.key).not.toContain("Bearer");
  });
});

describe("applyAccountQueryScope", () => {
  it("cancels and removes the previous account's cache; a late response never backfills", async () => {
    const queryClient = new QueryClient();
    setActiveAccountScope({ key: "a@console", displayName: "A" });
    const oldListKey = queryKeys.tasks.all;
    queryClient.setQueryData(oldListKey, { items: ["account-a-tasks"] });

    let releaseOldFetch: (value: unknown) => void = () => undefined;
    const oldFetchKey = [...oldListKey, "in-flight"];
    const lateFetch = queryClient
      .fetchQuery({
        queryKey: oldFetchKey,
        queryFn: () =>
          new Promise((resolve) => {
            releaseOldFetch = resolve;
          }),
      })
      .catch(() => undefined);

    await applyAccountQueryScope(queryClient, { key: "b@console", displayName: "B" });

    expect(queryKeys.tasks.all[1]).toBe("b@console");
    expect(queryClient.getQueryData(oldListKey)).toBeUndefined();

    // The in-flight account-A request resolves after the switch: its data must
    // land in neither the old nor the new account's cache entries.
    releaseOldFetch({ items: ["stale-account-a"] });
    await lateFetch;
    expect(queryClient.getQueryData(oldFetchKey)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.tasks.all)).toBeUndefined();
  });

  it("keeps the cache when the same account is re-applied (silent re-login)", async () => {
    const queryClient = new QueryClient();
    setActiveAccountScope({ key: "a@console", displayName: "A" });
    queryClient.setQueryData(queryKeys.tasks.all, { items: [1] });

    await applyAccountQueryScope(queryClient, { key: "a@console", displayName: "A (renamed)" });

    expect(queryClient.getQueryData(queryKeys.tasks.all)).toEqual({ items: [1] });
  });

  it("clears the cache when switching back to the anonymous scope on logout", async () => {
    const queryClient = new QueryClient();
    setActiveAccountScope({ key: "a@console", displayName: "A" });
    queryClient.setQueryData(queryKeys.images.all, { items: [1] });

    await applyAccountQueryScope(queryClient, { key: "anonymous", displayName: "" });

    expect(queryKeys.images.all[1]).toBe("anonymous");
    expect(queryClient.getQueryData(["account", "a@console", "images"])).toBeUndefined();
  });
});
