import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageList: vi.fn(),
  imageSystem: vi.fn(),
  createTask: vi.fn(),
  checkTaskName: vi.fn(),
  tasks: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  imageApi: {
    list: () => mocks.imageList(),
    system: () => mocks.imageSystem(),
  },
  instanceApi: {
    createTask: (...args: unknown[]) => mocks.createTask(...args),
    checkTaskName: (...args: unknown[]) => mocks.checkTaskName(...args),
    tasks: (...args: unknown[]) => mocks.tasks(...args),
  },
}));

vi.mock("../../lib/use-auth", () => ({
  useAuth: () => ({
    token: "Bearer test",
    user: { username: "tester" },
    ready: true,
    restoringSession: false,
    savedAccounts: [],
    login: vi.fn(),
    loginSaved: vi.fn(),
    forgetSavedAccount: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

vi.mock("../../lib/use-toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), notify: vi.fn() }),
}));

vi.mock("../../lib/use-run-logger", () => ({
  useRunLogger: () => ({ log: vi.fn() }),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : "error"),
}));

vi.mock("../storage/RemoteStoragePicker", () => ({
  RemoteStoragePicker: () => null,
}));

import { CreateTaskDialog } from "./CreateTaskDialog";

function renderDialog(props?: Partial<React.ComponentProps<typeof CreateTaskDialog>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <QueryClientProvider client={client}>
            <CreateTaskDialog open onClose={vi.fn()} {...props} />
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("CreateTaskDialog", () => {
  beforeEach(() => {
    mocks.imageList.mockReset();
    mocks.imageSystem.mockReset();
    mocks.createTask.mockReset();
    mocks.checkTaskName.mockReset();
    mocks.tasks.mockReset();
    mocks.imageList.mockResolvedValue({ items: [{ id: "img1", name: "ubuntu", tag: "22.04" }] });
    mocks.imageSystem.mockResolvedValue({ items: [] });
    mocks.createTask.mockResolvedValue({});
    mocks.checkTaskName.mockResolvedValue({ available: true });
    mocks.tasks.mockResolvedValue({ items: [], total: 0 });
  });

  it("renders dialog with create title", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    expect(screen.queryByText("有同名实例自动增加编号")).not.toBeInTheDocument();
    expect(screen.queryByText("资源规格")).not.toBeInTheDocument();
    expect(screen.queryByText("价格")).not.toBeInTheDocument();
  });

  it("auto-numbers colliding names via checkTaskName before create", async () => {
    // Bare true = exists (taken).
    mocks.checkTaskName.mockImplementation(async (name: string) => name === "my-task");
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    await waitFor(() => expect(mocks.imageList).toHaveBeenCalled());

    const nameInput = screen.getAllByRole("textbox")[0];
    fireEvent.change(nameInput, { target: { value: "my-task" } });
    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalled());
    expect(mocks.checkTaskName).toHaveBeenCalled();
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ name: "my-task_1" }));
  });

  it("appends a timestamp to the instance name but leaves EXPERIMENT_ID unnumbered when sync is enabled", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    await waitFor(() => expect(mocks.imageList).toHaveBeenCalled());

    fireEvent.change(screen.getByDisplayValue("手动释放"), { target: { value: "3" } });
    await waitFor(() => expect(screen.getByText("工作目录")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/实例名称与 EXPERIMENT_ID 一致/));

    const addVariable = screen.getByRole("button", { name: /添加变量/ });
    fireEvent.click(addVariable);
    const textInputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const envKey = textInputs.find((input) => input.placeholder.includes("EXPERIMENT_ID") || input.placeholder.includes("名称"));
    const envValue = textInputs.find((input) => input.placeholder === "值" || input.placeholder.toLowerCase() === "value");
    expect(envKey).toBeTruthy();
    expect(envValue).toBeTruthy();
    fireEvent.change(envKey!, { target: { value: "EXPERIMENT_ID" } });
    fireEvent.change(envValue!, { target: { value: "exp-run" } });

    const monoInputs = (screen.getAllByRole("textbox") as HTMLInputElement[]).filter((input) =>
      input.className.includes("font-mono"),
    );
    const workDirectory = monoInputs.find((input) => input.closest("div")?.textContent?.includes("工作目录")) ?? monoInputs[2];
    const scriptPath = monoInputs.find((input) => input.closest("div")?.textContent?.includes("脚本路径")) ?? monoInputs[3];
    fireEvent.change(workDirectory, { target: { value: "/work" } });
    fireEvent.change(scriptPath, { target: { value: "/work/run.sh" } });

    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalled());
    const payload = mocks.createTask.mock.calls[0]?.[0] as { name: string; script_path: string };
    expect(payload.name).toMatch(/^exp-run_\d{12}$/);
    expect(payload.script_path).toBe("EXPERIMENT_ID=exp-run /work/run.sh");
  });

  it("does not copy the source name when cloning", async () => {
    renderDialog({
      initialTask: {
        id: 9,
        name: "source-instance",
        price: 1,
        cpu: 4,
        memory: 16,
      } as never,
    });
    await waitFor(() => expect(screen.getByText("复制实例")).toBeInTheDocument());
    const nameInput = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    expect(nameInput.value).not.toBe("source-instance");
    expect(nameInput.value.length).toBeGreaterThan(0);
  });

  it("shows form error when submitting with empty name", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    await waitFor(() => expect(mocks.imageList).toHaveBeenCalled());

    const form = document.querySelector("form")!;
    const nameInput = screen.getAllByRole("textbox")[0];
    fireEvent.change(nameInput, { target: { value: "" } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getAllByText("任务名称不能为空").length).toBeGreaterThan(0));
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("shows form error when name is set but no image selected", async () => {
    mocks.imageList.mockResolvedValue({ items: [] });
    mocks.imageSystem.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());

    const form = document.querySelector("form")!;
    const nameInput = screen.getAllByRole("textbox")[0];
    fireEvent.change(nameInput, { target: { value: "my-task" } });
    fireEvent.submit(form);

    await waitFor(() => expect(screen.getAllByText("请选择镜像").length).toBeGreaterThan(0));
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("renders edit title in edit mode", async () => {
    renderDialog({ mode: "edit", editTaskId: "123" });
    await waitFor(() => expect(screen.getByText("编辑任务")).toBeInTheDocument());
  });
});
