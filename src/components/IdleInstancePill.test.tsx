import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearIdleInstances, publishIdleInstances } from "../lib/idle-instance-state";
import { IdleInstancePill } from "./IdleInstancePill";

afterEach(() => {
  cleanup();
  act(() => clearIdleInstances());
});

describe("IdleInstancePill", () => {
  it("hides idle evidence as soon as an instance stops running, before the next sample", () => {
    act(() => publishIdleInstances(new Map([["42", "heuristic"]])));
    const { rerender } = render(<IdleInstancePill task={{ id: 42, status: 2 }} />);
    expect(screen.getByText("可能闲置")).toBeInTheDocument();
    rerender(<IdleInstancePill task={{ id: 42, status: 4 }} />);
    expect(screen.queryByText("可能闲置")).not.toBeInTheDocument();
  });
});
