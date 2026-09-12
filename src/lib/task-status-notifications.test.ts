import { describe, expect, it } from "vitest";

import { getImportantTaskStatusNotification, needsLogAttention } from "./task-status-notifications";
import type { Task } from "./types";

describe("task status notifications", () => {
  it("skips the initial task snapshot", () => {
    const task = { id: 1, name: "train", status: 6 } as Task;

    expect(getImportantTaskStatusNotification(task, undefined, "zh-CN")).toBeNull();
  });

  it("notifies when a task enters success", () => {
    const task = { id: 1, task_id: "task-1", name: "train", status: 6 } as Task;

    expect(getImportantTaskStatusNotification(task, 2, "zh-CN")).toMatchObject({
      kind: "success",
      event: "task.success",
      taskId: "task-1",
      title: "实例运行成功",
      body: "train：成功",
      tag: "easy-console-task-task-1-6",
    });
  });

  it("notifies when a task enters failure or abnormal states", () => {
    expect(getImportantTaskStatusNotification({ id: 1, name: "train", status: 7 } as Task, 2, "zh-CN")).toMatchObject({
      kind: "failure",
      event: "task.failure",
      title: "实例运行失败",
      body: "train：失败",
    });
    expect(getImportantTaskStatusNotification({ id: 2, name: "dev", status: 8 } as Task, 2, "zh-CN")).toMatchObject({
      kind: "failure",
      event: "task.abnormal",
      title: "实例运行异常",
      body: "dev：异常",
    });
  });

  it("localizes the title, status and separator for English", () => {
    expect(getImportantTaskStatusNotification({ id: 1, task_id: "task-1", name: "train", status: 6 } as Task, 2, "en-US")).toMatchObject({
      title: "Instance succeeded",
      body: "train: Succeeded",
    });
    expect(getImportantTaskStatusNotification({ id: 1, name: "train", status: 7 } as Task, 2, "en-US")).toMatchObject({
      title: "Instance failed",
      body: "train: Failed",
    });
    expect(getImportantTaskStatusNotification({ id: 2, name: "dev", status: 8 } as Task, 2, "en-US")).toMatchObject({
      title: "Instance abnormal",
      body: "dev: Exception",
    });
  });

  it("ignores unchanged and non-terminal status updates", () => {
    expect(getImportantTaskStatusNotification({ id: 1, name: "train", status: 2 } as Task, 1, "zh-CN")).toBeNull();
    expect(getImportantTaskStatusNotification({ id: 1, name: "train", status: 6 } as Task, 6, "zh-CN")).toBeNull();
  });

  it("marks failed and abnormal tasks as needing log attention", () => {
    expect(needsLogAttention({ status: 7 })).toBe(true);
    expect(needsLogAttention({ status: 8 })).toBe(true);
    expect(needsLogAttention({ status: 2 })).toBe(false);
  });
});
