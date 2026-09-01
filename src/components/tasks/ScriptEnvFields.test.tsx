import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { ScriptEnvVar } from "../../lib/script-command-env";
import { ScriptEnvFields } from "./ScriptEnvFields";

function renderFields(envVars: ScriptEnvVar[]) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(envVars);
    return (
      <ScriptEnvFields
        envVars={value}
        scriptPath="/work/run.sh"
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        expanded
      />
    );
  }
  render(<Harness />);
  return onChange;
}

describe("ScriptEnvFields", () => {
  it("stacks inputs on narrow layouts and preserves editable values", () => {
    const onChange = renderFields([{ key: "", value: "" }]);
    const keyInput = screen.getByPlaceholderText("名称，如 EXPERIMENT_ID");
    const valueInput = screen.getByPlaceholderText("值");
    const row = keyInput.closest("div.grid");

    expect(row).toHaveClass("grid-cols-1", "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]");
    expect(keyInput).toHaveClass("min-w-0", "w-full");
    expect(valueInput).toHaveClass("min-w-0", "w-full");

    fireEvent.change(keyInput, { target: { value: "EXPERIMENT_ID" } });
    fireEvent.change(valueInput, { target: { value: "exp-run" } });

    expect(onChange).toHaveBeenLastCalledWith([{ key: "EXPERIMENT_ID", value: "exp-run" }]);
  });

  it("removes only the selected environment variable row", () => {
    const onChange = renderFields([
      { key: "FIRST", value: "one" },
      { key: "SECOND", value: "two" },
    ]);

    fireEvent.click(screen.getAllByTitle("删除")[1]);

    expect(onChange).toHaveBeenCalledWith([{ key: "FIRST", value: "one" }]);
  });

  it("splits a pasted assignment into the name and value fields", () => {
    const onChange = renderFields([{ key: "", value: "" }]);
    const keyInput = screen.getByPlaceholderText("名称，如 EXPERIMENT_ID");
    const valueInput = screen.getByPlaceholderText("值");

    fireEvent.paste(keyInput, {
      clipboardData: {
        getData: () => "ACCESS_TOKEN=abc=123",
      },
    });

    expect(keyInput).toHaveValue("ACCESS_TOKEN");
    expect(valueInput).toHaveValue("abc=123");
    expect(onChange).toHaveBeenLastCalledWith([{ key: "ACCESS_TOKEN", value: "abc=123" }]);
  });
});
