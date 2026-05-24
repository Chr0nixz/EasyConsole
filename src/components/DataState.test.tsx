import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ErrorState, LoadingState, TableSkeleton } from "./DataState";

describe("DataState", () => {
  it("announces loading states as polite busy statuses", () => {
    render(<LoadingState label="Loading instances" />);

    const status = screen.getByRole("status", { name: "Loading instances" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-atomic", "true");
  });

  it("announces table skeletons as polite busy statuses", () => {
    render(<TableSkeleton />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-atomic", "true");
  });

  it("announces async errors as assertive alerts", () => {
    render(<ErrorState error={new Error("Network failed")} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Network failed");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
  });
});
