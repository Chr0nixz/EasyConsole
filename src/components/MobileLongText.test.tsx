import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { ToastProvider } from "./Toast";
import { MobileLongText } from "./MobileLongText";

const longPath = "/workspace/experiments/2026/08/30/a-very-long-task-name-that-needs-to-stay-readable-on-a-narrow-phone-screen/output/checkpoints/model-final.safetensors";

function renderLongText() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <MobileLongText value={longPath} copyable mono />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("MobileLongText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("discloses a long value and copies the complete path", async () => {
    const copy = vi.spyOn(browserRuntime, "copyText").mockResolvedValue(undefined);
    renderLongText();

    const expand = screen.getByRole("button", { name: /展开|Expand/ });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(expand).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: /复制|Copy/ }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(longPath));
    expect(await screen.findByText(/已复制|Copied/)).toBeInTheDocument();
  });

  it("makes clipboard failures visible", async () => {
    vi.spyOn(browserRuntime, "copyText").mockRejectedValue(new Error("clipboard unavailable"));
    renderLongText();

    fireEvent.click(screen.getByRole("button", { name: /复制|Copy/ }));
    expect(await screen.findByText(/复制失败|Copy failed/)).toBeInTheDocument();
  });
});
