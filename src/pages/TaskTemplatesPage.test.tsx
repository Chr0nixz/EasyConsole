import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { makeAccountScope, resetAccountScope, setActiveAccountScope } from "../lib/account-scope";
import { setRuntimeSettings } from "../lib/app-settings";
import { BATCH_OPERATIONS_STORAGE_KEY } from "../lib/change-list";
import { I18N_STORAGE_KEY, I18nProvider } from "../lib/i18n";
import { createTaskTemplate, TASK_TEMPLATES_STORAGE_KEY } from "../lib/task-templates";
import { ApiError, type CreateTaskPayload, type TaskTemplate } from "../lib/types";
import { RunLoggerContext } from "../lib/use-run-logger";

const mocks = vi.hoisted(() => ({ createTask: vi.fn(), tasks: vi.fn(), log: vi.fn() }));

vi.mock("../lib/api", () => ({
  imageApi: {
    list: async () => ({ items: [{ id: 1, name: "test-image" }] }),
    system: async () => ({ items: [] }),
  },
  resourceApi: { resources: async () => [], prices: async () => [] },
  instanceApi: { createTask: mocks.createTask, tasks: mocks.tasks, checkTaskName: async () => false },
}));

vi.mock("../lib/use-auth", () => ({ useAuth: () => ({ user: { username: "tester" } }) }));

import { TaskTemplatesPage } from "./TaskTemplatesPage";

let client: QueryClient;

function seedTemplate(overrides: Partial<TaskTemplate> = {}) {
  const template = createTaskTemplate({
    name: "training-template", taskNamePrefix: "train", batchCount: 1, imageId: "1",
    cpu: 4, gpu: 0, memory: 16, price: 1, storagePath: "/tester", mountPath: "/home/ubuntu/tester", releaseCondition: 1,
    ...overrides,
  });
  window.localStorage.setItem(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify([template]));
  return template;
}

function storedTemplates(): TaskTemplate[] {
  return JSON.parse(window.localStorage.getItem(TASK_TEMPLATES_STORAGE_KEY) ?? "[]") as TaskTemplate[];
}

function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <RunLoggerContext.Provider value={{ log: mocks.log }}>
          <ToastProvider><TaskTemplatesPage /></ToastProvider>
        </RunLoggerContext.Provider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

async function startTemplate() {
  const region = await screen.findByRole("region", { name: /实例模板表格|Instance templates table/ });
  fireEvent.click(within(region).getByRole("button", { name: /^(新建|New)$/ }));
}

async function confirmPreview() {
  const dialog = within(await screen.findByRole("dialog", { name: /确认执行模板|Apply Template/ }));
  fireEvent.click(dialog.getByRole("button", { name: /创建.*实例|Create.*instance/ }));
}

describe("TaskTemplatesPage billable batch flows", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(I18N_STORAGE_KEY, "en-US");
    setRuntimeSettings({});
    setActiveAccountScope(makeAccountScope("tester", "Tester", "http://console.example/api"));
    mocks.createTask.mockReset().mockResolvedValue({ id: "remote-42" });
    mocks.tasks.mockReset().mockResolvedValue({ items: [], total: 0 });
    mocks.log.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    client?.clear();
    resetAccountScope();
    setRuntimeSettings({});
  });

  it("previews the account and affected instances, and cancelling creates nothing", async () => {
    seedTemplate({ batchCount: 2 });
    renderPage();
    await startTemplate();
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("tester")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: /创建 2 个实例|Create 2 instances/ })).toBeInTheDocument();
    expect(mocks.createTask).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: /取消|Cancel/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(storedTemplates()[0].usageCount).toBe(0);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("requires variable values and a second impact confirmation before submitting substituted payloads", async () => {
    seedTemplate({ taskNamePrefix: "train-${experiment}", storagePath: "/tester/${experiment}", variables: [{ key: "experiment", required: true }] });
    renderPage();
    await startTemplate();
    const variables = within(await screen.findByRole("dialog"));
    fireEvent.click(variables.getByRole("button", { name: /确认创建|Confirm Create/ }));
    expect(await variables.findByText(/以下变量为必填项|Required variables missing/)).toBeInTheDocument();
    expect(mocks.createTask).not.toHaveBeenCalled();
    fireEvent.change(variables.getByRole("textbox", { name: /experiment/ }), { target: { value: "trial-7" } });
    fireEvent.click(variables.getByRole("button", { name: /确认创建|Confirm Create/ }));
    expect(mocks.createTask).not.toHaveBeenCalled();
    await confirmPreview();
    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(1));
    expect(mocks.createTask.mock.calls[0][0]).toMatchObject({ storage_path: "/tester/trial-7" });
    expect((mocks.createTask.mock.calls[0][0] as CreateTaskPayload).name).toContain("train-trial-7");
    await waitFor(() => expect(storedTemplates()[0].usageCount).toBe(1));
  });

  it("retries only a confirmed failed subset and links the second change-list record", async () => {
    seedTemplate({ batchCount: 2 });
    mocks.createTask.mockResolvedValueOnce({ id: "remote-1" }).mockRejectedValueOnce(new ApiError("quota exceeded", { kind: "business", code: 1 })).mockResolvedValueOnce({ id: "remote-2" });
    renderPage();
    await startTemplate();
    await confirmPreview();
    const retry = await screen.findByRole("button", { name: /重试失败项|Retry failed/ });
    expect(mocks.createTask).toHaveBeenCalledTimes(2);
    const failedPayload = mocks.createTask.mock.calls[1][0] as CreateTaskPayload;
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(3));
    expect(mocks.createTask.mock.calls[2][0]).toEqual(failedPayload);
    await waitFor(() => expect(screen.getByTestId("batch-result-summary")).toHaveTextContent(/成功 2|2 succeeded/));
    const records = JSON.parse(window.localStorage.getItem(BATCH_OPERATIONS_STORAGE_KEY) ?? "[]") as { id: string; retryOf?: string }[];
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.retryOf)?.retryOf).toBe(records.find((record) => !record.retryOf)?.id);
  });

  it("does not retry an unknown create and resolves a matching remote task without another POST", async () => {
    seedTemplate();
    mocks.createTask.mockRejectedValue(new ApiError("response lost", { kind: "network" }));
    renderPage();
    await startTemplate();
    await confirmPreview();
    const verify = await screen.findByRole("button", { name: /核对未知项|Verify unknown/ });
    expect(screen.queryByRole("button", { name: /重试失败项|Retry failed/ })).not.toBeInTheDocument();
    const created = mocks.createTask.mock.calls[0][0] as CreateTaskPayload;
    mocks.tasks.mockResolvedValue({ items: [{ id: "already-created", name: created.name, status: 2, create_time: new Date().toISOString() }], total: 1 });
    fireEvent.click(verify);
    await waitFor(() => expect(screen.getByTestId("batch-result-summary")).toHaveTextContent(/成功 1|1 succeeded/));
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /重试失败项|Retry failed/ })).not.toBeInTheDocument();
  });

  it("requires confirmation before deleting a local template and never deletes remote tasks", async () => {
    seedTemplate();
    renderPage();
    const region = await screen.findByRole("region", { name: /实例模板表格|Instance templates table/ });
    fireEvent.click(within(region).getByRole("button", { name: /删除模板 training-template|Delete template training-template/ }));
    expect(storedTemplates()).toHaveLength(1);
    const dialog = within(await screen.findByRole("dialog", { name: /删除实例模板|Delete Instance Template/ }));
    fireEvent.click(dialog.getByRole("button", { name: /^(删除|Delete)$/ }));
    await waitFor(() => expect(storedTemplates()).toHaveLength(0));
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
