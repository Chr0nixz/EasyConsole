import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

import { ErrorBoundary, ErrorFallback } from "./ErrorBoundary";

function ThrowOnRender({ message }: { message: string }): ReactNode {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <span>OK</span>
      </ErrorBoundary>,
    );

    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("renders default fallback when child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowOnRender message="boom" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("页面出现错误");
    expect(console.error).toHaveBeenCalled();
  });

  it("renders custom render-prop fallback when provided", () => {
    render(
      <ErrorBoundary fallback={(error, reset) => <button onClick={reset}>reset:{error.message}</button>}>
        <ThrowOnRender message="custom" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("reset:custom")).toBeInTheDocument();
  });

  it("renders static fallback node when provided", () => {
    render(
      <ErrorBoundary fallback={<span>static fallback</span>}>
        <ThrowOnRender message="ignored" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("static fallback")).toBeInTheDocument();
  });

  it("resets error state when reset is called", () => {
    let recovered = false;
    function RecoveringChild(): ReactNode {
      if (!recovered) throw new Error("first render fails");
      return <span>recovered</span>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <RecoveringChild />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    recovered = true;
    fireEvent.click(screen.getByText("重试"));

    rerender(
      <ErrorBoundary>
        <RecoveringChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});

describe("ErrorFallback", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("hides error details by default and toggles on click", () => {
    render(<ErrorFallback error={new Error("detailed message")} reset={() => {}} />);

    expect(screen.queryByText("detailed message")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("显示详情"));
    expect(screen.getByText("detailed message")).toBeInTheDocument();

    fireEvent.click(screen.getByText("隐藏详情"));
    expect(screen.queryByText("detailed message")).not.toBeInTheDocument();
  });

  it("hides home button when showHome is false", () => {
    render(<ErrorFallback error={new Error("err")} reset={() => {}} showHome={false} />);

    expect(screen.queryByText("返回首页")).not.toBeInTheDocument();
  });
});
