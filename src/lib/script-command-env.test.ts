import { describe, expect, it } from "vitest";

import {
  applyEnvToScriptCommand,
  envVarsFromLegacyExperimentId,
  findScriptEnvVarErrors,
  getScriptEnvValue,
  parseScriptCommandEnv,
  previewScriptCommand,
  upsertScriptEnvValue,
} from "./script-command-env";

describe("script-command-env", () => {
  it("parses multiple leading env assignments", () => {
    expect(parseScriptCommandEnv("FOO=1 BAR=two /alice/run.sh")).toEqual({
      env: [
        { key: "FOO", value: "1" },
        { key: "BAR", value: "two" },
      ],
      command: "/alice/run.sh",
    });
  });

  it("returns empty env when prefix is absent", () => {
    expect(parseScriptCommandEnv("/alice/run.sh")).toEqual({
      env: [],
      command: "/alice/run.sh",
    });
  });

  it("applies env vars before the script command", () => {
    expect(
      applyEnvToScriptCommand("/alice/run.sh", [
        { key: "EXPERIMENT_ID", value: "exp-2" },
        { key: "CUDA_VISIBLE_DEVICES", value: "0" },
      ]),
    ).toBe("EXPERIMENT_ID=exp-2 CUDA_VISIBLE_DEVICES=0 /alice/run.sh");
  });

  it("replaces existing env prefixes", () => {
    expect(applyEnvToScriptCommand("OLD=1 /alice/run.sh", [{ key: "NEW", value: "2" }])).toBe("NEW=2 /alice/run.sh");
  });

  it("strips prefixes when env list is empty", () => {
    expect(applyEnvToScriptCommand("OLD=1 /alice/run.sh", [])).toBe("/alice/run.sh");
  });

  it("previews an empty string when script path is blank", () => {
    expect(previewScriptCommand("", [{ key: "A", value: "1" }])).toBe("");
  });

  it("validates incomplete and invalid rows", () => {
    expect(findScriptEnvVarErrors([{ key: "FOO", value: "" }])).toMatchObject({ index: 0 });
    expect(findScriptEnvVarErrors([{ key: "1BAD", value: "x" }])).toMatchObject({ index: 0 });
    expect(findScriptEnvVarErrors([{ key: "OK", value: "a b" }])).toMatchObject({ index: 0 });
    expect(findScriptEnvVarErrors([{ key: "OK", value: "x" }])).toBeNull();
  });

  it("migrates legacy experiment id", () => {
    expect(envVarsFromLegacyExperimentId("exp-9")).toEqual([{ key: "EXPERIMENT_ID", value: "exp-9" }]);
    expect(envVarsFromLegacyExperimentId("exp-9", [{ key: "A", value: "1" }])).toEqual([{ key: "A", value: "1" }]);
  });

  it("reads and upserts env values by key", () => {
    expect(getScriptEnvValue([{ key: "EXPERIMENT_ID", value: "exp-1" }], "EXPERIMENT_ID")).toBe("exp-1");
    expect(upsertScriptEnvValue([{ key: "FOO", value: "1" }], "EXPERIMENT_ID", "exp-2")).toEqual([
      { key: "EXPERIMENT_ID", value: "exp-2" },
      { key: "FOO", value: "1" },
    ]);
    expect(upsertScriptEnvValue([{ key: "EXPERIMENT_ID", value: "old" }], "EXPERIMENT_ID", "new")).toEqual([
      { key: "EXPERIMENT_ID", value: "new" },
    ]);
    expect(upsertScriptEnvValue([{ key: "EXPERIMENT_ID", value: "old" }], "EXPERIMENT_ID", "")).toEqual([]);
  });
});
