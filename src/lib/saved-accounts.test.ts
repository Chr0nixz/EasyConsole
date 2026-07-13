import { describe, expect, it } from "vitest";

import {
  createSavedLoginAccount,
  hasStoredPassword,
  parseSavedAccounts,
  removeSavedAccount,
  stringifySavedAccounts,
  upsertSavedAccount,
} from "./saved-accounts";

describe("saved accounts", () => {
  it("creates a stable account record from login result", () => {
    const account = createSavedLoginAccount({
      username: " alice ",
      token: "Bearer token",
      user: { id: 12, username: "alice-cn" },
      now: new Date("2026-05-23T00:00:00.000Z"),
    });

    expect(account).toMatchObject({
      id: "12",
      username: "alice",
      displayName: "alice-cn",
      token: "Bearer token",
      lastLoginAt: "2026-05-23T00:00:00.000Z",
    });
    expect(account.encryptedPassword).toBeUndefined();
  });

  it("preserves encryptedPassword when provided", () => {
    const account = createSavedLoginAccount({
      username: "alice",
      token: "Bearer token",
      encryptedPassword: "enc-blob",
    });
    expect(account.encryptedPassword).toBe("enc-blob");
    expect(hasStoredPassword(account)).toBe(true);
  });

  it("treats empty encryptedPassword as not stored", () => {
    const account = createSavedLoginAccount({
      username: "alice",
      token: "Bearer token",
      encryptedPassword: "   ",
    });
    expect(account.encryptedPassword).toBeUndefined();
    expect(hasStoredPassword(account)).toBe(false);
  });

  it("round-trips encryptedPassword through stringify/parse", () => {
    const account = createSavedLoginAccount({
      username: "alice",
      token: "Bearer token",
      encryptedPassword: "enc-blob",
    });
    const raw = stringifySavedAccounts([account]);
    const parsed = parseSavedAccounts(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].encryptedPassword).toBe("enc-blob");
  });

  it("ignores invalid stored data", () => {
    expect(parseSavedAccounts("{bad json")).toEqual([]);
    expect(parseSavedAccounts(JSON.stringify([{ id: "a", username: "alice" }, null]))).toEqual([]);
  });

  it("sorts parsed accounts by recent login time", () => {
    const raw = stringifySavedAccounts([
      createSavedLoginAccount({ username: "old", token: "1", now: new Date("2026-05-22T00:00:00.000Z") }),
      createSavedLoginAccount({ username: "new", token: "2", now: new Date("2026-05-23T00:00:00.000Z") }),
    ]);

    expect(parseSavedAccounts(raw).map((account) => account.username)).toEqual(["new", "old"]);
  });

  it("upserts one account per identity", () => {
    const first = createSavedLoginAccount({ username: "alice", token: "old", now: new Date("2026-05-22T00:00:00.000Z") });
    const second = createSavedLoginAccount({ username: "alice", token: "new", now: new Date("2026-05-23T00:00:00.000Z") });

    expect(upsertSavedAccount([first], second)).toEqual([second]);
  });

  it("removes an account by id", () => {
    const first = createSavedLoginAccount({ username: "alice", token: "1" });
    const second = createSavedLoginAccount({ username: "bob", token: "2" });

    expect(removeSavedAccount([first, second], first.id)).toEqual([second]);
  });
});
