import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { guardImplicitSubmit, submitShortcut } from "./form-submit-keys";

function renderForm() {
  const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
  render(
    <form onKeyDown={guardImplicitSubmit} onSubmit={onSubmit}>
      <input aria-label="name" />
      <input aria-label="count" type="number" />
      <select aria-label="image">
        <option value="one">One</option>
      </select>
      <textarea aria-label="notes" />
      <button type="submit">Create</button>
    </form>,
  );
  return onSubmit;
}

describe("guardImplicitSubmit", () => {
  it("keeps Enter in a text field from submitting", () => {
    const onSubmit = renderForm();
    const name = screen.getByLabelText("name");
    // fireEvent does not run the browser's implicit submission, so the check is that the
    // default action was cancelled: a cancelled keydown is what stops the real browser.
    expect(fireEvent.keyDown(name, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(screen.getByLabelText("count"), { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(screen.getByLabelText("image"), { key: "Enter" })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves Enter alone in a textarea and on buttons", () => {
    renderForm();
    expect(fireEvent.keyDown(screen.getByLabelText("notes"), { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Create" }), { key: "Enter" })).toBe(true);
  });

  it("submits on Cmd or Ctrl+Enter from any field", () => {
    const onSubmit = renderForm();
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", metaKey: true });
    fireEvent.keyDown(screen.getByLabelText("notes"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("ignores Enter while an IME is composing", () => {
    const onSubmit = renderForm();
    expect(fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", isComposing: true, metaKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("names the platform's accelerator", () => {
    expect(submitShortcut(true)).toEqual({ aria: "Meta+Enter", label: "⌘ Enter" });
    expect(submitShortcut(false)).toEqual({ aria: "Control+Enter", label: "Ctrl Enter" });
  });
});
