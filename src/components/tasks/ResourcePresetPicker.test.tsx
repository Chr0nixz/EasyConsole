import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResourcePreset } from "../../lib/types";
import { ResourcePresetPicker } from "./ResourcePresetPicker";

const presets: ResourcePreset[] = [
  { id: "p1", name: "开发机", cpu: 4, gpu: 1, memory: 16, createdAt: "2026-05-23T00:00:00.000Z", updatedAt: "2026-05-23T00:00:00.000Z" },
  { id: "p2", name: "训练机", cpu: 8, gpu: 4, memory: 64, createdAt: "2026-05-23T00:00:00.000Z", updatedAt: "2026-05-23T00:00:00.000Z" },
];

function renderPicker(props?: Partial<Parameters<typeof ResourcePresetPicker>[0]>) {
  const onApply = vi.fn();
  const onSaveCurrent = vi.fn();
  const onDelete = vi.fn();
  render(
    <ResourcePresetPicker
      presets={presets}
      onApply={onApply}
      onSaveCurrent={onSaveCurrent}
      onDelete={onDelete}
      {...props}
    />,
  );
  return { onApply, onSaveCurrent, onDelete };
}

describe("ResourcePresetPicker", () => {
  it("applies a preset when its chip is clicked", () => {
    const { onApply } = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "应用预设 开发机（4C / 1GPU / 16G）" }));

    expect(onApply).toHaveBeenCalledWith({ cpu: "4", gpu: "1", memory: "16" });
  });

  it("deletes a preset from the chip", () => {
    const { onDelete } = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "删除预设 训练机" }));

    expect(onDelete).toHaveBeenCalledWith("p2");
  });

  it("highlights the chip matching the current form values", () => {
    renderPicker({ activeSummary: "8C / 4GPU / 64G" });

    const activeChip = screen.getByRole("button", { name: "应用预设 训练机（8C / 4GPU / 64G）" }).closest("div");
    expect(activeChip).toHaveClass("border-app-accent");
    const idleChip = screen.getByRole("button", { name: "应用预设 开发机（4C / 1GPU / 16G）" }).closest("div");
    expect(idleChip).not.toHaveClass("border-app-accent");
  });

  it("suggests the default name and flags duplicate names while saving", () => {
    const { onSaveCurrent } = renderPicker({ defaultName: "4C / 0GPU / 16G" });

    fireEvent.click(screen.getByRole("button", { name: "存为预设" }));

    const input = screen.getByRole("textbox", { name: "预设名称" });
    expect(input).toHaveValue("4C / 0GPU / 16G");
    fireEvent.change(input, { target: { value: "开发机" } });
    expect(screen.getByText("同名预设将被更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新预设" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "更新预设" }));

    expect(onSaveCurrent).toHaveBeenCalledWith("开发机");
    expect(screen.queryByRole("textbox", { name: "预设名称" })).not.toBeInTheDocument();
  });

  it("submits the save form with Enter and closes it", () => {
    const { onSaveCurrent } = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "存为预设" }));
    const input = screen.getByRole("textbox", { name: "预设名称" });
    fireEvent.change(input, { target: { value: "测试机" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSaveCurrent).toHaveBeenCalledWith("测试机");
    expect(screen.queryByRole("textbox", { name: "预设名称" })).not.toBeInTheDocument();
  });

  it("keeps the submit button disabled without a name and cancels without saving", () => {
    const { onSaveCurrent } = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "存为预设" }));
    expect(screen.getByRole("button", { name: "保存预设" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onSaveCurrent).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "预设名称" })).not.toBeInTheDocument();
  });

  it("shows an empty hint when there are no presets", () => {
    renderPicker({ presets: [] });

    expect(screen.getByText("暂无预设，可保存当前资源配置")).toBeInTheDocument();
  });

  it("disables saving on request", () => {
    renderPicker({ saveDisabled: true });

    expect(screen.getByRole("button", { name: "存为预设" })).toBeDisabled();
  });
});
