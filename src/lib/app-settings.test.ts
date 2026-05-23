import { describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS, normalizeAppSettings, parseAppSettings, stringifyAppSettings } from "./app-settings";

describe("app settings", () => {
  it("falls back to defaults when stored data is missing or invalid", () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseAppSettings("{bad json")).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("normalizes runtime urls", () => {
    expect(
      normalizeAppSettings({
        apiBaseUrl: " http://example.com/api/ ",
        monitorDashboardUrl: " http://example.com/d/test/ ",
      }),
    ).toEqual({
      apiBaseUrl: "http://example.com/api",
      monitorDashboardUrl: "http://example.com/d/test",
    });
  });

  it("serializes normalized settings", () => {
    expect(JSON.parse(stringifyAppSettings({ apiBaseUrl: "http://a/api/", monitorDashboardUrl: "http://b/d/" }))).toEqual({
      apiBaseUrl: "http://a/api",
      monitorDashboardUrl: "http://b/d",
    });
  });
});
