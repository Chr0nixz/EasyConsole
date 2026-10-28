import { afterEach, describe, expect, it } from "vitest";

import { resetAccountScope, setActiveAccountScope } from "./account-scope";
import { queryKeys } from "./query-keys";

afterEach(() => {
  resetAccountScope();
});

describe("queryKeys", () => {
  it("defaults to the anonymous scope when no account is active", () => {
    expect(queryKeys.images.all).toEqual(["account", "anonymous", "images"]);
    expect(queryKeys.tasks.all).toEqual(["account", "anonymous", "tasks"]);
  });

  it("scopes image list/system keys to the active account", () => {
    setActiveAccountScope({ key: "alice@console.example/api", displayName: "Alice" });
    expect(queryKeys.images.list()).toEqual(["account", "alice@console.example/api", "images", "list"]);
    expect(queryKeys.images.system()).toEqual(["account", "alice@console.example/api", "images", "system"]);
    expect(queryKeys.images.all).toEqual(["account", "alice@console.example/api", "images"]);
  });

  it("includes sort fields in task list keys", () => {
    setActiveAccountScope({ key: "alice@console.example/api", displayName: "Alice" });
    expect(
      queryKeys.tasks.list({
        page: 2,
        pageSize: 50,
        keyword: "gpu",
        status: "2",
        sortBy: "name",
        sortDir: "asc",
      }),
    ).toEqual(["account", "alice@console.example/api", "tasks", "list", 2, 50, "gpu", "2", "name", "asc"]);
  });

  it("scopes task log snapshots to the active account", () => {
    setActiveAccountScope({ key: "alice@console.example/api", displayName: "Alice" });
    expect(queryKeys.tasks.log(12)).toEqual(["account", "alice@console.example/api", "tasks", "log", "12"]);
  });

  it("rebuilds keys under the next account after a switch", () => {
    setActiveAccountScope({ key: "a@console", displayName: "A" });
    const accountAList = queryKeys.images.list();
    const accountAAll = queryKeys.images.all;
    setActiveAccountScope({ key: "b@console", displayName: "B" });
    expect(queryKeys.images.list()).not.toEqual(accountAList);
    expect(queryKeys.images.all).not.toEqual(accountAAll);
    expect(queryKeys.images.list()[1]).toBe("b@console");
  });
});
