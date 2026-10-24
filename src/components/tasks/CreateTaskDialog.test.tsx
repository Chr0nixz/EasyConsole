import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageList: vi.fn(),
  imageSystem: vi.fn(),
  createTask: vi.fn(),
  checkTaskName: vi.fn(),
  tasks: vi.fn(),
  resources: vi.fn(),
  prices: vi.fn(),
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
  resourceApi: {
    resources: () => mocks.resources(),
    prices: () => mocks.prices(),
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
import { CREATE_TASK_UI_PREFS_STORAGE_KEY } from "../../lib/create-task-ui-prefs";

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
    mocks.resources.mockResolvedValue([]);
    mocks.prices.mockResolvedValue([]);
  });

  it("renders dialog with create title and a visible billing rate field", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("新建任务")).toBeInTheDocument());
    expect(screen.queryByText("有同名实例自动增加编号")).not.toBeInTheDocument();
    expect(screen.getByText("计费单价（元/小时）")).toBeInTheDocument();
  });

  it("submits the edited billing rate with the create payload", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/镜像|Image/)).toHaveValue("img1"));

    const priceInput = screen.getByLabelText(/计费单价（元\/小时）|Hourly rate/);
    fireEvent.change(priceInput, { target: { value: "2.5" } });

    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalled());
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ price: 2.5 }));
  });

  it("selects a listed default rate and submits the same value shown to the user", async () => {
    mocks.prices.mockResolvedValue([4.8, 9.6]);
    renderDialog();

    const rate = await screen.findByRole("combobox", { name: "计费单价（元/小时）" });
    await waitFor(() => expect(rate).toHaveDisplayValue("4.8"));
    expect(within(screen.getByRole("group", { name: "提交摘要" })).getByText("4.8 元/小时")).toBeInTheDocument();

    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ price: 4.8 })));
  });

  it("shows and preserves an original rate that is absent from the current list", async () => {
    mocks.prices.mockResolvedValue([4.8, 9.6]);
    renderDialog({ initialTask: { id: 9, name: "source", price: 2.5 } });

    const rate = await screen.findByRole("combobox", { name: "计费单价（元/小时）" });
    await waitFor(() => expect(rate).toHaveDisplayValue("原实例单价：2.5 元/小时"));
    expect(rate).toHaveAccessibleDescription(/此单价不在当前价格列表中/);

    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ price: 2.5 })));
  });

  it("initializes and summarizes the listed rate when resources start collapsed", async () => {
    const storedPrefs = localStorage.getItem(CREATE_TASK_UI_PREFS_STORAGE_KEY);
    localStorage.setItem(CREATE_TASK_UI_PREFS_STORAGE_KEY, JSON.stringify({ sections: { resources: false } }));
    let resolvePrices!: (value: number[]) => void;
    mocks.prices.mockReturnValue(new Promise((resolve) => { resolvePrices = resolve; }));
    try {
      renderDialog();
      await waitFor(() => expect(screen.getByRole("button", { name: /^资源配置/ })).toHaveAttribute("aria-expanded", "false"));
      await act(async () => { resolvePrices([4.8]); });
      await waitFor(() => expect(within(screen.getByRole("group", { name: "提交摘要" })).getByText("4.8 元/小时")).toBeInTheDocument());

      fireEvent.submit(document.querySelector("form")!);

      await waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ price: 4.8 })));
    } finally {
      if (storedPrefs === null) localStorage.removeItem(CREATE_TASK_UI_PREFS_STORAGE_KEY);
      else localStorage.setItem(CREATE_TASK_UI_PREFS_STORAGE_KEY, storedPrefs);
    }
  });

  it("keeps an intentionally cleared manual rate empty and blocks submission", async () => {
    renderDialog();
    const rate = screen.getByRole("spinbutton", { name: "计费单价（元/小时）" });
    await waitFor(() => expect(rate).toHaveValue(1));
    await waitFor(() => expect(screen.getByLabelText(/镜像|Image/)).toHaveValue("img1"));

    fireEvent.change(rate, { target: { value: "" } });
    fireEvent.blur(rate);
    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(rate).toHaveAttribute("aria-invalid", "true"));
    expect(rate).toHaveValue(null);
    expect(rate).toHaveAccessibleDescription("计费单价必须大于 0");
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("cancels without a discard prompt after asynchronous defaults are applied", async () => {
    mocks.prices.mockResolvedValue([4.8]);
    const onClose = vi.fn();
    renderDialog({ onClose });
    await waitFor(() => expect(screen.getByLabelText(/镜像|Image/)).toHaveValue("img1"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "计费单价（元/小时）" })).toHaveDisplayValue("4.8"));

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByText("放弃未保存的更改？")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("preserves genuine edits made before asynchronous defaults finish loading", async () => {
    let resolveImages!: (value: { items: Array<{ id: string; name: string }> }) => void;
    let resolvePrices!: (value: number[]) => void;
    mocks.imageList.mockReturnValue(new Promise((resolve) => { resolveImages = resolve; }));
    mocks.prices.mockReturnValue(new Promise((resolve) => { resolvePrices = resolve; }));
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "my-edited-task" } });
    await act(async () => {
      resolveImages({ items: [{ id: "img1", name: "ubuntu" }] });
      resolvePrices([4.8]);
    });
    await waitFor(() => expect(screen.getByLabelText(/镜像|Image/)).toHaveValue("img1"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "计费单价（元/小时）" })).toHaveDisplayValue("4.8"));

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    // The in-app discard confirm opens; keeping editing leaves the form as it was.
    expect(await screen.findByText("放弃未保存的更改？")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    const discardDialog = screen.getByRole("dialog", { name: "放弃未保存的更改？" });
    fireEvent.click(within(discardDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("放弃未保存的更改？")).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("任务名称")).toHaveValue("my-edited-task");
  });

  it("does not replace an image the user intentionally cleared", async () => {
    renderDialog();
    const image = screen.getByLabelText(/镜像|Image/);
    await waitFor(() => expect(image).toHaveValue("img1"));

    fireEvent.change(image, { target: { value: "" } });
    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(image).toHaveAttribute("aria-invalid", "true"));
    expect(image).toHaveValue("");
    expect(mocks.createTask).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByText("克隆实例")).toBeInTheDocument());
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
