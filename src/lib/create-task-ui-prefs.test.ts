import { describe, expect, it } from "vitest";

import {
  DEFAULT_CREATE_TASK_UI_PREFS,
  parseCreateTaskUiPrefs,
  sectionsForFieldErrors,
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
        }),
      ),
    ).toEqual({
      sections: { basic: true, resources: false, storage: false, release: true },
      scriptEnvOpen: true,
    });
  });

  it("fills missing section keys from defaults", () => {
    expect(parseCreateTaskUiPrefs(JSON.stringify({ sections: { resources: false } }))).toEqual({
      sections: { basic: true, resources: false, storage: true, release: true },
      scriptEnvOpen: false,
    });
  });

  it("maps field errors to sections", () => {
    expect(sectionsForFieldErrors({ name: "x", cpu: "y", scriptPath: "z" })).toEqual(
      expect.arrayContaining(["basic", "resources", "release"]),
    );
  });
});
