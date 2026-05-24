import { describe, expect, it } from "vitest";

import {
  getTaskTemplateMarker,
  loadTaskTemplates,
  recordTaskTemplateUsage,
  saveTaskTemplates,
  taskMatchesTemplate,
  taskToEditableTaskTemplate,
  taskTemplateToPayloads,
} from "./task-templates";
import type { RuntimeStorage, TaskTemplate } from "./types";

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
