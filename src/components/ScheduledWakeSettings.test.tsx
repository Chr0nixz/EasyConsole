import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserRuntime } from "../lib/runtime";
import { ScheduledWakeSettings } from "./ScheduledWakeSettings";

afterEach(() => vi.restoreAllMocks());
describe("scheduled wake controls", () => {
  it("hides unsupported runtimes without registering anything", async () => {
    const call = vi.spyOn(browserRuntime, "desktopScheduledWake").mockResolvedValue(null);
    const view = render(<ScheduledWakeSettings />);
    await waitFor(() => expect(call).toHaveBeenCalledWith());
    expect(view.container).toBeEmptyDOMElement();
  });
  it("reflects actual OS state, reports registration failure and permits retry", async () => {
    const call = vi.spyOn(browserRuntime, "desktopScheduledWake").mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("Access denied")).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<ScheduledWakeSettings />);
    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(call.mock.calls.map((args) => args[0])).toEqual([undefined, true, true, false]);
  });
});
