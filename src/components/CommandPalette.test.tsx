import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  instanceApi: {
    tasks: (...args: unknown[]) => mocks.tasks(...args),
  },
}));

import { CommandPalette } from "./CommandPalette";

function renderCommandPalette() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CommandPalette open onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    mocks.tasks.mockReset();
    mocks.tasks.mockResolvedValue({ items: [] });
  });

  it("exposes active command results with combobox and listbox semantics", async () => {
    renderCommandPalette();

    const input = screen.getByRole("combobox");
    const listbox = screen.getByRole("listbox", { name: "命令结果" });
    const options = screen.getAllByRole("option");

    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", options[1].id));
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "End" });

    const finalOptions = screen.getAllByRole("option");
    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", finalOptions.at(-1)?.id));
    expect(finalOptions.at(-1)).toHaveAttribute("aria-selected", "true");
  });
});
