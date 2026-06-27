import { describe, expect, it } from "vitest";

import {
  applyTemplateVariables,
  extractTemplateVariables,
  findMissingRequiredVariables,
  getTaskTemplateMarker,
  loadTaskTemplates,
  recordTaskTemplateUsage,
  resolveTemplateVariables,
  saveTaskTemplates,
  taskMatchesTemplate,
  taskToEditableTaskTemplate,
  taskTemplateToPayloads,
  parseTemplateTaskName,
} from "./task-templates";
import type { CreateTaskPayload, RuntimeStorage, TaskTemplate } from "./types";

function memoryStorage(): RuntimeStorage {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

const baseTemplate: TaskTemplate = {
  id: "template-1",
  name: "开发环境",
  taskNamePrefix: "dev",
  batchCount: 2,
  imageId: "12",
  cpu: 4,
  gpu: 1,
  memory: 16,
  storagePath: "/alice/project",
  mountPath: "/home/ubuntu/alice",
  releaseCondition: 2,
  releaseAfterHours: 3,
  usageCount: 0,
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
};

describe("task templates", () => {
  it("persists and reloads valid templates", async () => {
    const storage = memoryStorage();

    await saveTaskTemplates(storage, [baseTemplate]);

    await expect(loadTaskTemplates(storage)).resolves.toEqual([baseTemplate]);
  });

  it("loads legacy templates with zero usage count", async () => {
    const storage = memoryStorage();
    await storage.set("easy-console.taskTemplates", JSON.stringify([{ ...baseTemplate, usageCount: undefined }]));

    await expect(loadTaskTemplates(storage)).resolves.toEqual([baseTemplate]);
  });

  it("builds batch create payloads with generated names and release time", () => {
    const payloads = taskTemplateToPayloads(baseTemplate, new Date("2026-05-23T08:00:00"));
    const marker = getTaskTemplateMarker(baseTemplate);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      name: `dev-${marker}-202605230800-1`,
      price: 1,
      cpu: 4,
      gpu: 1,
      memory: 16,
      img: 12,
      storage_path: "/alice/project",
      mount_path: "/home/ubuntu/alice",
      releace_conditions: 2,
      releace_time: "2026-05-23 11:00:00",
    });
    expect(payloads[1]?.name).toBe(`dev-${marker}-202605230800-2`);
  });

  it("matches running tasks created from a template marker", () => {
    const marker = getTaskTemplateMarker(baseTemplate);

    expect(taskMatchesTemplate({ name: `dev-${marker}-202605230800-1` }, baseTemplate)).toBe(true);
    expect(taskMatchesTemplate({ name: "dev-202605230800-1" }, baseTemplate)).toBe(false);
  });
  it("parses template-generated task names into prefix and suffix", () => {
    const marker = getTaskTemplateMarker(baseTemplate);

    expect(parseTemplateTaskName(`dev-${marker}-202605230800-1`)).toEqual({
      full: `dev-${marker}-202605230800-1`,
      prefix: "dev",
      suffix: "202605230800-1",
    });
    expect(parseTemplateTaskName(`train-job-${marker}-202605230800-02`)).toEqual({
      full: `train-job-${marker}-202605230800-02`,
      prefix: "train-job",
      suffix: "202605230800-02",
    });
    expect(parseTemplateTaskName("manual-task")).toBeNull();
    expect(parseTemplateTaskName(`dev-${marker}-202605230800`)).toEqual({
      full: `dev-${marker}-202605230800`,
      prefix: "dev",
      suffix: "202605230800",
    });
  });


  it("records successful template usage", () => {
    const used = recordTaskTemplateUsage(baseTemplate, new Date("2026-05-23T12:00:00.000Z"));

    expect(used.usageCount).toBe(1);
    expect(used.lastUsedAt).toBe("2026-05-23T12:00:00.000Z");
    expect(used.updatedAt).toBe("2026-05-23T12:00:00.000Z");
  });

  it("builds an editable template from an existing task", () => {
    const template = taskToEditableTaskTemplate({
      id: "task-1",
      name: "train job",
      image_id: 12,
      cpu: 8,
      gpu: 2,
      memory: 32,
      storage_path: "/alice/data",
      mount_path: "/workspace",
      releace_conditions: 3,
      work_directory: "/alice/data",
      script_path: "/alice/data/run.sh",
    }, "alice");

    expect(template).toMatchObject({
      name: "train job 模板",
      taskNamePrefix: "train-job",
      batchCount: 1,
      imageId: "12",
      cpu: 8,
      gpu: 2,
      memory: 32,
      storagePath: "/alice/data",
      mountPath: "/workspace",
      releaseCondition: 3,
      workDirectory: "/alice/data",
      scriptPath: "/alice/data/run.sh",
    });
  });

  it("keeps task-end release script fields only for task-end templates", () => {
    const payload = taskTemplateToPayloads({
      ...baseTemplate,
      batchCount: 1,
      releaseCondition: 3,
      releaseAfterHours: undefined,
      workDirectory: "/alice/project",
      scriptPath: "/alice/project/run.sh",
    })[0];

    expect(payload).toMatchObject({
      releace_conditions: 3,
      work_directory: "/alice/project",
      script_path: "/alice/project/run.sh",
    });
    expect(payload.releace_time).toBeUndefined();
  });
});

