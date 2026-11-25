import { describe, expect, it } from "vitest";

import {
  DEFAULT_CREATE_TASK_UI_PREFS,
  initialReleaseCondition,
  parseCreateTaskUiPrefs,
  sectionsForFieldErrors,
  withLastReleaseCondition,
} from "./create-task-ui-prefs";

describe("create-task-ui-prefs", () => {
  it("returns defaults for empty or invalid input", () => {
    expect(parseCreateTaskUiPrefs(null)).toEqual(DEFAULT_CREATE_TASK_UI_PREFS);
    expect(parseCreateTaskUiPrefs("{")).toEqual(DEFAULT_CREATE_TASK_UI_PREFS);
  });

  it("parses stored section and script-env open state", () => {
    expect(
      parseCreateTaskUiPrefs(
        JSON.stringify({
          sections: { basic: true, resources: false, storage: false, release: true },
          scriptEnvOpen: true,
          syncNameWithExperimentId: true,
        }),
      ),
    ).toEqual({
      sections: { basic: true, resources: false, storage: false, release: true },
      scriptEnvOpen: true,
      syncNameWithExperimentId: true,
      lastReleaseConditionByAccount: {},
    });
  });

  it("fills missing section keys from defaults", () => {
    expect(parseCreateTaskUiPrefs(JSON.stringify({ sections: { resources: false } }))).toEqual({
      sections: { basic: true, resources: false, storage: true, release: true },
      scriptEnvOpen: false,
      syncNameWithExperimentId: false,
      lastReleaseConditionByAccount: {},
    });
  });

  it("starts each account on the release condition it last created with, manual when it has none", () => {
    const prefs = parseCreateTaskUiPrefs(JSON.stringify({ lastReleaseConditionByAccount: { alice: "2", bob: "9", carol: 3 } }));
    // Unknown values are dropped rather than trusted.
    expect(prefs.lastReleaseConditionByAccount).toEqual({ alice: "2" });
    expect(initialReleaseCondition(prefs, "alice")).toBe("2");
    expect(initialReleaseCondition(prefs, "dave")).toBe("1");

    const next = withLastReleaseCondition(prefs, "dave", "3");
    expect(initialReleaseCondition(next, "dave")).toBe("3");
    expect(initialReleaseCondition(next, "alice")).toBe("2");
    // No account, an unknown condition or no change leaves the prefs as they were.
    expect(withLastReleaseCondition(prefs, "", "2")).toBe(prefs);
    expect(withLastReleaseCondition(prefs, "alice", "5")).toBe(prefs);
    expect(withLastReleaseCondition(prefs, "alice", "2")).toBe(prefs);
  });

  it("maps field errors to sections", () => {
    expect(sectionsForFieldErrors({ name: "x", cpu: "y", scriptPath: "z" })).toEqual(
      expect.arrayContaining(["basic", "resources", "release"]),
    );
  });
});
