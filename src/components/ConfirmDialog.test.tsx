import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";
import { Button, Dialog, Drawer, ProgressBar } from "./ui";

describe("ProgressBar", () => {
  it("names its progress and clamps the value it reports", () => {
    const { rerender } = render(<ProgressBar label="上传进度" value={40} />);
    const bar = screen.getByRole("progressbar", { name: "上传进度" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar.firstElementChild).toHaveStyle({ transform: "translateX(-60%)" });

    rerender(<ProgressBar label="上传进度" value={140} />);
    expect(bar).toHaveAttribute("aria-valuenow", "100");

    rerender(<ProgressBar label="上传进度" value={Number.NaN} />);
    expect(bar).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("ConfirmDialog", () => {
  it("reads the consequence with the title while focus sits on cancel", () => {
    render(
      <ConfirmDialog
        options={{ title: "确认释放实例", description: "容器内的本地数据会被清理", confirmLabel: "释放", tone: "danger", run: vi.fn() }}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "确认释放实例" })).toHaveAccessibleDescription("容器内的本地数据会被清理");
  });

  it("runs confirm action and exposes cancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        options={{ title: "确认删除", description: "删除实例", confirmLabel: "删除", tone: "danger", run: vi.fn() }}
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog", () => {
  it("closes on Escape and restores focus", async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Button onClick={() => setOpen(true)}>打开按钮</Button>
          <Dialog open={open} title="示例" onClose={() => setOpen(false)}>
            <button type="button">内部按钮</button>
          </Dialog>
        </div>
      );
    }

    render(
      <DialogHarness />,
    );
    const trigger = screen.getByRole("button", { name: "打开按钮" });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("closes only the topmost of stacked dialogs on Escape", async () => {
    function StackedHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Dialog open={outerOpen} title="新建任务" onClose={() => setOuterOpen(false)}>
          <button type="button" onClick={() => setInnerOpen(true)}>选择目录</button>
          <Dialog open={innerOpen} title="选择存储目录" onClose={() => setInnerOpen(false)}>
            <button type="button">选择</button>
          </Dialog>
        </Dialog>
      );
    }

    render(<StackedHarness />);
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "选择存储目录" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "新建任务" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("leaves Escape to the input method while a composition is open", () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="输入法" onClose={onClose}>
        <input aria-label="名称" />
      </Dialog>,
    );

    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab focus inside the dialog", async () => {
    render(
      <Dialog open title="焦点测试" onClose={vi.fn()}>
        <button type="button">第一个</button>
        <button type="button">最后一个</button>
      </Dialog>,
    );

    const close = screen.getByRole("button", { name: "关闭" });
    const first = screen.getByRole("button", { name: "第一个" });
    const last = screen.getByRole("button", { name: "最后一个" });

    await waitFor(() => expect(first).toHaveFocus());

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("renders outside animated page containers so the overlay covers the viewport", () => {
    const { container } = render(
      <div className="app-page-enter" data-testid="page-shell">
        <Dialog open title="Portal" onClose={vi.fn()}>
          <button type="button">Inside</button>
        </Dialog>
      </div>,
    );

    const dialog = screen.getByRole("dialog");
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
  });

  it("keeps focus in a number input when onClose identity changes on re-render", async () => {
    function NumberFieldDialog() {
      const [value, setValue] = useState("4");
      return (
        <Dialog
          open
          title="资源配置"
          onClose={() => {
            // Unstable callback (same pattern as inline requestClose in forms).
            void value;
          }}
        >
          <label>
            CPU
            <input
              aria-label="CPU"
              type="number"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <button type="button">其他</button>
        </Dialog>
      );
    }

    render(<NumberFieldDialog />);
    const input = screen.getByLabelText("CPU");

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "8" } });
    expect(input).toHaveFocus();
    expect(input).toHaveValue(8);
  });

  it("honors autofocus over the first content button", async () => {
    render(
      <Dialog open title="自动聚焦" onClose={vi.fn()}>
        <button type="button">次要</button>
        <input aria-label="搜索" autoFocus />
      </Dialog>,
    );

    await waitFor(() => expect(screen.getByLabelText("搜索")).toHaveFocus());
  });

  it("uses the visible viewport height for a compact fullscreen dialog", () => {
    const originalMatchMedia = window.matchMedia;
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const resizeListeners = new Set<EventListener>();
    const viewport = {
      height: 512,
      offsetTop: 18,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "resize") resizeListeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "resize") resizeListeners.delete(listener);
      }),
    };

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport as unknown as VisualViewport,
    });

    try {
      const view = render(
        <Dialog open title="移动表单" mobileMode="fullscreen" onClose={vi.fn()}>
          <form className="flex h-full flex-col">
            <div className="flex-1">字段</div>
            <button type="button">创建</button>
          </form>
        </Dialog>,
      );
      const overlay = screen.getByRole("dialog");
      const panel = overlay.firstElementChild as HTMLElement;
      const content = panel.lastElementChild as HTMLElement;

      expect(overlay).toHaveStyle({ top: "18px", height: "512px" });
      expect(panel).toHaveStyle({ height: "512px", maxHeight: "512px" });
      expect(content).toHaveClass("flex-1");
      expect(content).toHaveClass("!h-auto");

      viewport.height = 368;
      act(() => {
        for (const listener of resizeListeners) listener(new Event("resize"));
      });
      expect(overlay).toHaveStyle({ height: "368px" });
      expect(panel).toHaveStyle({ height: "368px" });
      view.unmount();

      const drawerView = render(
        <Drawer open title="移动抽屉" onClose={vi.fn()}>
          <div>内容</div>
        </Drawer>,
      );
      const drawerOverlay = screen.getByRole("dialog");
      const drawerPanel = drawerOverlay.firstElementChild as HTMLElement;
      expect(drawerOverlay).toHaveStyle({ top: "18px", height: "368px" });
      expect(drawerPanel).toHaveStyle({ maxHeight: "331px" });
      drawerView.unmount();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
      if (originalVisualViewport) {
        Object.defineProperty(window, "visualViewport", originalVisualViewport);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    }
  });
});

describe("Button disabledReason", () => {
  it("stays focusable, explains itself and ignores clicks", () => {
    const onClick = vi.fn();
    render(
      <Button aria-label="打开终端" disabled disabledReason="实例已结束，无法连接" onClick={onClick}>
        终端
      </Button>,
    );

    const button = screen.getByRole("button", { name: "打开终端" });
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("实例已结束，无法连接");
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