describe("template variables", () => {
  const variableTemplate: TaskTemplate = {
    ...baseTemplate,
    batchCount: 1,
    taskNamePrefix: "dev-${user}",
    storagePath: "/${user}/project-${env}",
    mountPath: "/home/ubuntu/${user}",
    variables: [
      { key: "user", label: "User", required: true, defaultValue: "alice" },
      { key: "env", label: "Environment", defaultValue: "prod" },
      { key: "unused", label: "Unused" },
    ],
  };

  it("extracts placeholder keys from template string fields", () => {
    const keys = extractTemplateVariables(variableTemplate);
    expect(keys).toEqual(expect.arrayContaining(["user", "env"]));
    expect(keys).not.toContain("unused");
  });

  it("applies variable values to payload string fields", () => {
    const payload: CreateTaskPayload = {
      name: "dev-${user}-${env}",
      storage_path: "/${user}/${env}",
      mount_path: "/home/${user}",
      work_directory: "/work/${user}/${env}",
      script_path: "/scripts/${user}.sh",
    };
    const result = applyTemplateVariables(payload, { user: "bob", env: "staging" });
    expect(result).toEqual({
      name: "dev-bob-staging",
      storage_path: "/bob/staging",
      mount_path: "/home/bob",
      work_directory: "/work/bob/staging",
      script_path: "/scripts/bob.sh",
    });
  });

  it("leaves unmatched placeholders intact when no value is provided", () => {
    const payload: CreateTaskPayload = {
      name: "dev-${user}-${missing}",
      storage_path: "/${user}",
      mount_path: "/home",
    };
    const result = applyTemplateVariables(payload, { user: "alice" });
    expect(result.name).toBe("dev-alice-${missing}");
    expect(result.storage_path).toBe("/alice");
  });

  it("resolves variables by merging user input with defaults", () => {
    const resolved = resolveTemplateVariables(variableTemplate, { user: "bob" });
    expect(resolved).toEqual({ user: "bob", env: "prod", unused: "" });
  });

  it("finds missing required variables after resolution", () => {
    const template: TaskTemplate = {
      ...variableTemplate,
      variables: [
        { key: "user", required: true },
        { key: "env", required: true, defaultValue: "prod" },
        { key: "optional", required: false },
      ],
    };
    // env has a default, so after resolution it's satisfied; user is required and empty
    const resolved1 = resolveTemplateVariables(template, { env: "" });
    expect(findMissingRequiredVariables(template, resolved1)).toEqual(["user"]);
    // both satisfied
    const resolved2 = resolveTemplateVariables(template, { user: "alice", env: "" });
    expect(findMissingRequiredVariables(template, resolved2)).toEqual([]);
  });

  it("substitutes variables into generated payloads end-to-end", () => {
    const payloads = taskTemplateToPayloads(
      { ...variableTemplate, batchCount: 1 },
      new Date("2026-05-23T08:00:00"),
      { user: "bob", env: "staging" },
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.storage_path).toBe("/bob/project-staging");
    expect(payloads[0]?.mount_path).toBe("/home/ubuntu/bob");
  });

  it("normalizes and persists template variables", async () => {
    const storage = memoryStorage();
    const template: TaskTemplate = {
      ...baseTemplate,
      variables: [
        { key: "user", label: "User", required: true, defaultValue: "alice", description: "Username" },
        { key: "user", label: "Duplicate" }, // duplicate key should be dropped
        { key: "invalid-key", label: "Bad" }, // invalid key should be dropped
        { key: "valid_key", label: "Valid" },
      ],
    };
    await saveTaskTemplates(storage, [template]);
    const loaded = await loadTaskTemplates(storage);
    expect(loaded[0]?.variables).toEqual([
      { key: "user", label: "User", required: true, defaultValue: "alice", description: "Username" },
      { key: "valid_key", label: "Valid" },
    ]);
  });
});
