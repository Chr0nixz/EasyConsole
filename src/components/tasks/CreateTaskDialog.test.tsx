import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageList: vi.fn(),
  imageSystem: vi.fn(),
  createTask: vi.fn(),
  checkTaskName: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  imageApi: {
    list: () => mocks.imageList(),
    system: () => mocks.imageSystem(),
  },
  instanceApi: {
    createTask: (...args: unknown[]) => mocks.createTask(...args),
    checkTaskName: (...args: unknown[]) => mocks.checkTaskName(...args),
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
    mocks.imageList.mockResolvedValue({ items: [{ id: "img1", name: "ubuntu", tag: "22.04" }] });
    mocks.imageSystem.mockResolvedValue({ items: [] });
    mocks.createTask.mockResolvedValue({});
    mocks.checkTaskName.mockResolvedValue({ available: true });
  });

  it("renders dialog with create title", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    expect(screen.getByText("有同名实例自动增加编号")).toBeInTheDocument();
  });

  it("auto-numbers colliding names before create", async () => {
    mocks.checkTaskName.mockImplementation(async (name: string) => ({ available: name !== "my-task" }));
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    await waitFor(() => expect(mocks.imageList).toHaveBeenCalled());

    const nameInput = screen.getAllByRole("textbox")[0];
    fireEvent.change(nameInput, { target: { value: "my-task" } });
    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalled());
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ name: "my-task_1" }));
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
