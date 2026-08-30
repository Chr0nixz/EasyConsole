import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "./Toast";
import { useToast } from "../lib/use-toast";

function Trigger({ kind }: { kind: "success" | "error" }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => (kind === "error" ? toast.error("失败了") : toast.success("已完成"))}
    >
      notify
    </button>
  );
}

describe("ToastProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces error toasts as alerts", () => {
    render(
      <ToastProvider>
        <Trigger kind="error" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(screen.getByRole("alert")).toHaveTextContent("失败了");
  });

  it("does not dismiss while hovered", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger kind="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    const status = screen.getByRole("status");
    fireEvent.pointerEnter(status);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("已完成")).toBeInTheDocument();
    fireEvent.pointerLeave(status);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it("updates its keyboard-avoidance offset with the visual viewport", () => {
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const resizeListeners = new Set<EventListener>();
    const viewport = {
      height: window.innerHeight - 180,
      offsetTop: 0,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "resize") resizeListeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "resize") resizeListeners.delete(listener);
      }),
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport as unknown as VisualViewport,
    });

    try {
      render(
        <ToastProvider>
          <Trigger kind="success" />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "notify" }));
      const container = document.querySelector(".app-toast-container");
      expect(container).toHaveStyle({ "--app-visual-viewport-bottom-inset": "180px" });

      viewport.height = window.innerHeight - 240;
      act(() => {
        for (const listener of resizeListeners) listener(new Event("resize"));
      });
      expect(container).toHaveStyle({ "--app-visual-viewport-bottom-inset": "240px" });
    } finally {
      if (originalVisualViewport) {
        Object.defineProperty(window, "visualViewport", originalVisualViewport);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    }
  });
});
